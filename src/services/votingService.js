'use strict';

const suggestionRepository = require('../database/suggestions');
const voteRepository = require('../database/votes');
const { createLogger } = require('../utils/logger');
const suggestionService = require('./suggestionService');
const { STATUSES } = require('../config');

const log = createLogger('voting');

/**
 * Voting rules.
 *
 * The database is the only source of truth (no reactions). Each press runs
 * inside the per-suggestion lock so the recount and the message edit that
 * follows it cannot interleave with another press on the same suggestion.
 */

const FEEDBACK = {
  added: {
    UP: 'Your 👍 upvote has been counted.',
    DOWN: 'Your 👎 downvote has been counted.',
  },
  switched: {
    UP: 'Changed your vote to 👍 **upvote**.',
    DOWN: 'Changed your vote to 👎 **downvote**.',
  },
  removed: {
    UP: 'Your 👍 upvote has been removed.',
    DOWN: 'Your 👎 downvote has been removed.',
  },
};

/**
 * Handles one vote button press.
 *
 * @returns `{ ok, message, counts?, action? }` -- `message` is safe to show
 *   to the member verbatim in an ephemeral reply.
 */
async function castVote(guild, { suggestionId, userId, voteType }) {
  const suggestion = suggestionRepository.getSuggestionById(suggestionId);

  if (!suggestion) {
    return { ok: false, message: 'That suggestion no longer exists.' };
  }
  if (suggestion.guild_id !== guild.id) {
    return { ok: false, message: 'That suggestion belongs to a different server.' };
  }
  if (suggestion.status === STATUSES.DUPLICATE.key) {
    return { ok: false, message: 'Voting is closed on suggestions marked as duplicates.' };
  }

  return suggestionService.withSuggestionLock(suggestionId, async () => {
    let outcome;
    try {
      // Read, write and recount happen in a single IMMEDIATE transaction.
      outcome = voteRepository.applyVote(suggestionId, userId, voteType);
    } catch (error) {
      log.error(`Vote failed (suggestion=${suggestionId}, user=${userId}):`, error);
      return { ok: false, message: 'Something went wrong recording your vote. Please try again.' };
    }

    const sync = await suggestionService.syncSuggestionMessage(guild, suggestionId);

    if (!sync.updated && sync.reason === 'message-deleted') {
      return {
        ok: true,
        counts: outcome.counts,
        action: outcome.action,
        message:
          `${FEEDBACK[outcome.action][voteType]}\n` +
          '_The suggestion message was deleted, so the public totals cannot be refreshed._',
      };
    }

    const { up, down, score } = outcome.counts;
    return {
      ok: true,
      counts: outcome.counts,
      action: outcome.action,
      message:
        `${FEEDBACK[outcome.action][voteType]}\n` +
        `Current totals — 👍 **${up}** · 👎 **${down}** · score **${score >= 0 ? '+' : ''}${score}**.`,
    };
  });
}

/** Current tallies for a suggestion. */
function getCounts(suggestionId) {
  return voteRepository.countVotes(suggestionId);
}

/** The vote a member currently holds on a suggestion, or `null`. */
function getUserVote(suggestionId, userId) {
  return voteRepository.getVote(suggestionId, userId)?.vote_type ?? null;
}

module.exports = { castVote, getCounts, getUserVote };
