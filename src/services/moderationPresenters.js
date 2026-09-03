'use strict';

const { EmbedBuilder, ChannelType } = require('discord.js');

const { BRAND } = require('../config');
const { formatDuration } = require('../utils/duration');
const { discordTime, formatExpiry, sanitize } = require('../utils/format');
const { createLogger } = require('../utils/logger');
const { missingChannelPermissions } = require('../utils/permissions');
const { actionInfo } = require('./moderationService');
const roleService = require('./roleService');

const log = createLogger('moderation:ui');

/**
 * Presentation helpers shared by every moderation command: the public
 * "Action | Case #N" embed, best-effort DMs to the target, argument helpers
 * and the authorisation shortcut every member-targeting command runs first.
 *
 * Nothing here talks to the database -- that is moderationService's job.
 */

const DEFAULT_REASON = 'No reason provided';

/** Channel types that carry a chat and can therefore be locked / slowed. */
const TEXT_LIKE_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
];

/* ------------------------------------------------------------------ *
 * Argument helpers
 * ------------------------------------------------------------------ */

/** The trimmed `reason` argument, or `null` when absent/blank. */
function reasonFrom(ctx, argName = 'reason') {
  const raw = ctx.get(argName);
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

/** Reason text safe for an embed field. */
function displayReason(reason, max = 1000) {
  return sanitize(reason || DEFAULT_REASON, max);
}

/** The `User` behind a User or GuildMember. */
function userOf(entity) {
  if (!entity) return null;
  return entity.user ?? entity;
}

/** `@mention (`id`)` plus the tag when it is known. */
function userLabel(entity) {
  const user = userOf(entity);
  if (!user) return 'Unknown user';
  const tag = user.tag ?? user.username;
  return `<@${user.id}>${tag ? ` — \`${tag}\`` : ''}\n\`${user.id}\``;
}

/**
 * Runs the hierarchy check every member-targeting command must pass.
 * Returns `{ ok, reason }` so the command can `ctx.failure(reason)`.
 */
function checkTarget(ctx, member) {
  if (!member) return { ok: false, reason: 'That member could not be found.' };
  return roleService.canActorTarget(ctx.member, member);
}

/**
 * Resolves the target channel for channel commands (lock/unlock/slowmode):
 * the `channel` argument when given, otherwise the current channel. Verifies
 * the type and that the bot holds `required` permissions in it.
 * Throws a user-facing error on any problem.
 */
function resolveTargetChannel(ctx, { argName = 'channel', required = [], allowedTypes = TEXT_LIKE_CHANNELS } = {}) {
  const channel = ctx.get(argName) ?? ctx.channel;
  if (!channel || !channel.guild) {
    throw userError('I could not resolve a channel to act on.');
  }
  if (!allowedTypes.includes(channel.type)) {
    throw userError(`${channel} is not a channel type this command can act on.`);
  }
  if (required.length > 0) {
    const missing = missingChannelPermissions(channel, required);
    if (missing.length > 0) {
      throw userError(`I am missing **${missing.join('**, **')}** in ${channel}.`);
    }
  }
  return channel;
}

function userError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

/* ------------------------------------------------------------------ *
 * Direct messages
 * ------------------------------------------------------------------ */

/**
 * Tells the target what happened, in a DM. Best effort: returns `true` when
 * delivered, `false` when the user has DMs closed / blocked the bot / the
 * send failed for any other reason. Never throws.
 */
async function notifyTarget(target, { guild, action, reason = null, durationMs = null, until = null, caseNumber = null, extra = null }) {
  const user = userOf(target);
  if (!user || user.bot) return false;
  const info = actionInfo(action);

  const lines = [`You received a **${info.label.toLowerCase()}** in **${guild.name}**.`];
  if (durationMs) lines.push(`**Duration:** ${formatDuration(durationMs)}`);
  if (until) lines.push(`**Expires:** ${discordTime(until, 'F')} (${discordTime(until, 'R')})`);
  if (extra) lines.push(extra);
  lines.push(`**Reason:** ${displayReason(reason, 800)}`);

  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${info.emoji} ${info.label}${caseNumber ? ` — Case #${caseNumber}` : ''}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${BRAND.name} • ${guild.name}` })
    .setTimestamp(new Date());

  try {
    await user.send({ embeds: [embed] });
    return true;
  } catch (error) {
    log.debug(`Could not DM ${user.id} about ${action} in ${guild.id}: ${error?.message ?? error}`);
    return false;
  }
}

/** Short footer text describing the DM outcome; `null` when no DM was attempted. */
function dmStatus(delivered) {
  if (delivered === null || delivered === undefined) return null;
  return delivered ? '📬 DM delivered' : '📪 DM not delivered (closed DMs)';
}

/* ------------------------------------------------------------------ *
 * Public reply embed
 * ------------------------------------------------------------------ */

/**
 * The compact public confirmation: "<emoji> <Action> | Case #N" with User,
 * Moderator, Duration / Expires (when relevant), any extra fields and Reason.
 */
function buildActionEmbed({
  action,
  caseRow = null,
  target = null,
  moderator,
  reason = null,
  durationMs = null,
  until = null,
  dmDelivered = null,
  fields = [],
  description = null,
}) {
  const info = actionInfo(action);
  const caseNumber = caseRow?.case_number ?? null;
  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${info.emoji} ${info.label}${caseNumber ? ` | Case #${caseNumber}` : ''}`)
    .setTimestamp(new Date(caseRow?.created_at ?? Date.now()));

  if (description) embed.setDescription(description);

  const list = [];
  if (target) list.push({ name: 'User', value: userLabel(target), inline: true });
  list.push({ name: 'Moderator', value: `<@${userOf(moderator).id}>`, inline: true });
  if (durationMs) list.push({ name: 'Duration', value: formatDuration(durationMs), inline: true });
  if (until) list.push({ name: 'Expires', value: formatExpiry(until), inline: true });
  for (const field of fields) list.push(field);
  list.push({ name: 'Reason', value: displayReason(reason) });
  embed.addFields(list);

  const footer = dmStatus(dmDelivered);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

/** Reply payload that never pings anybody, for both front-ends. */
function replyPayload(embed, extra = {}) {
  return { embeds: [embed], allowedMentions: { parse: [] }, ...extra };
}

module.exports = {
  DEFAULT_REASON,
  TEXT_LIKE_CHANNELS,
  reasonFrom,
  displayReason,
  userOf,
  userLabel,
  checkTarget,
  resolveTargetChannel,
  userError,
  notifyTarget,
  dmStatus,
  buildActionEmbed,
  replyPayload,
};
