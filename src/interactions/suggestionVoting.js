'use strict';

const { IDS } = require('../config');
const votingService = require('../services/votingService');
const { createLogger } = require('../utils/logger');
const { deferEphemeral, failure, success } = require('../utils/respond');

const log = createLogger('voting:interaction');

/**
 * `👍 Upvote` / `👎 Downvote`.
 *
 * Custom ID shape: `sg:vote:<UP|DOWN>:<suggestionId>` -- the suggestion is
 * identified by its database ID, so votes survive the message being re-posted.
 */
async function handleVote(interaction, [voteType, rawSuggestionId]) {
  const suggestionId = Number.parseInt(rawSuggestionId, 10);

  if (!Number.isInteger(suggestionId) || (voteType !== 'UP' && voteType !== 'DOWN')) {
    log.warn(`Malformed vote custom ID: ${interaction.customId}`);
    return failure(interaction, 'That vote button is malformed. Please let staff know.');
  }

  if (!(await deferEphemeral(interaction))) return undefined;

  const result = await votingService.castVote(interaction.guild, {
    suggestionId,
    userId: interaction.user.id,
    voteType,
  });

  return result.ok
    ? success(interaction, result.message)
    : failure(interaction, result.message);
}

module.exports = {
  buttonPrefixes: {
    [IDS.VOTE]: handleVote,
  },
};
