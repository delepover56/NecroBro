'use strict';

const { prepare, transaction } = require('./database');
const { createLogger } = require('../utils/logger');

const log = createLogger('db:config');

/**
 * Guild configuration repository: channel/category/role IDs, the panel message
 * pointer, and the per-guild suggestion counter. Also owns the temporary
 * submission channel bookkeeping so restart recovery has something to read.
 */

const COLUMNS = [
  'suggestions_channel_id',
  'voting_channel_id',
  'submission_category_id',
  'staff_log_channel_id',
  'panel_message_id',
];

/** Converts a raw row into a friendlier object (staff_role_ids becomes an array). */
function hydrate(row) {
  if (!row) return null;
  let staffRoleIds = [];
  try {
    const parsed = JSON.parse(row.staff_role_ids ?? '[]');
    if (Array.isArray(parsed)) staffRoleIds = parsed.filter((id) => typeof id === 'string');
  } catch (error) {
    log.warn(`Corrupt staff_role_ids for guild ${row.guild_id}, treating as empty:`, error);
  }
  return { ...row, staffRoleIds };
}

/** Returns the stored config for a guild, or `null` if setup has never run. */
function getGuildConfig(guildId) {
  const row = prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
  return hydrate(row);
}

/** Ensures a config row exists and returns it. */
function ensureGuildConfig(guildId) {
  const existing = getGuildConfig(guildId);
  if (existing) return existing;

  const now = Date.now();
  prepare(
    'INSERT OR IGNORE INTO guild_config (guild_id, created_at, updated_at) VALUES (?, ?, ?)',
  ).run(guildId, now, now);
  return getGuildConfig(guildId);
}

/**
 * Partially updates a guild's configuration.
 * `patch` accepts any of the ID columns plus `staffRoleIds` (array of strings).
 */
function updateGuildConfig(guildId, patch) {
  ensureGuildConfig(guildId);

  const assignments = [];
  const values = [];

  for (const column of COLUMNS) {
    if (patch[column] !== undefined) {
      assignments.push(`${column} = ?`);
      values.push(patch[column] === null ? null : String(patch[column]));
    }
  }

  if (patch.staffRoleIds !== undefined) {
    const unique = [...new Set((patch.staffRoleIds ?? []).map(String))];
    assignments.push('staff_role_ids = ?');
    values.push(JSON.stringify(unique));
  }

  if (assignments.length === 0) return getGuildConfig(guildId);

  assignments.push('updated_at = ?');
  values.push(Date.now(), guildId);

  prepare(`UPDATE guild_config SET ${assignments.join(', ')} WHERE guild_id = ?`).run(...values);
  return getGuildConfig(guildId);
}

/**
 * Atomically increments and returns the next suggestion number for a guild.
 * Runs inside the caller's transaction when one is already open, which is how
 * suggestion creation keeps numbering gap-free under concurrent submissions.
 */
function nextSuggestionNumber(guildId) {
  return transaction(() => {
    ensureGuildConfig(guildId);
    prepare(
      'UPDATE guild_config SET suggestion_counter = suggestion_counter + 1, updated_at = ? ' +
        'WHERE guild_id = ?',
    ).run(Date.now(), guildId);
    const row = prepare('SELECT suggestion_counter FROM guild_config WHERE guild_id = ?').get(
      guildId,
    );
    return Number(row.suggestion_counter);
  });
}

/* ------------------------------------------------------------------ *
 * Temporary submission channels
 * ------------------------------------------------------------------ */

/** Records a temporary suggestion channel so it survives a restart. */
function createTempChannel({ channelId, guildId, userId }) {
  prepare(
    'INSERT OR REPLACE INTO temp_channels (channel_id, guild_id, user_id, created_at) ' +
      'VALUES (?, ?, ?, ?)',
  ).run(channelId, guildId, userId, Date.now());
}

/** Looks up an existing temporary channel for a member, if any. */
function getTempChannelForUser(guildId, userId) {
  return (
    prepare('SELECT * FROM temp_channels WHERE guild_id = ? AND user_id = ?').get(
      guildId,
      userId,
    ) ?? null
  );
}

/** Looks up a temporary channel by its Discord channel ID. */
function getTempChannel(channelId) {
  return prepare('SELECT * FROM temp_channels WHERE channel_id = ?').get(channelId) ?? null;
}

/** Forgets a temporary channel (after deletion or cleanup). */
function deleteTempChannel(channelId) {
  prepare('DELETE FROM temp_channels WHERE channel_id = ?').run(channelId);
}

/** All temporary channels recorded for a guild -- used by restart recovery. */
function listTempChannels(guildId) {
  return prepare('SELECT * FROM temp_channels WHERE guild_id = ?').all(guildId);
}

module.exports = {
  getGuildConfig,
  ensureGuildConfig,
  updateGuildConfig,
  nextSuggestionNumber,
  createTempChannel,
  getTempChannel,
  getTempChannelForUser,
  deleteTempChannel,
  listTempChannels,
};
