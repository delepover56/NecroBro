'use strict';

const { prepare, transaction } = require('./database');
const { ROLE_TYPES } = require('../config');

/**
 * Logical role mapping repository.
 *
 * Every feature that needs "the Admin role" or "the Mute role" asks this
 * repository for the current ID instead of carrying a role ID of its own, so
 * replacing a deleted role is a single `/setrole` and never a code change.
 */

/** Map of role_type -> role_id for a guild (only configured types are present). */
function getRoleMap(guildId) {
  const rows = prepare('SELECT role_type, role_id FROM guild_roles WHERE guild_id = ?').all(
    guildId,
  );
  const map = {};
  for (const row of rows) map[row.role_type] = row.role_id;
  return map;
}

/** The configured role ID for a type, or `null`. */
function getRoleId(guildId, roleType) {
  const row = prepare(
    'SELECT role_id FROM guild_roles WHERE guild_id = ? AND role_type = ?',
  ).get(guildId, roleType);
  return row?.role_id ?? null;
}

/** Sets (or replaces) the mapping for one logical role type. */
function setRole(guildId, roleType, roleId, updatedBy = null) {
  if (!ROLE_TYPES[roleType]) throw new TypeError(`Unknown role type "${roleType}".`);
  prepare(
    `INSERT INTO guild_roles (guild_id, role_type, role_id, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, role_type)
     DO UPDATE SET role_id = excluded.role_id,
                   updated_by = excluded.updated_by,
                   updated_at = excluded.updated_at`,
  ).run(guildId, roleType, roleId, updatedBy, Date.now());
  return getRoleId(guildId, roleType);
}

/** Removes the mapping for one logical role type. */
function clearRole(guildId, roleType) {
  const result = prepare('DELETE FROM guild_roles WHERE guild_id = ? AND role_type = ?').run(
    guildId,
    roleType,
  );
  return Number(result.changes ?? 0) > 0;
}

/** True when the guild has at least one mapping stored. */
function hasAnyRoles(guildId) {
  const row = prepare('SELECT COUNT(*) AS n FROM guild_roles WHERE guild_id = ?').get(guildId);
  return Number(row?.n ?? 0) > 0;
}

/**
 * Inserts mappings only for types that are not yet configured.
 * Used once to seed the home guild's initial roles.
 */
function seedRoles(guildId, mapping, updatedBy = 'seed') {
  return transaction(() => {
    let inserted = 0;
    for (const [roleType, roleId] of Object.entries(mapping)) {
      if (!ROLE_TYPES[roleType] || !roleId) continue;
      const result = prepare(
        `INSERT OR IGNORE INTO guild_roles (guild_id, role_type, role_id, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(guildId, roleType, String(roleId), updatedBy, Date.now());
      inserted += Number(result.changes ?? 0);
    }
    return inserted;
  });
}

module.exports = { getRoleMap, getRoleId, setRole, clearRole, hasAnyRoles, seedRoles };
