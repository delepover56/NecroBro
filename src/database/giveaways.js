'use strict';

const { prepare, transaction } = require('./database');

/**
 * Giveaway repository (tables `giveaways` + `giveaway_entries`, migration 3).
 *
 * Every lifecycle transition (end, cancel, reroll) is a guarded UPDATE that
 * only succeeds from the expected status, executed inside a transaction with
 * the reads it depends on. That is what makes "end" idempotent: two callers
 * racing to end the same giveaway cannot both draw winners.
 */

const STATUS = Object.freeze({ ACTIVE: 'ACTIVE', ENDED: 'ENDED', CANCELLED: 'CANCELLED' });
const TYPES = Object.freeze(['DISCORD', 'SURVIVAL']);

function parseJson(text, fallback) {
  if (typeof text !== 'string') return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    winner_count: Number(row.winner_count),
    reroll_count: Number(row.reroll_count ?? 0),
    ends_at: Number(row.ends_at),
    ended_at: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    entry_count: row.entry_count === undefined ? undefined : Number(row.entry_count),
    winners: parseJson(row.winners, []),
    audit: parseJson(row.audit, []),
  };
}

const WITH_COUNT =
  'g.*, (SELECT COUNT(*) FROM giveaway_entries e WHERE e.giveaway_id = g.id) AS entry_count';

/* ------------------------------------------------------------------ *
 * Giveaways
 * ------------------------------------------------------------------ */

function createGiveaway({ guildId, channelId, type, prize, winnerCount, creatorId, endsAt, messageId = null }) {
  if (!TYPES.includes(type)) throw new TypeError(`Unknown giveaway type "${type}".`);
  const now = Date.now();
  const result = prepare(
    `INSERT INTO giveaways
      (guild_id, channel_id, message_id, type, prize, winner_count, creator_id, status,
       ends_at, winners, reroll_count, audit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, '[]', 0, '[]', ?, ?)`,
  ).run(guildId, channelId, messageId, type, prize, winnerCount, creatorId, endsAt, now, now);
  return getGiveaway(Number(result.lastInsertRowid));
}

function getGiveaway(id) {
  return hydrate(prepare(`SELECT ${WITH_COUNT} FROM giveaways g WHERE g.id = ?`).get(id));
}

/** A giveaway by ID, scoped to a guild so IDs from other servers never resolve. */
function getGiveawayInGuild(guildId, id) {
  return hydrate(
    prepare(`SELECT ${WITH_COUNT} FROM giveaways g WHERE g.id = ? AND g.guild_id = ?`).get(id, guildId),
  );
}

function getGiveawayByMessage(messageId) {
  if (!messageId) return null;
  return hydrate(
    prepare(`SELECT ${WITH_COUNT} FROM giveaways g WHERE g.message_id = ?`).get(messageId),
  );
}

function setMessageId(id, messageId) {
  prepare('UPDATE giveaways SET message_id = ?, updated_at = ? WHERE id = ?').run(messageId, Date.now(), id);
}

/** Hard-deletes a giveaway (entries cascade). Only used when posting failed. */
function deleteGiveaway(id) {
  const result = prepare('DELETE FROM giveaways WHERE id = ?').run(id);
  return Number(result.changes ?? 0) > 0;
}

/** Active giveaways in a guild, soonest ending first, with entry counts. */
function listActive(guildId) {
  return prepare(
    `SELECT ${WITH_COUNT} FROM giveaways g
      WHERE g.guild_id = ? AND g.status = 'ACTIVE'
      ORDER BY g.ends_at ASC, g.id ASC`,
  )
    .all(guildId)
    .map(hydrate);
}

function listActiveInChannel(channelId) {
  return prepare(
    `SELECT ${WITH_COUNT} FROM giveaways g WHERE g.channel_id = ? AND g.status = 'ACTIVE' ORDER BY g.id ASC`,
  )
    .all(channelId)
    .map(hydrate);
}

/** Active giveaways whose end time has passed (across all guilds). */
function listDue(now = Date.now()) {
  return prepare(
    `SELECT ${WITH_COUNT} FROM giveaways g
      WHERE g.status = 'ACTIVE' AND g.ends_at <= ?
      ORDER BY g.ends_at ASC, g.id ASC`,
  )
    .all(now)
    .map(hydrate);
}

/* ------------------------------------------------------------------ *
 * Entries
 * ------------------------------------------------------------------ */

/** Adds an entry. Returns false when the user was already entered. */
function addEntry(giveawayId, userId) {
  const result = prepare(
    'INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, created_at) VALUES (?, ?, ?)',
  ).run(giveawayId, userId, Date.now());
  return Number(result.changes ?? 0) > 0;
}

/** Removes an entry. Returns false when the user was not entered. */
function removeEntry(giveawayId, userId) {
  const result = prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').run(
    giveawayId,
    userId,
  );
  return Number(result.changes ?? 0) > 0;
}

function hasEntry(giveawayId, userId) {
  return Boolean(
    prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').get(giveawayId, userId),
  );
}

function countEntries(giveawayId) {
  const row = prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?').get(giveawayId);
  return Number(row?.n ?? 0);
}

/** Every entered user ID, in join order. */
function listEntries(giveawayId) {
  return prepare(
    'SELECT user_id FROM giveaway_entries WHERE giveaway_id = ? ORDER BY created_at ASC, user_id ASC',
  )
    .all(giveawayId)
    .map((row) => String(row.user_id));
}

/* ------------------------------------------------------------------ *
 * Lifecycle transitions (status-guarded, atomic)
 * ------------------------------------------------------------------ */

function appendAudit(row, entry) {
  return JSON.stringify([...(row.audit ?? []), entry]);
}

/**
 * ACTIVE -> ENDED with the drawn winners. Returns the updated row, or null when
 * the giveaway was not ACTIVE any more (someone else ended/cancelled it first).
 */
function finish(id, { winners, auditEntry, endedAt = Date.now() }) {
  return transaction(() => {
    const row = getGiveaway(id);
    if (!row || row.status !== STATUS.ACTIVE) return null;
    const result = prepare(
      `UPDATE giveaways
          SET status = 'ENDED', ended_at = ?, winners = ?, audit = ?, updated_at = ?
        WHERE id = ? AND status = 'ACTIVE'`,
    ).run(endedAt, JSON.stringify(winners), appendAudit(row, auditEntry), Date.now(), id);
    return Number(result.changes ?? 0) > 0 ? getGiveaway(id) : null;
  });
}

/** ACTIVE -> CANCELLED. Returns the updated row, or null when it was not ACTIVE. */
function cancel(id, auditEntry, cancelledAt = Date.now()) {
  return transaction(() => {
    const row = getGiveaway(id);
    if (!row || row.status !== STATUS.ACTIVE) return null;
    const result = prepare(
      `UPDATE giveaways
          SET status = 'CANCELLED', ended_at = ?, audit = ?, updated_at = ?
        WHERE id = ? AND status = 'ACTIVE'`,
    ).run(cancelledAt, appendAudit(row, auditEntry), Date.now(), id);
    return Number(result.changes ?? 0) > 0 ? getGiveaway(id) : null;
  });
}

/** ENDED -> ENDED with new winners and reroll_count + 1. Null when not ENDED. */
function reroll(id, { winners, auditEntry }) {
  return transaction(() => {
    const row = getGiveaway(id);
    if (!row || row.status !== STATUS.ENDED) return null;
    const result = prepare(
      `UPDATE giveaways
          SET winners = ?, reroll_count = reroll_count + 1, audit = ?, updated_at = ?
        WHERE id = ? AND status = 'ENDED'`,
    ).run(JSON.stringify(winners), appendAudit(row, auditEntry), Date.now(), id);
    return Number(result.changes ?? 0) > 0 ? getGiveaway(id) : null;
  });
}

module.exports = {
  STATUS,
  TYPES,
  createGiveaway,
  getGiveaway,
  getGiveawayInGuild,
  getGiveawayByMessage,
  setMessageId,
  deleteGiveaway,
  listActive,
  listActiveInChannel,
  listDue,
  addEntry,
  removeEntry,
  hasEntry,
  countEntries,
  listEntries,
  finish,
  cancel,
  reroll,
};
