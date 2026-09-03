'use strict';

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const { BRAND, ROLE_TYPES } = require('../config');
const moderationRepository = require('../database/moderation');
const settingsRepository = require('../database/settings');
const { formatDuration } = require('../utils/duration');
const { discordTime, formatExpiry, sanitize } = require('../utils/format');
const { createLogger } = require('../utils/logger');
const { roleState } = require('../utils/permissions');
const channelService = require('./channelService');
const roleService = require('./roleService');

const log = createLogger('moderation');

/**
 * Moderation core shared by the moderation commands, automod and the
 * join/scheduler hooks: numbered cases, warnings, persistent role-based mutes,
 * Discord-native timeouts, kicks, (temporary) bans and the mod-log channel.
 *
 * Commands do the *authorisation* (who may target whom, see roleService);
 * this service does the *action* and the *record*.
 */

class ModerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModerationError';
    this.userFacing = true;
  }
}

const ACTIONS = {
  WARN: { key: 'WARN', label: 'Warn', emoji: '⚠️', color: 0xfee75c },
  UNWARN: { key: 'UNWARN', label: 'Warning Removed', emoji: '🧹', color: 0x99aab5 },
  CLEARWARNINGS: { key: 'CLEARWARNINGS', label: 'Warnings Cleared', emoji: '🧹', color: 0x99aab5 },
  MUTE: { key: 'MUTE', label: 'Mute', emoji: '🔇', color: 0xe67e22 },
  UNMUTE: { key: 'UNMUTE', label: 'Unmute', emoji: '🔊', color: 0x57f287 },
  MUTE_EXPIRED: { key: 'MUTE_EXPIRED', label: 'Mute Expired', emoji: '⏰', color: 0x57f287 },
  MUTE_RESTORED: { key: 'MUTE_RESTORED', label: 'Mute Restored', emoji: '🔁', color: 0xe67e22 },
  TIMEOUT: { key: 'TIMEOUT', label: 'Timeout', emoji: '⏳', color: 0xe67e22 },
  UNTIMEOUT: { key: 'UNTIMEOUT', label: 'Timeout Removed', emoji: '✅', color: 0x57f287 },
  KICK: { key: 'KICK', label: 'Kick', emoji: '👢', color: 0xed4245 },
  BAN: { key: 'BAN', label: 'Ban', emoji: '🔨', color: 0xed4245 },
  TEMPBAN: { key: 'TEMPBAN', label: 'Temporary Ban', emoji: '🔨', color: 0xed4245 },
  UNBAN: { key: 'UNBAN', label: 'Unban', emoji: '🔓', color: 0x57f287 },
  BAN_EXPIRED: { key: 'BAN_EXPIRED', label: 'Temporary Ban Expired', emoji: '⏰', color: 0x57f287 },
  PURGE: { key: 'PURGE', label: 'Purge', emoji: '🗑️', color: 0x99aab5 },
  LOCK: { key: 'LOCK', label: 'Channel Locked', emoji: '🔒', color: 0xe67e22 },
  UNLOCK: { key: 'UNLOCK', label: 'Channel Unlocked', emoji: '🔓', color: 0x57f287 },
  SLOWMODE: { key: 'SLOWMODE', label: 'Slowmode', emoji: '🐌', color: 0x99aab5 },
  NICK: { key: 'NICK', label: 'Nickname Changed', emoji: '✏️', color: 0x99aab5 },
  RESETNICK: { key: 'RESETNICK', label: 'Nickname Reset', emoji: '✏️', color: 0x99aab5 },
  AUTOMOD: { key: 'AUTOMOD', label: 'Automod', emoji: '🤖', color: 0xe67e22 },
};

function actionInfo(key) {
  return ACTIONS[key] ?? { key, label: key, emoji: '📋', color: BRAND.neutralColor };
}

function idOf(entity) {
  if (!entity) return null;
  return entity.id ?? String(entity);
}

/* ------------------------------------------------------------------ *
 * Cases + mod log
 * ------------------------------------------------------------------ */

/** Renders the standard "Case #42" embed for a case row. */
function buildCaseEmbed(caseRow) {
  const info = actionInfo(caseRow.action);
  const embed = new EmbedBuilder()
    .setColor(info.color)
    .setTitle(`${info.emoji} Case #${caseRow.case_number} — ${info.label}`)
    .setTimestamp(new Date(caseRow.created_at));

  const fields = [];
  if (caseRow.target_id) {
    fields.push({ name: 'User', value: `<@${caseRow.target_id}> (\`${caseRow.target_id}\`)`, inline: true });
  }
  fields.push({ name: 'Moderator', value: `<@${caseRow.moderator_id}>`, inline: true });
  if (caseRow.duration_ms) {
    fields.push({ name: 'Duration', value: formatDuration(caseRow.duration_ms), inline: true });
  }
  if (caseRow.expires_at) {
    fields.push({ name: 'Expires', value: formatExpiry(caseRow.expires_at), inline: true });
  }
  if (caseRow.metadata?.channelId) {
    fields.push({ name: 'Channel', value: `<#${caseRow.metadata.channelId}>`, inline: true });
  }
  if (caseRow.metadata?.count !== undefined) {
    fields.push({ name: 'Count', value: String(caseRow.metadata.count), inline: true });
  }
  fields.push({ name: 'Reason', value: sanitize(caseRow.reason || 'No reason provided', 1000) });
  embed.addFields(fields);
  return embed;
}

/** Posts a case to the configured mod-log channel (best effort). */
async function logCase(guild, caseRow) {
  const settings = settingsRepository.getSettings(guild.id);
  if (!settings?.modlog_channel_id) return null;

  const channel = await channelService.fetchChannel(guild, settings.modlog_channel_id);
  if (!channel?.isTextBased()) {
    log.warn(`Mod-log channel ${settings.modlog_channel_id} is gone in ${guild.id}; clearing it.`);
    settingsRepository.updateSettings(guild.id, { modlog_channel_id: null });
    return null;
  }

  try {
    const message = await channel.send({ embeds: [buildCaseEmbed(caseRow)] });
    moderationRepository.setCaseLogMessage(caseRow.id, message.id);
    return message;
  } catch (error) {
    log.warn(`Failed to write case #${caseRow.case_number} to the mod log:`, error);
    return null;
  }
}

/** Creates a case row, logs it, and returns the row. */
async function createCase({ guild, action, target = null, moderator, reason = null, durationMs = null, expiresAt = null, metadata = null }) {
  const caseRow = moderationRepository.createCase({
    guildId: guild.id,
    action,
    targetId: idOf(target),
    moderatorId: idOf(moderator),
    reason: reason ? sanitize(reason, 500) : null,
    durationMs,
    expiresAt,
    metadata,
  });

  log.info(
    `[${guild.id}] Case #${caseRow.case_number} ${action}` +
      (caseRow.target_id ? ` target=${caseRow.target_id}` : '') +
      ` by=${caseRow.moderator_id}` +
      (durationMs ? ` duration=${formatDuration(durationMs)}` : '') +
      (reason ? ` reason="${sanitize(reason, 80)}"` : ''),
  );

  await logCase(guild, caseRow);
  return caseRow;
}

/* ------------------------------------------------------------------ *
 * Warnings
 * ------------------------------------------------------------------ */

async function warn({ guild, target, moderator, reason = null, source = 'MANUAL' }) {
  const caseRow = await createCase({
    guild,
    action: source === 'AUTOMOD' ? ACTIONS.AUTOMOD.key : ACTIONS.WARN.key,
    target,
    moderator,
    reason,
  });
  const warning = moderationRepository.addWarning({
    guildId: guild.id,
    userId: idOf(target),
    moderatorId: idOf(moderator),
    reason: reason ? sanitize(reason, 500) : null,
    caseId: caseRow.id,
    source,
  });
  const count = moderationRepository.countActiveWarnings(guild.id, idOf(target));
  return { case: caseRow, warning, count };
}

function listWarnings(guildId, userId) {
  return moderationRepository.listWarnings(guildId, userId);
}

function countWarnings(guildId, userId) {
  return moderationRepository.countActiveWarnings(guildId, userId);
}

async function clearWarnings({ guild, target, moderator, reason = null }) {
  const cleared = moderationRepository.clearWarnings(guild.id, idOf(target), idOf(moderator));
  const caseRow = await createCase({
    guild,
    action: ACTIONS.CLEARWARNINGS.key,
    target,
    moderator,
    reason,
    metadata: { count: cleared },
  });
  return { cleared, case: caseRow };
}

async function removeWarning({ guild, target, moderator, warningId, reason = null }) {
  const ok = moderationRepository.clearWarning(guild.id, warningId, idOf(moderator));
  if (!ok) return { removed: false, case: null };
  const caseRow = await createCase({
    guild,
    action: ACTIONS.UNWARN.key,
    target,
    moderator,
    reason,
    metadata: { warningId },
  });
  return { removed: true, case: caseRow };
}

/* ------------------------------------------------------------------ *
 * Role-based mutes (persistent)
 * ------------------------------------------------------------------ */

/** Resolves the configured Mute role or throws a user-facing error. */
function requireMuteRole(guild) {
  const { state, role, roleId } = roleState(guild, ROLE_TYPES.MUTE.key);
  if (state === 'unset') {
    throw new ModerationError('No Mute role is configured. An Admin can set one with `setrole @Muted as Mute`.');
  }
  if (!role) {
    throw new ModerationError(
      `The configured Mute role (\`${roleId}\`) was deleted. An Admin must set a replacement with ` +
        '`setrole @Muted as Mute`.',
    );
  }
  const check = roleService.botCanManageRole(guild, role);
  if (!check.ok) throw new ModerationError(check.reason);
  return role;
}

/**
 * Applies the Mute role and records the mute. `durationMs: null` = until unmuted.
 */
async function mute({ guild, target, moderator, durationMs = null, reason = null }) {
  const role = requireMuteRole(guild);
  const botCheck = roleService.botCanManageMember(target);
  if (!botCheck.ok) throw new ModerationError(botCheck.reason);

  const until = durationMs ? Date.now() + durationMs : null;

  await target.roles.add(role, `Muted by ${moderator.user?.tag ?? idOf(moderator)}: ${reason ?? 'no reason'}`);

  const caseRow = await createCase({
    guild,
    action: ACTIONS.MUTE.key,
    target,
    moderator,
    reason,
    durationMs,
    expiresAt: until,
  });

  const record = moderationRepository.createMute({
    guildId: guild.id,
    userId: target.id,
    muteRoleId: role.id,
    moderatorId: idOf(moderator),
    reason,
    caseId: caseRow.id,
    muteUntil: until,
  });

  return { case: caseRow, mute: record, until, role };
}

/** Removes the Mute role (if present) and closes the record. */
async function unmute({ guild, target, moderator, reason = null, releaseReason = 'UNMUTED', action = ACTIONS.UNMUTE.key, createLog = true }) {
  const record = moderationRepository.releaseMute(guild.id, idOf(target), releaseReason);
  const roleId = record?.mute_role_id ?? roleState(guild, ROLE_TYPES.MUTE.key).roleId;
  const role = roleId ? guild.roles.cache.get(roleId) : null;

  let roleRemoved = false;
  if (role && target?.roles?.cache?.has(role.id)) {
    const check = roleService.botCanManageRole(guild, role);
    if (check.ok) {
      await target.roles.remove(role, `Unmuted: ${reason ?? releaseReason}`);
      roleRemoved = true;
    } else {
      log.warn(`Could not remove Mute role from ${idOf(target)}: ${check.reason}`);
    }
  }

  if (!record && !roleRemoved) {
    throw new ModerationError('That member is not muted.');
  }

  const caseRow = createLog
    ? await createCase({ guild, action, target, moderator, reason })
    : null;

  return { case: caseRow, released: Boolean(record), roleRemoved };
}

/**
 * Called on member join. If an active mute exists, re-applies the role (or
 * expires the record when the mute ran out while they were away).
 * The original expiry is preserved -- rejoining never restarts the clock.
 */
async function restoreMuteOnJoin(member) {
  const record = moderationRepository.getActiveMute(member.guild.id, member.id);
  if (!record) return { restored: false, expired: false };

  if (record.mute_until && record.mute_until <= Date.now()) {
    moderationRepository.releaseMute(member.guild.id, member.id, 'EXPIRED');
    log.info(`Mute for ${member.id} in ${member.guild.id} expired while they were away; marked inactive.`);
    return { restored: false, expired: true };
  }

  const { state, role } = roleState(member.guild, ROLE_TYPES.MUTE.key);
  const target = role ?? member.guild.roles.cache.get(record.mute_role_id) ?? null;
  if (!target) {
    log.warn(`Cannot restore mute for ${member.id}: Mute role is ${state} in ${member.guild.id}.`);
    return { restored: false, expired: false, reason: `mute role ${state}` };
  }

  const check = roleService.botCanManageRole(member.guild, target);
  if (!check.ok) {
    log.warn(`Cannot restore mute for ${member.id}: ${check.reason}`);
    return { restored: false, expired: false, reason: check.reason };
  }

  try {
    await member.roles.add(target, 'Mute restored after rejoin (mute evasion protection)');
  } catch (error) {
    log.error(`Failed to restore Mute role for ${member.id}:`, error);
    return { restored: false, expired: false, reason: error.message };
  }

  log.info(
    `Restored mute for ${member.user.tag} (${member.id}) in ${member.guild.id}; ` +
      (record.mute_until ? `expires ${new Date(record.mute_until).toISOString()}` : 'permanent'),
  );

  await createCase({
    guild: member.guild,
    target: member,
    moderator: member.client.user,
    action: ACTIONS.MUTE_RESTORED.key,
    reason: `Rejoined while muted (original case #${record.case_id ? moderationRepository.getCaseById(record.case_id)?.case_number ?? '?' : '?'})`,
    expiresAt: record.mute_until,
  });

  return { restored: true, expired: false, until: record.mute_until };
}

/** Scheduler job: lifts every mute whose time is up. */
async function expireMutes(client) {
  const due = moderationRepository.listExpiredMutes();
  for (const record of due) {
    const guild = client.guilds.cache.get(record.guild_id);
    moderationRepository.releaseMute(record.guild_id, record.user_id, 'EXPIRED');

    if (!guild) {
      log.warn(`Mute ${record.id} expired but guild ${record.guild_id} is unavailable; record closed.`);
      continue;
    }

    const member = await guild.members.fetch(record.user_id).catch(() => null);
    const role = guild.roles.cache.get(record.mute_role_id) ?? roleState(guild, ROLE_TYPES.MUTE.key).role;

    if (member && role && member.roles.cache.has(role.id)) {
      const check = roleService.botCanManageRole(guild, role);
      if (check.ok) {
        await member.roles.remove(role, 'Mute expired').catch((error) =>
          log.error(`Failed to remove expired mute role from ${record.user_id}:`, error),
        );
      } else {
        log.warn(`Mute for ${record.user_id} expired but I cannot remove ${role.name}: ${check.reason}`);
      }
    }

    log.info(`Mute expired for ${record.user_id} in ${record.guild_id}.`);
    await createCase({
      guild,
      action: ACTIONS.MUTE_EXPIRED.key,
      target: { id: record.user_id },
      moderator: client.user,
      reason: 'Mute duration elapsed',
    });
  }
  return due.length;
}

function getActiveMute(guildId, userId) {
  return moderationRepository.getActiveMute(guildId, userId);
}

/* ------------------------------------------------------------------ *
 * Native timeouts
 * ------------------------------------------------------------------ */

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

async function timeout({ guild, target, moderator, durationMs, reason = null }) {
  if (!durationMs || durationMs <= 0) throw new ModerationError('A timeout needs a duration.');
  if (durationMs > MAX_TIMEOUT_MS) throw new ModerationError('Discord timeouts cannot exceed 28 days.');
  const botCheck = roleService.botCanManageMember(target);
  if (!botCheck.ok) throw new ModerationError(botCheck.reason);
  if (!target.moderatable) throw new ModerationError(`I cannot time out ${target}.`);

  await target.timeout(durationMs, sanitize(reason ?? 'No reason provided', 400));
  const caseRow = await createCase({
    guild,
    action: ACTIONS.TIMEOUT.key,
    target,
    moderator,
    reason,
    durationMs,
    expiresAt: Date.now() + durationMs,
  });
  return { case: caseRow, until: Date.now() + durationMs };
}

async function untimeout({ guild, target, moderator, reason = null }) {
  if (!target.communicationDisabledUntilTimestamp || target.communicationDisabledUntilTimestamp <= Date.now()) {
    throw new ModerationError(`${target} is not timed out.`);
  }
  const botCheck = roleService.botCanManageMember(target);
  if (!botCheck.ok) throw new ModerationError(botCheck.reason);

  await target.timeout(null, sanitize(reason ?? 'Timeout removed', 400));
  const caseRow = await createCase({ guild, action: ACTIONS.UNTIMEOUT.key, target, moderator, reason });
  return { case: caseRow };
}

/* ------------------------------------------------------------------ *
 * Kick / ban
 * ------------------------------------------------------------------ */

async function kick({ guild, target, moderator, reason = null }) {
  const botCheck = roleService.botCanManageMember(target);
  if (!botCheck.ok) throw new ModerationError(botCheck.reason);
  if (!target.kickable) throw new ModerationError(`I cannot kick ${target}.`);

  await target.kick(sanitize(reason ?? 'No reason provided', 400));
  const caseRow = await createCase({ guild, action: ACTIONS.KICK.key, target, moderator, reason });
  return { case: caseRow };
}

/**
 * Bans a user (member or not). With `durationMs` the ban is temporary and the
 * scheduler lifts it; the record survives restarts.
 */
async function ban({ guild, target, moderator, durationMs = null, reason = null, deleteMessageSeconds = 0 }) {
  const member = guild.members.cache.get(idOf(target)) ?? null;
  if (member) {
    const botCheck = roleService.botCanManageMember(member);
    if (!botCheck.ok) throw new ModerationError(botCheck.reason);
    if (!member.bannable) throw new ModerationError(`I cannot ban ${member}.`);
  } else if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
    throw new ModerationError('I am missing the **Ban Members** permission.');
  }

  const until = durationMs ? Date.now() + durationMs : null;
  await guild.members.ban(idOf(target), {
    reason: sanitize(reason ?? 'No reason provided', 400),
    deleteMessageSeconds,
  });

  const caseRow = await createCase({
    guild,
    action: durationMs ? ACTIONS.TEMPBAN.key : ACTIONS.BAN.key,
    target,
    moderator,
    reason,
    durationMs,
    expiresAt: until,
  });

  if (durationMs) {
    moderationRepository.createTempBan({
      guildId: guild.id,
      userId: idOf(target),
      moderatorId: idOf(moderator),
      reason,
      caseId: caseRow.id,
      unbanAt: until,
    });
  }

  return { case: caseRow, until };
}

async function unban({ guild, userId, moderator, reason = null, action = ACTIONS.UNBAN.key }) {
  try {
    await guild.members.unban(userId, sanitize(reason ?? 'No reason provided', 400));
  } catch (error) {
    if (error?.code === 10026) throw new ModerationError('That user is not banned.');
    throw error;
  }
  moderationRepository.releaseTempBan(guild.id, userId);
  const caseRow = await createCase({ guild, action, target: { id: userId }, moderator, reason });
  return { case: caseRow };
}

/** Scheduler job: lifts expired temporary bans. */
async function expireTempBans(client) {
  const due = moderationRepository.listExpiredTempBans();
  for (const record of due) {
    moderationRepository.releaseTempBan(record.guild_id, record.user_id);
    const guild = client.guilds.cache.get(record.guild_id);
    if (!guild) continue;
    try {
      await guild.members.unban(record.user_id, 'Temporary ban expired');
      log.info(`Temporary ban expired for ${record.user_id} in ${record.guild_id}.`);
      await createCase({
        guild,
        action: ACTIONS.BAN_EXPIRED.key,
        target: { id: record.user_id },
        moderator: client.user,
        reason: 'Temporary ban elapsed',
      });
    } catch (error) {
      if (error?.code !== 10026) log.error(`Failed to lift expired ban for ${record.user_id}:`, error);
    }
  }
  return due.length;
}

module.exports = {
  ACTIONS,
  ModerationError,
  actionInfo,
  buildCaseEmbed,
  logCase,
  createCase,
  getCaseByNumber: moderationRepository.getCaseByNumber,
  listCasesForUser: moderationRepository.listCasesForUser,
  warn,
  listWarnings,
  countWarnings,
  clearWarnings,
  removeWarning,
  requireMuteRole,
  mute,
  unmute,
  restoreMuteOnJoin,
  expireMutes,
  getActiveMute,
  timeout,
  untimeout,
  kick,
  ban,
  unban,
  expireTempBans,
  MAX_TIMEOUT_MS,
};
