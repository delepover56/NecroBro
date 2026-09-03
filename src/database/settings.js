'use strict';

const { prepare, transaction } = require('./database');
const { DEFAULT_PREFIX } = require('../config');

/**
 * Guild-wide settings repository: prefix, welcome/modlog channels, economy
 * tuning and the moderation case counter. Suggestion-specific configuration
 * still lives in `guild_config` (see ./config.js).
 */

const UPDATABLE = new Set([
  'prefix',
  'welcome_channel_id',
  'goodbye_channel_id',
  'welcome_image_url',
  'modlog_channel_id',
  'giveaway_channel_id',
  'currency_name',
  'currency_symbol',
  'economy_enabled',
  'chat_rewards_enabled',
  'chat_xp_min',
  'chat_xp_max',
  'chat_cash_min',
  'chat_cash_max',
  'chat_cash_chance',
  'chat_cooldown_seconds',
  'chat_min_length',
]);

function getSettings(guildId) {
  return prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) ?? null;
}

/** Returns the settings row, creating a default one on first access. */
function ensureSettings(guildId) {
  const existing = getSettings(guildId);
  if (existing) return existing;
  const now = Date.now();
  prepare(
    'INSERT OR IGNORE INTO guild_settings (guild_id, prefix, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(guildId, DEFAULT_PREFIX, now, now);
  return getSettings(guildId);
}

/** Partially updates a guild's settings. Unknown keys are ignored. */
function updateSettings(guildId, patch) {
  ensureSettings(guildId);

  const assignments = [];
  const values = [];
  for (const [column, value] of Object.entries(patch)) {
    if (!UPDATABLE.has(column)) continue;
    assignments.push(`${column} = ?`);
    values.push(value === undefined ? null : value);
  }
  if (assignments.length === 0) return getSettings(guildId);

  assignments.push('updated_at = ?');
  values.push(Date.now(), guildId);
  prepare(`UPDATE guild_settings SET ${assignments.join(', ')} WHERE guild_id = ?`).run(...values);
  return getSettings(guildId);
}

/** The prefix for a guild, falling back to the global default. */
function getPrefix(guildId) {
  const row = getSettings(guildId);
  const prefix = row?.prefix;
  return typeof prefix === 'string' && prefix.length > 0 ? prefix : DEFAULT_PREFIX;
}

function setPrefix(guildId, prefix) {
  return updateSettings(guildId, { prefix });
}

/** Atomically allocates the next moderation case number for a guild. */
function nextCaseNumber(guildId) {
  return transaction(() => {
    ensureSettings(guildId);
    prepare(
      'UPDATE guild_settings SET case_counter = case_counter + 1, updated_at = ? WHERE guild_id = ?',
    ).run(Date.now(), guildId);
    return Number(
      prepare('SELECT case_counter FROM guild_settings WHERE guild_id = ?').get(guildId).case_counter,
    );
  });
}

module.exports = {
  getSettings,
  ensureSettings,
  updateSettings,
  getPrefix,
  setPrefix,
  nextCaseNumber,
};
