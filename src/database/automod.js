'use strict';

const { prepare, transaction } = require('./database');

/**
 * Automod repository: one settings row per guild (rules, thresholds, ignore
 * lists) and an append-only violation log used for escalation.
 *
 * JSON columns are hydrated into arrays on the way out and serialised on the
 * way in, so callers only ever see `bad_words: ['...']`, never raw text.
 */

const JSON_COLUMNS = ['bad_words', 'allowed_domains', 'ignored_channels', 'ignored_roles'];

const BOOLEAN_COLUMNS = [
  'enabled',
  'bad_words_enabled',
  'links_enabled',
  'spam_enabled',
  'repeat_enabled',
  'caps_enabled',
  'mentions_enabled',
  'image_spam_enabled',
  'raid_enabled',
  'nuke_enabled',
];

const INTEGER_COLUMNS = [
  'spam_max_messages',
  'spam_interval_seconds',
  'repeat_threshold',
  'caps_min_length',
  'caps_percent',
  'mentions_max',
  'warn_threshold',
  'timeout_threshold',
  'timeout_minutes',
  'violation_window_minutes',
  'image_spam_max_messages',
  'image_spam_interval_seconds',
  'raid_max_joins',
  'raid_interval_seconds',
  'nuke_max_events',
  'nuke_interval_seconds',
];

const ENUM_COLUMNS = ['raid_action'];

const UPDATABLE = new Set([...JSON_COLUMNS, ...BOOLEAN_COLUMNS, ...INTEGER_COLUMNS, ...ENUM_COLUMNS]);

function parseJsonArray(text) {
  if (typeof text !== 'string') return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function hydrate(row) {
  if (!row) return null;
  const result = { ...row };
  for (const column of JSON_COLUMNS) result[column] = parseJsonArray(row[column]);
  for (const column of BOOLEAN_COLUMNS) result[column] = Number(row[column]) === 1;
  for (const column of INTEGER_COLUMNS) result[column] = Number(row[column]);
  return result;
}

/** Serialises one patch value for its column, or throws on a bad shape. */
function serialize(column, value) {
  if (JSON_COLUMNS.includes(column)) {
    if (!Array.isArray(value)) throw new TypeError(`automod.${column} must be an array.`);
    return JSON.stringify([...new Set(value.map((item) => String(item)))]);
  }
  if (BOOLEAN_COLUMNS.includes(column)) return value ? 1 : 0;
  if (column === 'raid_action') {
    if (!['ALERT', 'KICK'].includes(value)) throw new TypeError('automod.raid_action must be ALERT or KICK.');
    return value;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) throw new TypeError(`automod.${column} must be an integer.`);
  return number;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function getSettings(guildId) {
  return hydrate(prepare('SELECT * FROM automod_settings WHERE guild_id = ?').get(guildId));
}

/** Returns the settings row, creating the default one on first access. */
function ensureSettings(guildId) {
  const existing = getSettings(guildId);
  if (existing) return existing;
  const now = Date.now();
  prepare(
    'INSERT OR IGNORE INTO automod_settings (guild_id, created_at, updated_at) VALUES (?, ?, ?)',
  ).run(guildId, now, now);
  return getSettings(guildId);
}

/** Partially updates a guild's automod settings. Unknown keys are ignored. */
function updateSettings(guildId, patch) {
  return transaction(() => {
    ensureSettings(guildId);

    const assignments = [];
    const values = [];
    for (const [column, value] of Object.entries(patch ?? {})) {
      if (!UPDATABLE.has(column) || value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(serialize(column, value));
    }
    if (assignments.length === 0) return getSettings(guildId);

    assignments.push('updated_at = ?');
    values.push(Date.now(), guildId);
    prepare(`UPDATE automod_settings SET ${assignments.join(', ')} WHERE guild_id = ?`).run(
      ...values,
    );
    return getSettings(guildId);
  });
}

/* ------------------------------------------------------------------ *
 * Violations
 * ------------------------------------------------------------------ */

function addViolation({ guildId, userId, rule, actionTaken, messageExcerpt = null, channelId = null }) {
  const result = prepare(
    `INSERT INTO automod_violations
       (guild_id, user_id, rule, action_taken, message_excerpt, channel_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(guildId, userId, rule, actionTaken, messageExcerpt, channelId, Date.now());
  return prepare('SELECT * FROM automod_violations WHERE id = ?').get(Number(result.lastInsertRowid));
}

/** Violations by one member within the last `windowMs` milliseconds. */
function countRecentViolations(guildId, userId, windowMs) {
  const since = Date.now() - Math.max(0, Number(windowMs) || 0);
  const row = prepare(
    `SELECT COUNT(*) AS n FROM automod_violations
      WHERE guild_id = ? AND user_id = ? AND created_at >= ?`,
  ).get(guildId, userId, since);
  return Number(row?.n ?? 0);
}

/** Most recent violations for a guild (optionally one member), newest first. */
function listRecentViolations(guildId, { userId = null, limit = 10 } = {}) {
  const cap = Math.min(Math.max(1, Number(limit) || 10), 100);
  if (userId) {
    return prepare(
      `SELECT * FROM automod_violations WHERE guild_id = ? AND user_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    ).all(guildId, userId, cap);
  }
  return prepare(
    'SELECT * FROM automod_violations WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(guildId, cap);
}

/** Removes violation rows older than `maxAgeMs` (housekeeping). Returns the count. */
function pruneViolations(maxAgeMs) {
  const result = prepare('DELETE FROM automod_violations WHERE created_at < ?').run(
    Date.now() - Math.max(0, Number(maxAgeMs) || 0),
  );
  return Number(result.changes ?? 0);
}

module.exports = {
  UPDATABLE_COLUMNS: [...UPDATABLE],
  getSettings,
  ensureSettings,
  updateSettings,
  addViolation,
  countRecentViolations,
  listRecentViolations,
  pruneViolations,
};
