'use strict';

const { prepare, transaction } = require('./database');

/**
 * Vote repository. The database -- never Discord reactions -- is the source of
 * truth, and `idx_votes_unique` guarantees at most one row per (suggestion, user).
 */

const UP = 'UP';
const DOWN = 'DOWN';

function getVote(suggestionId, userId) {
  return (
    prepare('SELECT * FROM votes WHERE suggestion_id = ? AND user_id = ?').get(
      suggestionId,
      userId,
    ) ?? null
  );
}

/** Returns `{ up, down, score }` for a suggestion. */
function countVotes(suggestionId) {
  const row = prepare(
    `SELECT
        COALESCE(SUM(CASE WHEN vote_type = 'UP'   THEN 1 ELSE 0 END), 0) AS up,
        COALESCE(SUM(CASE WHEN vote_type = 'DOWN' THEN 1 ELSE 0 END), 0) AS down
       FROM votes
      WHERE suggestion_id = ?`,
  ).get(suggestionId);

  const up = Number(row?.up ?? 0);
  const down = Number(row?.down ?? 0);
  return { up, down, score: up - down };
}

/**
 * Applies a vote press and returns `{ action, vote, counts }`.
 *
 * - no existing vote        -> 'added'
 * - same vote pressed again -> 'removed' (toggle off)
 * - opposite vote pressed   -> 'switched'
 *
 * The read, the write and the recount all happen inside one IMMEDIATE
 * transaction, so two simultaneous presses can never both observe "no vote"
 * and double-insert; the unique index is the final backstop.
 */
function applyVote(suggestionId, userId, voteType) {
  if (voteType !== UP && voteType !== DOWN) {
    throw new TypeError(`Unknown vote type "${voteType}".`);
  }

  return transaction(() => {
    const existing = getVote(suggestionId, userId);
    const now = Date.now();
    let action;

    if (!existing) {
      prepare(
        `INSERT INTO votes (suggestion_id, user_id, vote_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (suggestion_id, user_id)
         DO UPDATE SET vote_type = excluded.vote_type, updated_at = excluded.updated_at`,
      ).run(suggestionId, userId, voteType, now, now);
      action = 'added';
    } else if (existing.vote_type === voteType) {
      prepare('DELETE FROM votes WHERE suggestion_id = ? AND user_id = ?').run(
        suggestionId,
        userId,
      );
      action = 'removed';
    } else {
      prepare(
        'UPDATE votes SET vote_type = ?, updated_at = ? WHERE suggestion_id = ? AND user_id = ?',
      ).run(voteType, now, suggestionId, userId);
      action = 'switched';
    }

    return {
      action,
      vote: action === 'removed' ? null : voteType,
      counts: countVotes(suggestionId),
    };
  });
}

/** Removes every vote a user cast in a guild (used when they leave the server). */
function deleteVotesForUser(guildId, userId) {
  const result = prepare(
    `DELETE FROM votes
      WHERE user_id = ?
        AND suggestion_id IN (SELECT id FROM suggestions WHERE guild_id = ?)`,
  ).run(userId, guildId);
  return Number(result.changes ?? 0);
}

module.exports = { UP, DOWN, getVote, countVotes, applyVote, deleteVotesForUser };
