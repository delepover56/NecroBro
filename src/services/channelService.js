'use strict';

const { ChannelType, PermissionFlagsBits, OverwriteType } = require('discord.js');

const { BRAND, CHANNEL_NAMES } = require('../config');
const configRepository = require('../database/config');
const { createLogger } = require('../utils/logger');
const { resolveStaffRoles } = require('../utils/permissions');
const {
  buildLogEmbed,
  buildPanelComponents,
  buildPanelEmbed,
  buildTempChannelComponents,
  buildTempChannelEmbed,
} = require('../utils/embeds');

const log = createLogger('channels');

/** Discord error codes we treat as "already gone / not our problem". */
const GONE = new Set([
  10003, // Unknown Channel
  10008, // Unknown Message
]);

function isGone(error) {
  return GONE.has(error?.code);
}

/** Fetches a channel by ID, returning `null` instead of throwing when missing. */
async function fetchChannel(guild, channelId) {
  if (!channelId) return null;
  try {
    return await guild.channels.fetch(channelId);
  } catch (error) {
    if (isGone(error)) return null;
    log.warn(`Failed to fetch channel ${channelId} in guild ${guild.id}:`, error);
    return null;
  }
}

/** Turns a username into a valid, predictable channel name fragment. */
function slugify(input) {
  const slug = String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return slug || 'member';
}

/* ------------------------------------------------------------------ *
 * Permission overwrite templates
 * ------------------------------------------------------------------ */

/** Hidden category: only staff and the bot can see it. */
function categoryOverwrites(guild, staffRoleIds) {
  const botId = guild.members.me.id;
  return [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: botId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    ...staffRoleIds.map((roleId) => ({
      id: roleId,
      type: OverwriteType.Role,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];
}

/** Public system channels: readable by everyone, writable only by the bot. */
function readOnlyOverwrites(guild) {
  const botId = guild.members.me.id;
  return [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.AddReactions,
      ],
    },
    {
      id: botId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];
}

/** A member's private draft channel. */
function tempChannelOverwrites(guild, userId, staffRoleIds) {
  const botId = guild.members.me.id;
  return [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: userId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: botId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    ...staffRoleIds.map((roleId) => ({
      id: roleId,
      type: OverwriteType.Role,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];
}

/* ------------------------------------------------------------------ *
 * Setup (idempotent)
 * ------------------------------------------------------------------ */

/**
 * Ensures the hidden submission category exists and has correct permissions.
 * Reuses the stored category when it still exists -- never creates a duplicate.
 */
async function ensureCategory(guild, config, staffRoleIds) {
  const existing = await fetchChannel(guild, config.submission_category_id);

  if (existing && existing.type === ChannelType.GuildCategory) {
    await existing.permissionOverwrites.set(
      categoryOverwrites(guild, staffRoleIds),
      'Nekro Land suggestion system setup',
    );
    return { channel: existing, created: false };
  }

  const created = await guild.channels.create({
    name: CHANNEL_NAMES.category,
    type: ChannelType.GuildCategory,
    permissionOverwrites: categoryOverwrites(guild, staffRoleIds),
    reason: 'Nekro Land suggestion system setup',
  });

  return { channel: created, created: true };
}

/**
 * Ensures a public, read-only system text channel exists.
 * `preferred` is an admin-supplied channel that wins over the stored ID.
 */
async function ensureSystemChannel(guild, { storedId, preferred, defaultName }) {
  const target =
    (preferred?.type === ChannelType.GuildText ? preferred : null) ??
    (await fetchChannel(guild, storedId));

  if (target && target.type === ChannelType.GuildText) {
    await target.permissionOverwrites.set(
      readOnlyOverwrites(guild),
      'Nekro Land suggestion system setup',
    );
    return { channel: target, created: false };
  }

  const created = await guild.channels.create({
    name: defaultName,
    type: ChannelType.GuildText,
    permissionOverwrites: readOnlyOverwrites(guild),
    reason: 'Nekro Land suggestion system setup',
  });

  return { channel: created, created: true };
}

/**
 * Posts the permanent panel, or edits the existing one in place.
 * Guarantees at most one panel per guild.
 */
async function ensurePanel(channel, config) {
  const embeds = [buildPanelEmbed()];
  const components = buildPanelComponents();

  if (config.panel_message_id) {
    try {
      const existing = await channel.messages.fetch(config.panel_message_id);
      await existing.edit({ embeds, components });
      return { message: existing, created: false };
    } catch (error) {
      if (!isGone(error)) {
        log.warn(`Could not reuse panel message ${config.panel_message_id}:`, error);
      }
    }
  }

  const message = await channel.send({ embeds, components });
  return { message, created: true };
}

/**
 * Runs the full, repeatable setup and persists every resulting ID.
 * Returns a report the command turns into a summary embed.
 */
async function setupGuild(guild, options = {}) {
  const config = configRepository.ensureGuildConfig(guild.id);
  const staffRoleIds =
    options.staffRoleIds && options.staffRoleIds.length > 0
      ? [...new Set(options.staffRoleIds)]
      : resolveStaffRoles(guild, config);

  const category = await ensureCategory(guild, config, staffRoleIds);

  const intake = await ensureSystemChannel(guild, {
    storedId: config.suggestions_channel_id,
    preferred: options.suggestionsChannel,
    defaultName: CHANNEL_NAMES.intake,
  });

  const voting = await ensureSystemChannel(guild, {
    storedId: config.voting_channel_id,
    preferred: options.votingChannel,
    defaultName: CHANNEL_NAMES.voting,
  });

  const staffLog =
    options.staffLogChannel ?? (await fetchChannel(guild, config.staff_log_channel_id));

  const panel = await ensurePanel(intake.channel, config);

  const saved = configRepository.updateGuildConfig(guild.id, {
    submission_category_id: category.channel.id,
    suggestions_channel_id: intake.channel.id,
    voting_channel_id: voting.channel.id,
    staff_log_channel_id: staffLog?.id ?? null,
    panel_message_id: panel.message.id,
    staffRoleIds,
  });

  log.info(
    `Setup complete for guild ${guild.id}: ` +
      `category=${category.channel.id} intake=${intake.channel.id} voting=${voting.channel.id}`,
  );

  return { config: saved, category, intake, voting, staffLog, panel, staffRoleIds };
}

/* ------------------------------------------------------------------ *
 * Temporary submission channels
 * ------------------------------------------------------------------ */

/**
 * Creates a private draft channel for a member.
 * Duplicate names are resolved by appending a short suffix from the user ID.
 */
async function createTempChannel(guild, member, config) {
  const staffRoleIds = resolveStaffRoles(guild, config);
  const base = `suggestion-${slugify(member.user.username)}`;
  const taken = guild.channels.cache.some(
    (channel) => channel.parentId === config.submission_category_id && channel.name === base,
  );
  const name = (taken ? `${base}-${member.id.slice(-4)}` : base).slice(0, 100);

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: config.submission_category_id ?? undefined,
    topic: `Suggestion draft for ${member.user.tag} (${member.id})`,
    permissionOverwrites: tempChannelOverwrites(guild, member.id, staffRoleIds),
    reason: `Suggestion draft requested by ${member.user.tag}`,
  });

  configRepository.createTempChannel({
    channelId: channel.id,
    guildId: guild.id,
    userId: member.id,
  });

  await channel.send({
    content: `<@${member.id}>`,
    embeds: [buildTempChannelEmbed(member.user)],
    components: buildTempChannelComponents(),
  });

  log.info(`Created temp channel ${channel.id} (${name}) for ${member.id} in guild ${guild.id}.`);
  return channel;
}

/** Deletes a temporary channel and forgets it. Tolerates an already-deleted channel. */
async function deleteTempChannel(guild, channelId, reason = 'Suggestion draft closed') {
  configRepository.deleteTempChannel(channelId);
  try {
    const channel = await fetchChannel(guild, channelId);
    if (channel) await channel.delete(reason);
    return true;
  } catch (error) {
    if (isGone(error)) return true;
    log.warn(`Failed to delete temp channel ${channelId}:`, error);
    return false;
  }
}

/**
 * Reconciles recorded draft channels with reality after a restart:
 * channels that vanished while the bot was offline are dropped from the
 * database so their owners can open a fresh draft.
 */
async function recoverTempChannels(guild) {
  const rows = configRepository.listTempChannels(guild.id);
  let recovered = 0;
  let pruned = 0;

  for (const row of rows) {
    const channel = await fetchChannel(guild, row.channel_id);
    if (!channel) {
      configRepository.deleteTempChannel(row.channel_id);
      pruned += 1;
      continue;
    }
    recovered += 1;
  }

  if (rows.length > 0) {
    log.info(
      `Recovered ${recovered} open suggestion draft(s) in guild ${guild.id}` +
        (pruned > 0 ? `, pruned ${pruned} stale record(s).` : '.'),
    );
  }

  return { recovered, pruned };
}

/* ------------------------------------------------------------------ *
 * Staff log
 * ------------------------------------------------------------------ */

/** Best-effort staff log write. Never throws into the caller. */
async function sendStaffLog(guild, payload) {
  const config = configRepository.getGuildConfig(guild.id);
  if (!config?.staff_log_channel_id) return;

  const channel = await fetchChannel(guild, config.staff_log_channel_id);
  if (!channel?.isTextBased()) {
    log.warn(`Staff log channel ${config.staff_log_channel_id} is unavailable; clearing it.`);
    configRepository.updateGuildConfig(guild.id, { staff_log_channel_id: null });
    return;
  }

  try {
    await channel.send({ embeds: [buildLogEmbed({ color: BRAND.neutralColor, ...payload })] });
  } catch (error) {
    log.warn(`Failed to write staff log in guild ${guild.id}:`, error);
  }
}

module.exports = {
  fetchChannel,
  slugify,
  isGone,
  setupGuild,
  ensurePanel,
  createTempChannel,
  deleteTempChannel,
  recoverTempChannels,
  sendStaffLog,
};
