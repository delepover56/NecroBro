'use strict';

const { prepare, transaction } = require('./database');
const { nextSuggestionNumber } = require('./config');
const { DEFAULT_STATUS } = require('../config');

/** Suggestion repository. All timestamps are epoch milliseconds. */

/**
 * Inserts a suggestion and allocates its sequential number atomically.
 * The Discord message is posted afterwards, then linked with `attachMessage()`.
 */
function createSuggestion({
  guildId,
  authorId,
  authorUsername = null,
  authorAvatarUrl = null,
  title,
  category,
  description,
}) {
  return transaction(() => {
    const number = nextSuggestionNumber(guildId);
    const now = Date.now();

    const result = prepare(
      `INSERT INTO suggestions
        (guild_id, suggestion_number, author_id, author_username, author_avatar_url,
         title, category, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      guildId,
      number,
      authorId,
      authorUsername,
      authorAvatarUrl,
      title,
      category,
      description,
      DEFAULT_STATUS,
      now,
      now,
    );

    return getSuggestionById(Number(result.lastInsertRowid));
  });
}

function getSuggestionById(id) {
  return prepare('SELECT * FROM suggestions WHERE id = ?').get(id) ?? null;
}

function getSuggestionByNumber(guildId, number) {
  return (
    prepare('SELECT * FROM suggestions WHERE guild_id = ? AND suggestion_number = ?').get(
      guildId,
      number,
    ) ?? null
  );
}

function getSuggestionByMessageId(messageId) {
  return prepare('SELECT * FROM suggestions WHERE message_id = ?').get(messageId) ?? null;
}

/** Links a freshly posted Discord message to its suggestion row. */
function attachMessage(id, { messageId, channelId }) {
  prepare(
    'UPDATE suggestions SET message_id = ?, channel_id = ?, updated_at = ? WHERE id = ?',
  ).run(messageId, channelId, Date.now(), id);
  return getSuggestionById(id);
}

/** Clears the message pointer when the suggestion message no longer exists. */
function detachMessage(id) {
  prepare('UPDATE suggestions SET message_id = NULL, updated_at = ? WHERE id = ?').run(
    Date.now(),
    id,
  );
  return getSuggestionById(id);
}

/** Applies a staff status change, optionally recording a written response. */
function updateStatus(id, { status, staffResponse = null, staffResponderId = null }) {
  prepare(
    `UPDATE suggestions
        SET status = ?,
            staff_response = ?,
            staff_responder_id = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(status, staffResponse, staffResponderId, Date.now(), id);
  return getSuggestionById(id);
}

/** Suggestions in a guild that still have a live message, newest first. */
function listSuggestions(guildId, { limit = 50 } = {}) {
  return prepare(
    'SELECT * FROM suggestions WHERE guild_id = ? ORDER BY suggestion_number DESC LIMIT ?',
  ).all(guildId, limit);
}

/** Removes a suggestion (and, by cascade, its votes). Used when publishing fails. */
function deleteSuggestion(id) {
  const result = prepare('DELETE FROM suggestions WHERE id = ?').run(id);
  return Number(result.changes ?? 0) > 0;
}

module.exports = {
  createSuggestion,
  deleteSuggestion,
  getSuggestionById,
  getSuggestionByNumber,
  getSuggestionByMessageId,
  attachMessage,
  detachMessage,
  updateStatus,
  listSuggestions,
};
