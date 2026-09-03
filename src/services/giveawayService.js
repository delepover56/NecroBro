'use strict';

const { randomInt } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const { BRAND, COMPONENT_NAMESPACES } = require('../config');
const repository = require('../database/giveaways');
const { transaction } = require('../database/database');
const { discordTime, sanitize } = require('../utils/format');
const { createLogger } = require('../utils/logger');
const { missingChannelPermissions } = require('../utils/permissions');
const { isGone } = require('./channelService');

const log = createLogger('giveaways');

/**
 * Giveaway lifecycle: posting the message with Join/Leave buttons, persisting
 * entries, drawing winners with a cryptographically seeded shuffle, rerolls,
 * cancellation, and the scheduler job that ends overdue giveaways after a
 * restart. The database is the single source of truth; every Discord edit is
 * a best-effort re-render of the current row.
 */

class GiveawayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GiveawayError';
    this.userFacing = true;
  }
}

const { STATUS } = repository;
const NS = COMPONENT_NAMESPACES.giveaway; // gw:join:<id> / gw:leave:<id>

const TYPES = Object.freeze({
  DISCORD: { key: 'DISCORD', label: 'Discord', emoji: '💬', color: 0x5865f2 },
  SURVIVAL: { key: 'SURVIVAL', label: 'Survival', emoji: '⛏️', color: 0x3ba55d },
});

const LIMITS = Object.freeze({
  minDurationMs: 60 * 1000,
  maxDurationMs: 30 * 24 * 60 * 60 * 1000,
  minWinners: 1,
  maxWinners: 20,
  prizeMax: 200,
});

const CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

/** Discord error codes that mean "gone / no access" rather than "try again". */
const MISSING_ACCESS = 50001;
const UNKNOWN_GUILD = 10004;

function typeInfo(key) {
  return TYPES[key] ?? { key, label: String(key), emoji: '🎉', color: BRAND.accentColor };
}

function idOf(entity) {
  if (!entity) return null;
  return entity.id ?? String(entity);
}

function mentionList(ids) {
  return ids.map((id) => `<@${id}>`).join(', ');
}

/**
 * Best-effort private winner notification. A closed DM or an unavailable user
 * must never affect the already-persisted giveaway result or public announcement.
 */
async function notifyWinners(client, row, winners, { reroll = false } = {}) {
  if (!Array.isArray(winners) || winners.length === 0) return { delivered: 0, failed: 0 };

  const guild = client.guilds?.cache?.get(row.guild_id) ?? null;
  const guildName = guild?.name ?? 'the server';
  const type = typeInfo(row.type);
  const title = reroll ? 'You won a giveaway reroll!' : 'You won a giveaway!';
  const results = await Promise.all(
    winners.map(async (winnerId) => {
      try {
        const user = client.users?.cache?.get(winnerId) ?? (await client.users?.fetch?.(winnerId));
        if (!user?.send || user.bot) return false;
        const embed = new EmbedBuilder()
          .setColor(type.color)
          .setTitle(`🎉 ${title}`)
          .setDescription(
            `Congratulations — you were selected in the **${type.label}** giveaway in **${guildName}**.\n` +
              `**Prize:** ${sanitize(row.prize, LIMITS.prizeMax)}\n` +
              `**Giveaway:** #${row.id}`,
          )
          .setFooter({ text: `${BRAND.name} • Contact staff if you need to claim your prize.` })
          .setTimestamp(new Date());
        await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
        return true;
      } catch (error) {
        log.debug(`Could not DM giveaway #${row.id} winner ${winnerId}: ${error?.message ?? error}`);
        return false;
      }
    }),
  );
  const delivered = results.filter(Boolean).length;
  return { delivered, failed: results.length - delivered };
}

/** Best-effort notice for a prior winner who was displaced by a reroll. */
async function notifyRerolledOut(client, row, previousWinners, newWinners) {
  const newWinnerIds = new Set(newWinners);
  const displaced = previousWinners.filter((id) => !newWinnerIds.has(id));
  if (displaced.length === 0) return { delivered: 0, failed: 0 };

  const results = await Promise.all(displaced.map(async (userId) => {
    try {
      const user = client.users?.cache?.get(userId) ?? (await client.users?.fetch?.(userId));
      if (!user?.send || user.bot) return false;
      const embed = new EmbedBuilder()
        .setColor(BRAND.neutralColor)
        .setTitle('Giveaway rerolled')
        .setDescription(
          `The **${sanitize(row.prize, LIMITS.prizeMax)}** giveaway in **${client.guilds?.cache?.get(row.guild_id)?.name ?? 'the server'}** was rerolled, and another winner was selected.\n` +
          `**Giveaway:** #${row.id}`,
        )
        .setFooter({ text: `${BRAND.name} • Contact staff if you have questions.` })
        .setTimestamp(new Date());
      await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
      return true;
    } catch (error) {
      log.debug(`Could not DM rerolled giveaway #${row.id} prior winner ${userId}: ${error?.message ?? error}`);
      return false;
    }
  }));
  const delivered = results.filter(Boolean).length;
  return { delivered, failed: results.length - delivered };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** Embed for a giveaway row in any status. */
function buildGiveawayEmbed(row, participantCount) {
  const type = typeInfo(row.type);
  const prize = sanitize(row.prize, LIMITS.prizeMax);
  const count = participantCount ?? row.entry_count ?? 0;

  let title = `🎉 ${type.label.toUpperCase()} GIVEAWAY`;
  let color = type.color;
  const lines = [`🎁 **Prize:** ${prize}`];

  if (row.status === STATUS.ACTIVE) {
    lines.push(
      `🏆 **Winners:** ${row.winner_count}`,
      `⏰ **Ends:** ${discordTime(row.ends_at, 'R')} (${discordTime(row.ends_at, 'F')})`,
    );
  } else if (row.status === STATUS.ENDED) {
    title += ' — ENDED';
    color = 0x99aab5;
    const drawn = row.winners.length;
    const winners =
      drawn > 0
        ? `${mentionList(row.winners)}${drawn < row.winner_count ? ` (${drawn}/${row.winner_count} drawn)` : ''}`
        : 'Not enough participants';
    lines.push(`🏆 **Winner${row.winner_count === 1 ? '' : 's'}:** ${winners}`);
    if (row.reroll_count > 0) lines.push(`🔁 **Rerolled:** ${row.reroll_count}×`);
    if (row.ended_at) lines.push(`⏰ **Ended:** ${discordTime(row.ended_at, 'R')} (${discordTime(row.ended_at, 'F')})`);
  } else {
    title += ' — CANCELLED';
    color = BRAND.dangerColor;
    lines.push(`🏆 **Winners:** ${row.winner_count}`);
    lines.push(`❌ **Cancelled:** ${row.ended_at ? discordTime(row.ended_at, 'R') : 'no winners were drawn'}`);
  }

  lines.push(`👤 **Hosted by:** <@${row.creator_id}>`, '', `👥 **Participants:** ${count}`);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setFooter({
      text:
        row.status === STATUS.ACTIVE
          ? `Giveaway #${row.id} • ${BRAND.name} • Press 🎉 Join Giveaway to enter`
          : `Giveaway #${row.id} • ${BRAND.name}`,
    });
}

/** Join / Leave buttons; disabled once the giveaway is no longer running. */
function buildGiveawayComponents(row) {
  const locked = row.status !== STATUS.ACTIVE;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${NS}:join:${row.id}`)
        .setLabel('Join Giveaway')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Success)
        .setDisabled(locked),
      new ButtonBuilder()
        .setCustomId(`${NS}:leave:${row.id}`)
        .setLabel('Leave Giveaway')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(locked),
    ),
  ];
}

function buildMessagePayload(row, participantCount) {
  return {
    embeds: [buildGiveawayEmbed(row, participantCount)],
    components: buildGiveawayComponents(row),
    allowedMentions: { parse: [] },
  };
}

function jumpLine(row, message) {
  return message?.url ? `-# Giveaway #${row.id} · [Jump to giveaway](${message.url})` : `-# Giveaway #${row.id}`;
}

/** Winner announcement posted below the giveaway. */
function buildAnnouncement(row, winners, message, { reroll = false } = {}) {
  const prize = sanitize(row.prize, LIMITS.prizeMax);
  if (winners.length === 0) {
    return {
      content:
        `😔 **Giveaway #${row.id} ended with no winner.** Not enough participants entered for **${prize}**.\n` +
        jumpLine(row, message),
      allowedMentions: { parse: [] },
    };
  }

  const plural = winners.length === 1 ? '' : 's';
  const lines = [];
  if (reroll) {
    lines.push(`🔁 **Giveaway #${row.id} rerolled!** New winner${plural}: ${mentionList(winners)} — you won **${prize}**!`);
  } else {
    lines.push(`🎉 **Congratulations ${mentionList(winners)}!** You won **${prize}**!`);
    if (winners.length < row.winner_count) {
      lines.push(`-# Only ${winners.length} of ${row.winner_count} winners could be drawn — not enough participants.`);
    }
  }
  lines.push(jumpLine(row, message));
  return { content: lines.join('\n'), allowedMentions: { parse: [], users: winners } };
}

/* ------------------------------------------------------------------ *
 * Winner selection
 * ------------------------------------------------------------------ */

/** Fisher-Yates shuffle driven by node:crypto. */
function shuffle(list) {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Draws up to `count` unique winners from `entries`. Entrants in `exclude`
 * (previous winners) are only used to top up when there are not enough fresh
 * entrants left, so a reroll prefers people who have never won.
 */
function pickWinners(entries, count, exclude = []) {
  const unique = [...new Set(entries)];
  const excluded = new Set(exclude);
  const wanted = Math.max(0, Math.min(count, unique.length));
  const fresh = shuffle(unique.filter((id) => !excluded.has(id)));
  if (fresh.length >= wanted) return fresh.slice(0, wanted);
  const fallback = shuffle(unique.filter((id) => excluded.has(id)));
  return [...fresh, ...fallback].slice(0, wanted);
}

/** Every user who has ever been drawn for this giveaway (initial draw + rerolls). */
function previousWinners(row) {
  const ids = new Set(row.winners);
  for (const entry of row.audit) {
    if ((entry?.kind === 'END' || entry?.kind === 'REROLL') && Array.isArray(entry.winners)) {
      for (const id of entry.winners) ids.add(String(id));
    }
  }
  return [...ids];
}

/* ------------------------------------------------------------------ *
 * Discord lookups
 * ------------------------------------------------------------------ */

function isAccessGone(error) {
  return isGone(error) || error?.code === MISSING_ACCESS || error?.code === UNKNOWN_GUILD;
}

/**
 * Resolves the guild, channel and message of a giveaway.
 * `gone` names the first thing that no longer exists ('guild' | 'channel' |
 * 'message'); `transient` means Discord failed for a reason that may clear up.
 */
async function resolveMessage(client, row) {
  const result = { guild: null, channel: null, message: null, gone: null, transient: false };

  result.guild = client.guilds.cache.get(row.guild_id) ?? null;
  if (!result.guild) {
    try {
      result.guild = await client.guilds.fetch(row.guild_id);
    } catch (error) {
      if (isAccessGone(error)) result.gone = 'guild';
      else result.transient = true;
      return result;
    }
  }

  result.channel = result.guild.channels.cache.get(row.channel_id) ?? null;
  if (!result.channel) {
    try {
      result.channel = await result.guild.channels.fetch(row.channel_id);
    } catch (error) {
      if (isAccessGone(error)) result.gone = 'channel';
      else result.transient = true;
      return result;
    }
  }
  if (!result.channel?.isTextBased?.()) {
    result.channel = null;
    result.gone = 'channel';
    return result;
  }

  if (!row.message_id) {
    result.gone = 'message';
    return result;
  }
  try {
    result.message = await result.channel.messages.fetch(row.message_id);
  } catch (error) {
    if (isAccessGone(error)) result.gone = 'message';
    else result.transient = true;
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Message refresh (serialised per giveaway)
 * ------------------------------------------------------------------ */

const refreshQueue = new Map(); // giveaway id -> { promise, dirty, hint }

async function renderCurrent(client, giveawayId, hint) {
  const row = repository.getGiveaway(giveawayId);
  if (!row || !row.message_id) return false;

  let message = hint && hint.id === row.message_id ? hint : null;
  if (!message) {
    const resolved = await resolveMessage(client, row);
    message = resolved.message;
  }
  if (!message) return false;

  await message.edit(buildMessagePayload(row, row.entry_count));
  return true;
}

/**
 * Re-renders the giveaway message from the database. Calls for the same
 * giveaway are chained: while one edit is in flight further calls only mark
 * the giveaway dirty, and a single follow-up edit renders the latest state.
 * Never rejects.
 */
function refreshMessage(client, giveawayId, messageHint = null) {
  const existing = refreshQueue.get(giveawayId);
  if (existing) {
    existing.dirty = true;
    if (messageHint) existing.hint = messageHint;
    return existing.promise;
  }

  const entry = { dirty: false, hint: messageHint, promise: null };
  entry.promise = (async () => {
    try {
      do {
        entry.dirty = false;
        try {
          await renderCurrent(client, giveawayId, entry.hint);
        } catch (error) {
          if (!isGone(error)) log.warn(`Could not refresh giveaway #${giveawayId} message:`, error);
        }
      } while (entry.dirty);
    } finally {
      refreshQueue.delete(giveawayId);
    }
  })();
  refreshQueue.set(giveawayId, entry);
  return entry.promise;
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

function validateCreateInput({ type, prize, winnerCount, durationMs }) {
  if (!TYPES[type]) {
    throw new GiveawayError(`Unknown giveaway type. Choose ${Object.values(TYPES).map((t) => `\`${t.label}\``).join(' or ')}.`);
  }
  const cleanPrize = String(prize ?? '').trim();
  if (!cleanPrize) throw new GiveawayError('The prize cannot be empty.');
  if (cleanPrize.length > LIMITS.prizeMax) {
    throw new GiveawayError(`The prize must be ${LIMITS.prizeMax} characters or fewer.`);
  }
  if (!Number.isInteger(winnerCount) || winnerCount < LIMITS.minWinners || winnerCount > LIMITS.maxWinners) {
    throw new GiveawayError(`The number of winners must be between ${LIMITS.minWinners} and ${LIMITS.maxWinners}.`);
  }
  if (!Number.isFinite(durationMs) || durationMs < LIMITS.minDurationMs || durationMs > LIMITS.maxDurationMs) {
    throw new GiveawayError('The duration must be between **1 minute** and **30 days** (e.g. `30m`, `12h`, `3d`).');
  }
  return cleanPrize;
}

/**
 * Creates the row, posts the giveaway message and stores its ID.
 * If posting fails the row is removed again so no orphan can ever end.
 */
async function createGiveaway({ guild, channel, creator, type, prize, winnerCount, durationMs }) {
  const cleanPrize = validateCreateInput({ type, prize, winnerCount, durationMs });

  if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
    throw new GiveawayError('Giveaways can only be posted in a text channel of this server.');
  }
  const missing = missingChannelPermissions(channel, CHANNEL_PERMISSIONS);
  if (missing.length > 0) {
    throw new GiveawayError(`I am missing **${missing.join('**, **')}** in ${channel}.`);
  }

  const creatorId = idOf(creator);
  const row = repository.createGiveaway({
    guildId: guild.id,
    channelId: channel.id,
    type,
    prize: cleanPrize,
    winnerCount,
    creatorId,
    endsAt: Date.now() + durationMs,
  });

  let message;
  try {
    message = await channel.send(buildMessagePayload(row, 0));
  } catch (error) {
    repository.deleteGiveaway(row.id);
    log.warn(`Could not post giveaway in channel ${channel.id} (guild ${guild.id}); row discarded.`, error);
    throw error;
  }
  repository.setMessageId(row.id, message.id);

  log.info(
    `[${guild.id}] Giveaway #${row.id} created by ${creatorId}: type=${type} prize="${sanitize(cleanPrize, 60)}" ` +
      `winners=${winnerCount} ends=${new Date(row.ends_at).toISOString()} channel=${channel.id} message=${message.id}`,
  );

  return { giveaway: repository.getGiveaway(row.id), message };
}

/* ------------------------------------------------------------------ *
 * Participation
 * ------------------------------------------------------------------ */

function participationRow(giveawayId, guildId) {
  const row = repository.getGiveaway(giveawayId);
  if (!row || (guildId && row.guild_id !== guildId)) {
    return { row: null, error: 'That giveaway no longer exists.' };
  }
  if (row.status !== STATUS.ACTIVE || row.ends_at <= Date.now()) {
    return { row, error: 'This giveaway has ended.' };
  }
  return { row, error: null };
}

/** Enters a user. Returns `{ ok, changed, message, row, count }`; never throws for user mistakes. */
function joinGiveaway({ giveawayId, guildId = null, userId }) {
  return transaction(() => {
    const { row, error } = participationRow(giveawayId, guildId);
    if (error) return { ok: false, changed: false, message: error, row, count: row?.entry_count ?? 0 };

    const added = repository.addEntry(row.id, userId);
    const count = repository.countEntries(row.id);
    if (!added) {
      return { ok: false, changed: false, message: 'You are already entered in this giveaway.', row, count };
    }
    log.debug(`[${row.guild_id}] ${userId} joined giveaway #${row.id} (${count} entries).`);
    return {
      ok: true,
      changed: true,
      message: `You are in! Good luck winning **${sanitize(row.prize, 100)}** 🍀`,
      row,
      count,
    };
  });
}

/** Withdraws a user. Same return shape as `joinGiveaway`. */
function leaveGiveaway({ giveawayId, guildId = null, userId }) {
  return transaction(() => {
    const { row, error } = participationRow(giveawayId, guildId);
    if (error) return { ok: false, changed: false, message: error, row, count: row?.entry_count ?? 0 };

    const removed = repository.removeEntry(row.id, userId);
    const count = repository.countEntries(row.id);
    if (!removed) {
      return { ok: false, changed: false, message: 'You are not entered in this giveaway.', row, count };
    }
    log.debug(`[${row.guild_id}] ${userId} left giveaway #${row.id} (${count} entries).`);
    return { ok: true, changed: true, message: 'You have left the giveaway.', row, count };
  });
}

/* ------------------------------------------------------------------ *
 * Ending / cancelling / rerolling
 * ------------------------------------------------------------------ */

function requireGiveaway(giveawayId, guildId = null) {
  const row = guildId ? repository.getGiveawayInGuild(guildId, giveawayId) : repository.getGiveaway(giveawayId);
  if (!row) throw new GiveawayError(`Giveaway **#${giveawayId}** does not exist in this server.`);
  return row;
}

/** Atomic ACTIVE -> CANCELLED. Returns the updated row or null if it was not active. */
function cancelRow(giveawayId, { by, note }) {
  return transaction(() => {
    const row = repository.getGiveaway(giveawayId);
    if (!row || row.status !== STATUS.ACTIVE) return null;
    const participants = repository.listEntries(row.id);
    return repository.cancel(row.id, {
      kind: 'CANCEL',
      at: Date.now(),
      participantCount: participants.length,
      participants,
      winners: [],
      by: by ?? 'system',
      note: note ?? null,
    });
  });
}

/** Atomic ACTIVE -> ENDED with a fresh draw. Returns null when it was not active. */
function finishRow(giveawayId, { by }) {
  return transaction(() => {
    const row = repository.getGiveaway(giveawayId);
    if (!row || row.status !== STATUS.ACTIVE) return null;
    const participants = repository.listEntries(row.id);
    const winners = pickWinners(participants, row.winner_count);
    const now = Date.now();
    const updated = repository.finish(row.id, {
      winners,
      endedAt: now,
      auditEntry: {
        kind: 'END',
        at: now,
        participantCount: participants.length,
        participants,
        winners,
        by: by ?? 'system',
      },
    });
    return updated ? { row: updated, winners, participants } : null;
  });
}

/**
 * Ends a giveaway: draws winners, updates the message, announces.
 * Resolves to `{ outcome: 'ended', row, winners, participantCount, announced }`
 * or `{ outcome: 'cancelled', row, reason }` when its message was gone.
 * Throws `GiveawayError` when it is not active or Discord is unreachable.
 */
async function endGiveaway({ client, giveawayId, guildId = null, by = null, resolved = null }) {
  const row = requireGiveaway(giveawayId, guildId);
  if (row.status === STATUS.ENDED) throw new GiveawayError(`Giveaway **#${row.id}** has already ended.`);
  if (row.status === STATUS.CANCELLED) throw new GiveawayError(`Giveaway **#${row.id}** was cancelled.`);

  const target = resolved ?? (await resolveMessage(client, row));
  if (target.transient) {
    throw new GiveawayError('Discord did not respond while looking up the giveaway message. Try again in a moment.');
  }
  if (target.gone) {
    const note = `${target.gone} missing when the giveaway was ended`;
    const cancelled = cancelRow(row.id, { by, note });
    if (!cancelled) throw new GiveawayError(`Giveaway **#${row.id}** is no longer active.`);
    log.warn(`[${row.guild_id}] Giveaway #${row.id} cancelled: ${note}.`);
    return { outcome: 'cancelled', row: cancelled, reason: target.gone };
  }

  const result = finishRow(row.id, { by });
  if (!result) throw new GiveawayError(`Giveaway **#${row.id}** is no longer active.`);
  const { winners, participants } = result;

  log.info(
    `[${row.guild_id}] Giveaway #${row.id} ended by ${by ?? 'scheduler'}: ` +
      `${participants.length} participant(s), winners=[${winners.join(', ')}]`,
  );

  try {
    await target.message.edit(buildMessagePayload(result.row, participants.length));
  } catch (error) {
    log.warn(`Could not edit ended giveaway #${row.id} message:`, error);
  }

  let announced = false;
  try {
    await target.channel.send(buildAnnouncement(result.row, winners, target.message));
    announced = true;
  } catch (error) {
    log.warn(`Could not announce giveaway #${row.id} winners:`, error);
  }

  const winnerDms = await notifyWinners(client, result.row, winners);

  return { outcome: 'ended', row: result.row, winners, participantCount: participants.length, announced, winnerDms };
}

/** Cancels an active giveaway (no winners) and marks the message. */
async function cancelGiveaway({ client, giveawayId, guildId = null, by = null, note = 'cancelled by staff' }) {
  const row = requireGiveaway(giveawayId, guildId);
  if (row.status !== STATUS.ACTIVE) {
    throw new GiveawayError(
      `Giveaway **#${row.id}** ${row.status === STATUS.ENDED ? 'has already ended' : 'was already cancelled'}.`,
    );
  }

  const cancelled = cancelRow(row.id, { by, note });
  if (!cancelled) throw new GiveawayError(`Giveaway **#${row.id}** is no longer active.`);
  log.info(`[${row.guild_id}] Giveaway #${row.id} cancelled by ${by ?? 'system'} (${note}).`);

  const target = await resolveMessage(client, cancelled);
  if (target.message) {
    try {
      await target.message.edit(buildMessagePayload(cancelled, cancelled.entry_count));
    } catch (error) {
      log.warn(`Could not edit cancelled giveaway #${row.id} message:`, error);
    }
  }
  return { row: cancelled, messageUpdated: Boolean(target.message) };
}

/**
 * Draws `count` new winners for an ended giveaway, avoiding everyone drawn
 * before when enough other participants exist. Edits the message and announces.
 */
async function rerollGiveaway({ client, giveawayId, guildId = null, by = null, count = 1 }) {
  const row = requireGiveaway(giveawayId, guildId);
  const previousWinnerIds = [...row.winners];
  if (row.status === STATUS.ACTIVE) {
    throw new GiveawayError(`Giveaway **#${row.id}** is still running. End it first with \`giveaway end ${row.id}\`.`);
  }
  if (row.status === STATUS.CANCELLED) throw new GiveawayError(`Giveaway **#${row.id}** was cancelled, so it cannot be rerolled.`);
  if (!Number.isInteger(count) || count < LIMITS.minWinners || count > LIMITS.maxWinners) {
    throw new GiveawayError(`You can reroll between ${LIMITS.minWinners} and ${LIMITS.maxWinners} winners.`);
  }

  const result = transaction(() => {
    const current = repository.getGiveaway(row.id);
    if (!current || current.status !== STATUS.ENDED) return null;
    const participants = repository.listEntries(current.id);
    if (participants.length === 0) {
      throw new GiveawayError(`Nobody entered giveaway **#${current.id}**, so there is nothing to reroll.`);
    }
    const winners = pickWinners(participants, count, previousWinners(current));
    const updated = repository.reroll(current.id, {
      winners,
      auditEntry: {
        kind: 'REROLL',
        at: Date.now(),
        participantCount: participants.length,
        participants,
        winners,
        by: by ?? 'system',
      },
    });
    return updated ? { row: updated, winners, participants } : null;
  });
  if (!result) throw new GiveawayError(`Giveaway **#${row.id}** could not be rerolled right now.`);

  log.info(
    `[${row.guild_id}] Giveaway #${row.id} rerolled by ${by ?? 'system'} (reroll #${result.row.reroll_count}): ` +
      `winners=[${result.winners.join(', ')}]`,
  );

  const target = await resolveMessage(client, result.row);
  if (target.message) {
    try {
      await target.message.edit(buildMessagePayload(result.row, result.participants.length));
    } catch (error) {
      log.warn(`Could not edit rerolled giveaway #${row.id} message:`, error);
    }
  }
  let announced = false;
  if (target.channel) {
    try {
      await target.channel.send(buildAnnouncement(result.row, result.winners, target.message, { reroll: true }));
      announced = true;
    } catch (error) {
      log.warn(`Could not announce reroll for giveaway #${row.id}:`, error);
    }
  }

  const winnerDms = await notifyWinners(client, result.row, result.winners, { reroll: true });
  const displacedDms = await notifyRerolledOut(client, result.row, previousWinnerIds, result.winners);

  return { row: result.row, winners: result.winners, participantCount: result.participants.length, announced, winnerDms, displacedDms };
}

/* ------------------------------------------------------------------ *
 * Scheduler + gateway hooks
 * ------------------------------------------------------------------ */

/** Scheduler job: ends every giveaway whose time is up. Safe to run every tick. */
async function processDueGiveaways(client) {
  const due = repository.listDue(Date.now());
  let ended = 0;
  for (const row of due) {
    try {
      const resolved = await resolveMessage(client, row);
      if (resolved.transient) {
        log.warn(`Giveaway #${row.id} is due but Discord is unavailable; will retry next tick.`);
        continue;
      }
      const result = await endGiveaway({ client, giveawayId: row.id, by: null, resolved });
      if (result.outcome === 'ended') ended += 1;
    } catch (error) {
      if (error instanceof GiveawayError) log.warn(`Skipped due giveaway #${row.id}: ${error.message}`);
      else log.error(`Failed to end due giveaway #${row.id}:`, error);
    }
  }
  return ended;
}

/** Gateway hook: a deleted giveaway message cancels its active giveaway. Synchronous. */
function handleMessageDelete(message) {
  const row = repository.getGiveawayByMessage(message?.id);
  if (!row || row.status !== STATUS.ACTIVE) return null;
  const cancelled = cancelRow(row.id, { by: 'system', note: 'message deleted' });
  if (cancelled) log.warn(`[${row.guild_id}] Giveaway #${row.id} cancelled: its message was deleted.`);
  return cancelled;
}

/** Gateway hook: a deleted channel cancels every active giveaway inside it. Synchronous. */
function handleChannelDelete(channel) {
  const rows = repository.listActiveInChannel(channel?.id);
  const cancelled = [];
  for (const row of rows) {
    const updated = cancelRow(row.id, { by: 'system', note: 'channel deleted' });
    if (updated) cancelled.push(updated);
  }
  if (cancelled.length > 0) {
    log.warn(
      `[${channel.guild?.id ?? '?'}] Channel ${channel.id} was deleted; cancelled giveaway(s) ` +
        cancelled.map((row) => `#${row.id}`).join(', '),
    );
  }
  return cancelled;
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

function listActive(guildId) {
  return repository.listActive(guildId);
}

function getGiveaway(guildId, giveawayId) {
  return repository.getGiveawayInGuild(guildId, giveawayId);
}

module.exports = {
  GiveawayError,
  TYPES,
  LIMITS,
  STATUS,
  typeInfo,
  buildGiveawayEmbed,
  buildGiveawayComponents,
  buildMessagePayload,
  buildAnnouncement,
  notifyWinners,
  notifyRerolledOut,
  pickWinners,
  previousWinners,
  createGiveaway,
  joinGiveaway,
  leaveGiveaway,
  refreshMessage,
  endGiveaway,
  cancelGiveaway,
  rerollGiveaway,
  processDueGiveaways,
  handleMessageDelete,
  handleChannelDelete,
  listActive,
  getGiveaway,
};
