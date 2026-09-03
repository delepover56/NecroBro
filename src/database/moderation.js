'use strict';

const { prepare, transaction } = require('./database');
const { nextCaseNumber } = require('./settings');

/**
 * Moderation repository: numbered cases, warnings, role-based mutes and
 * temporary bans. Everything here is per guild and survives restarts, which is
 * what lets a mute follow a member who leaves and rejoins.
 */

function parseJson(text, fallback) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

function hydrateCase(row) {
  if (!row) return null;
  return { ...row, metadata: parseJson(row.metadata, null) };
}

/** Creates a case with the next per-guild case number. Atomic. */
function createCase({
  guildId,
  action,
  targetId = null,
  moderatorId,
  reason = null,
  durationMs = null,
  expiresAt = null,
  metadata = null,
}) {
  return transaction(() => {
    const caseNumber = nextCaseNumber(guildId);
    const result = prepare(
      `INSERT INTO moderation_cases
        (guild_id, case_number, action, target_id, moderator_id, reason,
         duration_ms, expires_at, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      guildId,
      caseNumber,
      action,
      targetId,
      moderatorId,
      reason,
      durationMs,
      expiresAt,
      metadata ? JSON.stringify(metadata) : null,
      Date.now(),
    );
    return getCaseById(Number(result.lastInsertRowid));
  });
}

function getCaseById(id) {
  return hydrateCase(prepare('SELECT * FROM moderation_cases WHERE id = ?').get(id));
}

function getCaseByNumber(guildId, caseNumber) {
  return hydrateCase(
    prepare('SELECT * FROM moderation_cases WHERE guild_id = ? AND case_number = ?').get(
      guildId,
      caseNumber,
    ),
  );
}

function setCaseLogMessage(id, messageId) {
  prepare('UPDATE moderation_cases SET log_message_id = ? WHERE id = ?').run(messageId, id);
}

function listCasesForUser(guildId, userId, { limit = 25 } = {}) {
  return prepare(
    `SELECT * FROM moderation_cases
      WHERE guild_id = ? AND target_id = ?
      ORDER BY case_number DESC LIMIT ?`,
  )
    .all(guildId, userId, limit)
    .map(hydrateCase);
}

/* ------------------------------------------------------------------ *
 * Warnings
 * ------------------------------------------------------------------ */

function addWarning({ guildId, userId, moderatorId, reason = null, caseId = null, source = 'MANUAL' }) {
  const result = prepare(
    `INSERT INTO warnings (guild_id, user_id, moderator_id, reason, case_id, source, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(guildId, userId, moderatorId, reason, caseId, source, Date.now());
  return getWarningById(Number(result.lastInsertRowid));
}

function getWarningById(id) {
  return prepare('SELECT * FROM warnings WHERE id = ?').get(id) ?? null;
}

function listWarnings(guildId, userId, { activeOnly = true, limit = 50 } = {}) {
  return prepare(
    `SELECT * FROM warnings
      WHERE guild_id = ? AND user_id = ? ${activeOnly ? 'AND active = 1' : ''}
      ORDER BY created_at DESC LIMIT ?`,
  ).all(guildId, userId, limit);
}

function countActiveWarnings(guildId, userId) {
  const row = prepare(
    'SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1',
  ).get(guildId, userId);
  return Number(row?.n ?? 0);
}

/** Deactivates one warning by ID (scoped to the guild). Returns true when found. */
function clearWarning(guildId, warningId, clearedBy) {
  const result = prepare(
    `UPDATE warnings SET active = 0, cleared_at = ?, cleared_by = ?
      WHERE guild_id = ? AND id = ? AND active = 1`,
  ).run(Date.now(), clearedBy, guildId, warningId);
  return Number(result.changes ?? 0) > 0;
}

/** Deactivates every active warning for a member. Returns how many were cleared. */
function clearWarnings(guildId, userId, clearedBy) {
  const result = prepare(
    `UPDATE warnings SET active = 0, cleared_at = ?, cleared_by = ?
      WHERE guild_id = ? AND user_id = ? AND active = 1`,
  ).run(Date.now(), clearedBy, guildId, userId);
  return Number(result.changes ?? 0);
}

/* ------------------------------------------------------------------ *
 * Mutes (role based, persistent)
 * ------------------------------------------------------------------ */

function getActiveMute(guildId, userId) {
  return (
    prepare('SELECT * FROM mutes WHERE guild_id = ? AND user_id = ? AND active = 1').get(
      guildId,
      userId,
    ) ?? null
  );
}

/**
 * Records a mute. If the member already has an active mute the existing record
 * is replaced (released with reason 'REPLACED') so the unique index holds.
 */
function createMute({ guildId, userId, muteRoleId, moderatorId, reason = null, caseId = null, muteUntil = null }) {
  return transaction(() => {
    const now = Date.now();
    prepare(
      `UPDATE mutes SET active = 0, released_at = ?, release_reason = 'REPLACED'
        WHERE guild_id = ? AND user_id = ? AND active = 1`,
    ).run(now, guildId, userId);

    const result = prepare(
      `INSERT INTO mutes
        (guild_id, user_id, mute_role_id, moderator_id, reason, case_id, muted_at, mute_until, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(guildId, userId, muteRoleId, moderatorId, reason, caseId, now, muteUntil);
    return prepare('SELECT * FROM mutes WHERE id = ?').get(Number(result.lastInsertRowid));
  });
}

/** Marks the active mute for a member released. Returns the record, or null. */
function releaseMute(guildId, userId, releaseReason = 'UNMUTED') {
  return transaction(() => {
    const record = getActiveMute(guildId, userId);
    if (!record) return null;
    prepare('UPDATE mutes SET active = 0, released_at = ?, release_reason = ? WHERE id = ?').run(
      Date.now(),
      releaseReason,
      record.id,
    );
    return { ...record, active: 0, release_reason: releaseReason };
  });
}

/** Active mutes whose expiry has passed (across all guilds). */
function listExpiredMutes(now = Date.now()) {
  return prepare(
    'SELECT * FROM mutes WHERE active = 1 AND mute_until IS NOT NULL AND mute_until <= ?',
  ).all(now);
}

function listActiveMutes(guildId) {
  return prepare('SELECT * FROM mutes WHERE guild_id = ? AND active = 1').all(guildId);
}

/* ------------------------------------------------------------------ *
 * Temporary bans
 * ------------------------------------------------------------------ */

function createTempBan({ guildId, userId, moderatorId, reason = null, caseId = null, unbanAt }) {
  return transaction(() => {
    const now = Date.now();
    prepare(
      'UPDATE temp_bans SET active = 0, released_at = ? WHERE guild_id = ? AND user_id = ? AND active = 1',
    ).run(now, guildId, userId);
    const result = prepare(
      `INSERT INTO temp_bans (guild_id, user_id, moderator_id, reason, case_id, banned_at, unban_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(guildId, userId, moderatorId, reason, caseId, now, unbanAt);
    return prepare('SELECT * FROM temp_bans WHERE id = ?').get(Number(result.lastInsertRowid));
  });
}

function releaseTempBan(guildId, userId) {
  const result = prepare(
    'UPDATE temp_bans SET active = 0, released_at = ? WHERE guild_id = ? AND user_id = ? AND active = 1',
  ).run(Date.now(), guildId, userId);
  return Number(result.changes ?? 0) > 0;
}

function listExpiredTempBans(now = Date.now()) {
  return prepare('SELECT * FROM temp_bans WHERE active = 1 AND unban_at <= ?').all(now);
}

module.exports = {
  createCase,
  getCaseById,
  getCaseByNumber,
  setCaseLogMessage,
  listCasesForUser,
  addWarning,
  getWarningById,
  listWarnings,
  countActiveWarnings,
  clearWarning,
  clearWarnings,
  getActiveMute,
  createMute,
  releaseMute,
  listExpiredMutes,
  listActiveMutes,
  createTempBan,
  releaseTempBan,
  listExpiredTempBans,
};
