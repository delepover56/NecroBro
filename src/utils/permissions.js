'use strict';

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const { getGuildConfig } = require('../database/config');

/**
 * Permission helpers.
 *
 * The bot deliberately never asks for Administrator. These are the only
 * permissions it actually needs, and `describeMissingPermissions()` turns a
 * shortfall into a message a server owner can act on.
 */
const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
];

/** Human-readable names for the flags above, for error messages. */
const PERMISSION_LABELS = new Map([
  [PermissionFlagsBits.ViewChannel, 'View Channels'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
]);

function labelFor(flag) {
  return PERMISSION_LABELS.get(flag) ?? new PermissionsBitField(flag).toArray().join(', ');
}

/** Returns the required guild-level permissions the bot is missing. */
function missingBotPermissions(guild, required = REQUIRED_BOT_PERMISSIONS) {
  const me = guild.members.me;
  if (!me) return required.map(labelFor);
  return required.filter((flag) => !me.permissions.has(flag)).map(labelFor);
}

/** Returns the permissions the bot is missing *in a specific channel*. */
function missingChannelPermissions(channel, required) {
  const me = channel.guild?.members?.me;
  if (!me) return required.map(labelFor);
  const permissions = channel.permissionsFor(me);
  if (!permissions) return required.map(labelFor);
  return required.filter((flag) => !permissions.has(flag)).map(labelFor);
}

/**
 * Staff check used by every staff-only interaction.
 *
 * A member counts as staff when they hold a configured staff role, or when they
 * have Manage Server / Manage Channels (so a fresh install is never locked out
 * and a deleted staff role does not brick the system).
 */
function isStaff(member, config = null) {
  if (!member) return false;

  const resolved = config ?? getGuildConfig(member.guild.id);
  const staffRoleIds = resolved?.staffRoleIds ?? [];

  if (staffRoleIds.some((roleId) => member.roles.cache.has(roleId))) return true;

  return (
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels)
  );
}

/** Staff role IDs that still exist in the guild (deleted roles are dropped). */
function resolveStaffRoles(guild, config) {
  const ids = config?.staffRoleIds ?? [];
  return ids.filter((roleId) => guild.roles.cache.has(roleId));
}

module.exports = {
  REQUIRED_BOT_PERMISSIONS,
  missingBotPermissions,
  missingChannelPermissions,
  isStaff,
  resolveStaffRoles,
  labelFor,
};
