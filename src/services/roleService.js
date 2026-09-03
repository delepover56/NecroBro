'use strict';

const { PermissionFlagsBits } = require('discord.js');

const { ROLE_TYPES, SEED_ROLES, env } = require('../config');
const rolesRepository = require('../database/roles');
const { createLogger } = require('../utils/logger');
const { roleState, isOwner, isAdmin, isModerator } = require('../utils/permissions');

const log = createLogger('roles');

/**
 * Logical role service: resolution, replacement, seeding, Discord-hierarchy
 * checks and the join-time auto-assignment of Member + Survival.
 */

/** `{ ADMIN: {state, roleId, role}, ... }` for every logical type. */
function getConfiguredRoles(guild) {
  const result = {};
  for (const type of Object.keys(ROLE_TYPES)) result[type] = roleState(guild, type);
  return result;
}

/** The live Role for a logical type, or null when unset/deleted. */
function getRole(guild, roleType) {
  return roleState(guild, roleType).role;
}

/** Stores a new mapping. Returns the previous role ID (if any). */
function setRoleMapping(guild, roleType, role, actorId) {
  const previous = rolesRepository.getRoleId(guild.id, roleType);
  rolesRepository.setRole(guild.id, roleType, role.id, actorId);
  log.info(
    `Role mapping ${roleType} in guild ${guild.id} set to ${role.id} (${role.name}) by ${actorId}` +
      (previous ? ` (was ${previous})` : ''),
  );
  return previous;
}

/**
 * Seeds the home guild's initial role mapping exactly once. Roles that no
 * longer exist are skipped so a stale seed can never poison the config.
 */
function seedHomeGuild(guild) {
  let homeGuildId;
  try {
    homeGuildId = env.guildId;
  } catch {
    return 0;
  }
  if (guild.id !== homeGuildId) return 0;
  if (rolesRepository.hasAnyRoles(guild.id)) return 0;

  const mapping = {};
  for (const [type, roleId] of Object.entries(SEED_ROLES)) {
    if (guild.roles.cache.has(roleId)) mapping[type] = roleId;
    else log.warn(`Seed role ${type} (${roleId}) does not exist in ${guild.name}; skipped.`);
  }

  const inserted = rolesRepository.seedRoles(guild.id, mapping);
  if (inserted > 0) log.info(`Seeded ${inserted} role mapping(s) for ${guild.name}.`);
  return inserted;
}

/* ------------------------------------------------------------------ *
 * Hierarchy checks
 * ------------------------------------------------------------------ */

/** Can the bot assign/remove this role? */
function botCanManageRole(guild, role) {
  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'I could not resolve my own member record.' };
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, reason: 'I am missing the **Manage Roles** permission.' };
  }
  if (role.managed) {
    return { ok: false, reason: `${role} is managed by an integration and cannot be assigned.` };
  }
  if (role.id === guild.roles.everyone.id) {
    return { ok: false, reason: 'The @everyone role cannot be assigned.' };
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return {
      ok: false,
      reason: `${role} is above my highest role. Move my role above it in Server Settings → Roles.`,
    };
  }
  return { ok: true };
}

/** Can the bot act on this member at all (kick/ban/mute/nick)? */
function botCanManageMember(member) {
  const { guild } = member;
  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'I could not resolve my own member record.' };
  if (member.id === guild.ownerId) {
    return { ok: false, reason: 'The server owner cannot be moderated.' };
  }
  if (member.id === me.id) return { ok: false, reason: 'I cannot moderate myself.' };
  if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    return {
      ok: false,
      reason: `${member} has a role equal to or above my highest role, so Discord will not let me act on them.`,
    };
  }
  return { ok: true };
}

/**
 * May `actor` moderate `target`?
 *   - nobody moderates the owner or the bot
 *   - nobody moderates themselves
 *   - Moderators cannot touch Admins; Admins cannot touch the owner
 *   - Discord role hierarchy must also allow it (owner bypasses)
 */
function canActorTarget(actor, target) {
  if (!target) return { ok: false, reason: 'That member could not be found.' };
  if (target.id === actor.id) return { ok: false, reason: 'You cannot moderate yourself.' };
  if (target.id === actor.client.user.id) return { ok: false, reason: 'I will not moderate myself.' };
  if (isOwner(target)) return { ok: false, reason: 'The server owner cannot be moderated.' };

  if (isOwner(actor)) return { ok: true };

  if (isAdmin(target) && !isAdmin(actor)) {
    return { ok: false, reason: 'Moderators cannot moderate Admins.' };
  }
  if (isAdmin(target) && isAdmin(actor)) {
    return { ok: false, reason: 'Admins cannot moderate other Admins.' };
  }
  if (isModerator(target) && !isAdmin(actor)) {
    return { ok: false, reason: 'Moderators cannot moderate other Moderators.' };
  }

  if (actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return {
      ok: false,
      reason: `${target} has a role equal to or above yours.`,
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Join-time assignment
 * ------------------------------------------------------------------ */

const JOIN_ROLE_TYPES = [ROLE_TYPES.MEMBER.key, ROLE_TYPES.SURVIVAL.key];

/**
 * Assigns the configured Member and Survival roles to a new member.
 * Never throws; returns `{ assigned, skipped }` for logging.
 */
async function assignJoinRoles(member) {
  const assigned = [];
  const skipped = [];

  for (const type of JOIN_ROLE_TYPES) {
    const { state, role, roleId } = roleState(member.guild, type);

    if (state === 'unset') {
      skipped.push({ type, reason: 'not configured' });
      continue;
    }
    if (!role) {
      skipped.push({ type, reason: `role ${roleId} was deleted` });
      log.warn(`Cannot assign ${type} to ${member.id}: role ${roleId} no longer exists in ${member.guild.id}.`);
      continue;
    }

    const check = botCanManageRole(member.guild, role);
    if (!check.ok) {
      skipped.push({ type, reason: check.reason });
      log.warn(`Cannot assign ${type} (${role.name}) to ${member.id}: ${check.reason}`);
      continue;
    }

    try {
      await member.roles.add(role, 'Auto-assigned on join');
      assigned.push(type);
    } catch (error) {
      skipped.push({ type, reason: error.message });
      log.error(`Failed to assign ${type} (${role.name}) to ${member.id}:`, error);
    }
  }

  if (assigned.length > 0) {
    log.info(`Assigned ${assigned.join(' + ')} to ${member.user.tag} (${member.id}) on join.`);
  }
  return { assigned, skipped };
}

module.exports = {
  getConfiguredRoles,
  getRole,
  setRoleMapping,
  seedHomeGuild,
  botCanManageRole,
  botCanManageMember,
  canActorTarget,
  assignJoinRoles,
};
