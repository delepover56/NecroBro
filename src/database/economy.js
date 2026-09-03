'use strict';

const { prepare, transaction } = require('./database');

/**
 * Economy repository: per-guild wallets, XP/levels, chat bookkeeping, keyed
 * cooldowns and the transaction ledger (tables from migration 3).
 *
 * Rows in `economy_users` are only created when something is actually
 * recorded for a member (a reward, a claim, a bet), so read-only lookups such
 * as `balance @someone` never pollute the leaderboards with empty rows.
 * `getUser()` returns `null` for unknown members; callers render defaults.
 *
 * Ordering used for every board (also used to compute positions):
 *   wealth  cash DESC, xp DESC, user_id ASC
 *   rank    level DESC, xp DESC, user_id ASC
 *   top     computed in JS from `listScoreInputs()` (see services/rankService)
 */

class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient funds.') {
    super(message);
    this.name = 'InsufficientFundsError';
    this.userFacing = true;
  }
}

const SQL = {
  select: 'SELECT * FROM economy_users WHERE guild_id = ? AND user_id = ?',
  insert: `INSERT OR IGNORE INTO economy_users (guild_id, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
};

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

function getUser(guildId, userId) {
  return prepare(SQL.select).get(guildId, userId) ?? null;
}

/** Returns the row, creating an empty one on first use. */
function ensureUser(guildId, userId) {
  const existing = getUser(guildId, userId);
  if (existing) return existing;
  const now = Date.now();
  prepare(SQL.insert).run(guildId, userId, now, now);
  return getUser(guildId, userId);
}

/** Columns a caller may patch through `updateUser`. Everything else is derived. */
const PATCHABLE = new Set([
  'last_daily_at',
  'daily_streak',
  'last_work_at',
  'last_beg_at',
  'last_chat_reward_at',
  'last_message_hash',
]);

/** Partially updates bookkeeping columns. Unknown keys are ignored. */
function updateUser(guildId, userId, patch) {
  return transaction(() => {
    ensureUser(guildId, userId);
    const assignments = [];
    const values = [];
    for (const [column, value] of Object.entries(patch ?? {})) {
      if (!PATCHABLE.has(column)) continue;
      assignments.push(`${column} = ?`);
      values.push(value === undefined ? null : value);
    }
    if (assignments.length > 0) {
      assignments.push('updated_at = ?');
      values.push(Date.now(), guildId, userId);
      prepare(
        `UPDATE economy_users SET ${assignments.join(', ')} WHERE guild_id = ? AND user_id = ?`,
      ).run(...values);
    }
    return getUser(guildId, userId);
  });
}

/**
 * Atomically moves `amount` (positive = credit, negative = debit) and writes a
 * ledger row. A debit that would take the balance below zero throws an
 * `InsufficientFundsError` (user-facing) and changes nothing.
 * `lifetime_cash` only ever grows, and only on credits.
 */
function adjustCash(guildId, userId, amount, reason) {
  const delta = Math.trunc(Number(amount));
  if (!Number.isFinite(delta)) throw new TypeError('adjustCash: amount must be a finite number.');
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError('adjustCash: reason is required.');
  }

  return transaction(() => {
    const user = ensureUser(guildId, userId);
    const before = Number(user.cash);
    const after = before + delta;
    if (after < 0) throw new InsufficientFundsError();

    const now = Date.now();
    prepare(
      `UPDATE economy_users
          SET cash = ?, lifetime_cash = lifetime_cash + ?, updated_at = ?
        WHERE guild_id = ? AND user_id = ?`,
    ).run(after, delta > 0 ? delta : 0, now, guildId, userId);

    prepare(
      `INSERT INTO economy_transactions (guild_id, user_id, amount, balance_after, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(guildId, userId, delta, after, reason, now);

    return { before, after, amount: delta, user: getUser(guildId, userId) };
  });
}

/** Adds total XP. Level is not touched here; call `setLevel` with the derived value. */
function addXp(guildId, userId, amount) {
  const delta = Math.max(0, Math.trunc(Number(amount) || 0));
  return transaction(() => {
    ensureUser(guildId, userId);
    prepare(
      'UPDATE economy_users SET xp = xp + ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    ).run(delta, Date.now(), guildId, userId);
    return getUser(guildId, userId);
  });
}

function setLevel(guildId, userId, level) {
  return transaction(() => {
    ensureUser(guildId, userId);
    prepare(
      'UPDATE economy_users SET level = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    ).run(Math.max(0, Math.trunc(Number(level) || 0)), Date.now(), guildId, userId);
    return getUser(guildId, userId);
  });
}

function incrementMessages(guildId, userId) {
  return transaction(() => {
    ensureUser(guildId, userId);
    prepare(
      `UPDATE economy_users SET message_count = message_count + 1, updated_at = ?
        WHERE guild_id = ? AND user_id = ?`,
    ).run(Date.now(), guildId, userId);
    return getUser(guildId, userId);
  });
}

/* ------------------------------------------------------------------ *
 * Keyed cooldowns (minigames etc.)
 * ------------------------------------------------------------------ */

/** Expiry (ms) of an active cooldown, or `null` when none / already expired. */
function getCooldown(guildId, userId, key, now = Date.now()) {
  const row = prepare(
    'SELECT expires_at FROM economy_cooldowns WHERE guild_id = ? AND user_id = ? AND key = ?',
  ).get(guildId, userId, key);
  if (!row) return null;
  const expiresAt = Number(row.expires_at);
  return expiresAt > now ? expiresAt : null;
}

function setCooldown(guildId, userId, key, expiresAt) {
  prepare(
    `INSERT INTO economy_cooldowns (guild_id, user_id, key, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id, key) DO UPDATE SET expires_at = excluded.expires_at`,
  ).run(guildId, userId, key, Math.trunc(expiresAt));
  return expiresAt;
}

function clearCooldown(guildId, userId, key) {
  const result = prepare(
    'DELETE FROM economy_cooldowns WHERE guild_id = ? AND user_id = ? AND key = ?',
  ).run(guildId, userId, key);
  return Number(result.changes ?? 0) > 0;
}

/** Deletes every expired cooldown row (all guilds). Returns how many were removed. */
function sweepCooldowns(now = Date.now()) {
  const result = prepare('DELETE FROM economy_cooldowns WHERE expires_at <= ?').run(now);
  return Number(result.changes ?? 0);
}

/* ------------------------------------------------------------------ *
 * Leaderboards
 * ------------------------------------------------------------------ */

function clampPage(offset, limit) {
  return [Math.max(0, Math.trunc(Number(offset) || 0)), Math.max(1, Math.trunc(Number(limit) || 10))];
}

function topByCash(guildId, offset = 0, limit = 10) {
  const [skip, take] = clampPage(offset, limit);
  return prepare(
    `SELECT user_id, cash, xp, level, message_count FROM economy_users
      WHERE guild_id = ?
      ORDER BY cash DESC, xp DESC, user_id ASC
      LIMIT ? OFFSET ?`,
  ).all(guildId, take, skip);
}

function topByRank(guildId, offset = 0, limit = 10) {
  const [skip, take] = clampPage(offset, limit);
  return prepare(
    `SELECT user_id, cash, xp, level, message_count FROM economy_users
      WHERE guild_id = ?
      ORDER BY level DESC, xp DESC, user_id ASC
      LIMIT ? OFFSET ?`,
  ).all(guildId, take, skip);
}

function countUsers(guildId) {
  const row = prepare('SELECT COUNT(*) AS n FROM economy_users WHERE guild_id = ?').get(guildId);
  return Number(row?.n ?? 0);
}

/** Every member's score inputs for the Top board (guilds are small; sorted in JS). */
function listScoreInputs(guildId) {
  return prepare(
    'SELECT user_id, cash, xp, level FROM economy_users WHERE guild_id = ?',
  ).all(guildId);
}

/**
 * 1-based position of a member on the wealth or rank board, or `null` when
 * they have no row. Uses the same ordering as the page queries so a position
 * always matches what the board shows.
 */
function rankPosition(guildId, userId, board = 'wealth') {
  const user = getUser(guildId, userId);
  if (!user) return null;

  const ahead =
    board === 'rank'
      ? prepare(
          `SELECT COUNT(*) AS n FROM economy_users
            WHERE guild_id = ?
              AND (level > ?
                OR (level = ? AND xp > ?)
                OR (level = ? AND xp = ? AND user_id < ?))`,
        ).get(guildId, user.level, user.level, user.xp, user.level, user.xp, userId)
      : prepare(
          `SELECT COUNT(*) AS n FROM economy_users
            WHERE guild_id = ?
              AND (cash > ?
                OR (cash = ? AND xp > ?)
                OR (cash = ? AND xp = ? AND user_id < ?))`,
        ).get(guildId, user.cash, user.cash, user.xp, user.cash, user.xp, userId);

  return Number(ahead?.n ?? 0) + 1;
}

/** Most recent ledger rows for a member (newest first). */
function listTransactions(guildId, userId, { limit = 10 } = {}) {
  return prepare(
    `SELECT * FROM economy_transactions WHERE guild_id = ? AND user_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(guildId, userId, Math.max(1, Math.trunc(limit)));
}

module.exports = {
  InsufficientFundsError,
  getUser,
  ensureUser,
  updateUser,
  adjustCash,
  addXp,
  setLevel,
  incrementMessages,
  getCooldown,
  setCooldown,
  clearCooldown,
  sweepCooldowns,
  topByCash,
  topByRank,
  countUsers,
  listScoreInputs,
  rankPosition,
  listTransactions,
};
