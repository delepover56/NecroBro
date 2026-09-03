'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const { PERMISSION_LEVELS, ROLE_TYPES } = require('../config');
const { getGuildConfig } = require('../database/config');
const rolesRepository = require('../database/roles');

/**
 * Centralised permission model.
 *
 * Access is decided by the *logical* roles stored in the database (Admin,
 * Moderator, ...) plus server ownership -- never by Discord's Administrator or
 * Manage Server flags. That keeps "who may configure the bot" a deliberate,
 * visible choice, and it gives the server owner a guaranteed way back in when
 * the Admin role is deleted or unassigned.
 */

/* ------------------------------------------------------------------ *
 * Bot permissions (least privilege)
 * ------------------------------------------------------------------ */

const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageNicknames,
];

/** The subset the suggestion system alone needs (kept for /setup-suggestions). */
const SUGGESTION_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];

const PERMISSION_LABELS = new Map([
  [PermissionFlagsBits.ViewChannel, 'View Channels'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
  [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
  [PermissionFlagsBits.KickMembers, 'Kick Members'],
  [PermissionFlagsBits.BanMembers, 'Ban Members'],
  [PermissionFlagsBits.ManageNicknames, 'Manage Nicknames'],
]);

function labelFor(flag) {
  return PERMISSION_LABELS.get(flag) ?? new PermissionsBitField(flag).toArray().join(', ');
}

/** Required guild-level permissions the bot is missing (as labels). */
function missingBotPermissions(guild, required = REQUIRED_BOT_PERMISSIONS) {
  const me = guild.members.me;
  if (!me) return required.map(labelFor);
  return required.filter((flag) => !me.permissions.has(flag)).map(labelFor);
}

/** Permissions the bot is missing in one channel (as labels). */
function missingChannelPermissions(channel, required) {
  const me = channel.guild?.members?.me;
  if (!me) return required.map(labelFor);
  const permissions = channel.permissionsFor(me);
  if (!permissions) return required.map(labelFor);
  return required.filter((flag) => !permissions.has(flag)).map(labelFor);
}

/* ------------------------------------------------------------------ *
 * Logical role resolution
 * ------------------------------------------------------------------ */

/**
 * Describes the health of one configured logical role in a guild.
 *   unset       nothing configured
 *   missing     configured, but the Discord role was deleted
 *   unassigned  role exists but nobody holds it (only meaningful for Admin)
 *   ok          role exists (and, for Admin, at least one member holds it)
 */
function roleState(guild, roleType) {
  const roleId = rolesRepository.getRoleId(guild.id, roleType);
  if (!roleId) return { state: 'unset', roleId: null, role: null };

  const role = guild.roles.cache.get(roleId) ?? null;
  if (!role) return { state: 'missing', roleId, role: null };

  if (roleType === ROLE_TYPES.ADMIN.key && role.members.size === 0) {
    return { state: 'unassigned', roleId, role };
  }
  return { state: 'ok', roleId, role };
}

function memberHasRoleType(member, roleType) {
  const { state, roleId } = roleState(member.guild, roleType);
  if (state !== 'ok') return false;
  return member.roles.cache.has(roleId);
}

/* ------------------------------------------------------------------ *
 * Level checks
 * ------------------------------------------------------------------ */

function isOwner(member) {
  return Boolean(member) && member.guild.ownerId === member.id;
}

/**
 * Admin = server owner, or a holder of a *valid* configured Admin role.
 * When the Admin role is unset, deleted, or held by nobody, only the owner
 * qualifies -- the bootstrap rule that prevents a lock-out.
 */
function isAdmin(member) {
  if (!member) return false;
  if (isOwner(member)) return true;
  return memberHasRoleType(member, ROLE_TYPES.ADMIN.key);
}

function isModerator(member) {
  if (!member) return false;
  if (isAdmin(member)) return true;
  return memberHasRoleType(member, ROLE_TYPES.MODERATOR.key);
}

const canModerate = isModerator;
const canConfigure = isAdmin;

/** Highest permission level a member holds. */
function getPermissionLevel(member) {
  if (isOwner(member)) return PERMISSION_LEVELS.owner.key;
  if (isAdmin(member)) return PERMISSION_LEVELS.admin.key;
  if (isModerator(member)) return PERMISSION_LEVELS.moderator.key;
  return PERMISSION_LEVELS.everyone.key;
}

function levelRank(levelKey) {
  return PERMISSION_LEVELS[levelKey]?.rank ?? PERMISSION_LEVELS.everyone.rank;
}

/** True when `member` meets a command's declared `permission` level. */
function canUseCommand(member, command) {
  const required = command?.permission ?? PERMISSION_LEVELS.everyone.key;
  return levelRank(getPermissionLevel(member)) >= levelRank(required);
}

/**
 * Explains why an Admin-level check failed, so the message can tell the user
 * whether it is a normal denial or the owner-only bootstrap state.
 */
function describeAdminDenial(guild) {
  const { state } = roleState(guild, ROLE_TYPES.ADMIN.key);
  switch (state) {
    case 'unset':
      return 'No Admin role is configured yet, so only the **server owner** can do this. ' +
        'The owner can set one with `setrole @Role as Admin`.';
    case 'missing':
      return 'The configured Admin role no longer exists, so only the **server owner** can do this ' +
        'until a replacement is set with `setrole @Role as Admin`.';
    case 'unassigned':
      return 'Nobody holds the configured Admin role, so only the **server owner** can do this.';
    default:
      return 'This requires the **Admin** role (or server ownership).';
  }
}

/* ------------------------------------------------------------------ *
 * Suggestion staff (management, not configuration)
 * ------------------------------------------------------------------ */

/**
 * Who may change suggestion statuses: Admins, Moderators, and any extra
 * suggestion staff roles chosen during `/setup-suggestions`.
 * Configuration of the suggestion system itself is Admin-only (`isAdmin`).
 */
function isStaff(member, config = null) {
  if (!member) return false;
  if (isModerator(member)) return true;

  const resolved = config ?? getGuildConfig(member.guild.id);
  const staffRoleIds = resolved?.staffRoleIds ?? [];
  return staffRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

/** Staff role IDs that still exist in the guild (deleted roles are dropped). */
function resolveStaffRoles(guild, config) {
  const ids = config?.staffRoleIds ?? [];
  return ids.filter((roleId) => guild.roles.cache.has(roleId));
}

module.exports = {
  REQUIRED_BOT_PERMISSIONS,
  SUGGESTION_BOT_PERMISSIONS,
  labelFor,
  missingBotPermissions,
  missingChannelPermissions,
  roleState,
  memberHasRoleType,
  isOwner,
  isAdmin,
  isModerator,
  canModerate,
  canConfigure,
  getPermissionLevel,
  levelRank,
  canUseCommand,
  describeAdminDenial,
  isStaff,
  resolveStaffRoles,
};
