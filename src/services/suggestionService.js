'use strict';

const { CATEGORIES, LIMITS, getStatus } = require('../config');
const configRepository = require('../database/config');
const suggestionRepository = require('../database/suggestions');
const voteRepository = require('../database/votes');
const { buildSuggestionComponents, buildSuggestionEmbed, formatNumber } = require('../utils/embeds');
const { createLogger } = require('../utils/logger');
const channelService = require('./channelService');

const log = createLogger('suggestions');

/**
 * Suggestion lifecycle: validation, publishing, status changes and keeping the
 * published Discord message in sync with the database row.
 */

/* ------------------------------------------------------------------ *
 * Per-suggestion serialisation
 * ------------------------------------------------------------------ */

const locks = new Map();

/**
 * Serialises work per suggestion ID.
 *
 * SQLite transactions already make the *data* safe; this queue additionally
 * makes the *message edits* ordered, so two near-simultaneous votes can never
 * write vote counts to Discord out of order.
 */
function withSuggestionLock(suggestionId, task) {
  const key = String(suggestionId);
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);

  // The queued tail always settles successfully, so one failed task never
  // rejects the next waiter -- and the entry is dropped once the queue drains.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });

  return result;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const VALID_CATEGORIES = new Set(CATEGORIES.map((category) => category.value));

/**
 * Validates raw modal input.
 * Returns `{ ok, errors, values }` -- callers turn `errors` into an ephemeral reply.
 */
function validateSuggestionInput({ title, category, description }) {
  const errors = [];

  const cleanTitle = String(title ?? '').trim().replace(/\s+/g, ' ');
  const cleanDescription = String(description ?? '').trim();
  const cleanCategory = String(category ?? '').trim().toUpperCase();

  if (cleanTitle.length < LIMITS.titleMin) {
    errors.push(`The title must be at least **${LIMITS.titleMin}** characters.`);
  } else if (cleanTitle.length > LIMITS.titleMax) {
    errors.push(`The title must be **${LIMITS.titleMax}** characters or fewer.`);
  }

  if (!VALID_CATEGORIES.has(cleanCategory)) {
    errors.push('Please pick a category from the list.');
  }

  if (cleanDescription.length < LIMITS.descriptionMin) {
    errors.push(
      `The description must be at least **${LIMITS.descriptionMin}** characters ` +
        `(you wrote ${cleanDescription.length}).`,
    );
  } else if (cleanDescription.length > LIMITS.descriptionMax) {
    errors.push(`The description must be **${LIMITS.descriptionMax}** characters or fewer.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    values: { title: cleanTitle, category: cleanCategory, description: cleanDescription },
  };
}

/* ------------------------------------------------------------------ *
 * Publishing
 * ------------------------------------------------------------------ */

/** Thrown for problems the user can act on (bad config, missing channel). */
class SuggestionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SuggestionError';
    this.userFacing = true;
  }
}

/**
 * Creates the database row, posts the embed in the voting channel and links
 * the two. If Discord rejects the post, the row is rolled back so suggestion
 * numbers do not point at messages that never existed.
 */
async function publishSuggestion(
  guild,
  { authorId, authorUsername, authorAvatarUrl, title, category, description },
) {
  const config = configRepository.getGuildConfig(guild.id);
  if (!config?.voting_channel_id) {
    throw new SuggestionError(
      'The suggestion system is not configured yet. Ask a staff member to run `/setup-suggestions`.',
    );
  }

  const channel = await channelService.fetchChannel(guild, config.voting_channel_id);
  if (!channel?.isTextBased()) {
    throw new SuggestionError(
      'The suggestion voting channel is missing. Ask a staff member to run `/setup-suggestions` again.',
    );
  }

  const suggestion = suggestionRepository.createSuggestion({
    guildId: guild.id,
    authorId,
    authorUsername,
    authorAvatarUrl,
    title,
    category,
    description,
  });

  const counts = { up: 0, down: 0, score: 0 };

  try {
    const message = await channel.send({
      embeds: [buildSuggestionEmbed(suggestion, counts)],
      components: buildSuggestionComponents(suggestion, counts),
    });

    const linked = suggestionRepository.attachMessage(suggestion.id, {
      messageId: message.id,
      channelId: channel.id,
    });

    log.info(
      `Published suggestion ${formatNumber(linked.suggestion_number)} ` +
        `(id=${linked.id}) by ${authorId} in guild ${guild.id}.`,
    );

    return { suggestion: linked, message };
  } catch (error) {
    suggestionRepository.deleteSuggestion(suggestion.id);
    log.error(`Failed to publish suggestion ${suggestion.id}; rolled back the row:`, error);
    throw new SuggestionError(
      'I could not post your suggestion in the voting channel. ' +
        'Please check my permissions there and try again.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Message synchronisation
 * ------------------------------------------------------------------ */

/**
 * Rewrites a suggestion's published message from the current database state.
 * Returns `{ updated, reason }`; a deleted message clears the stored pointer
 * instead of throwing, so the rest of the interaction can still succeed.
 */
async function syncSuggestionMessage(guild, suggestionId) {
  const suggestion = suggestionRepository.getSuggestionById(suggestionId);
  if (!suggestion) return { updated: false, reason: 'unknown-suggestion' };
  if (!suggestion.message_id || !suggestion.channel_id) {
    return { updated: false, reason: 'not-published' };
  }

  const channel = await channelService.fetchChannel(guild, suggestion.channel_id);
  if (!channel?.isTextBased()) {
    suggestionRepository.detachMessage(suggestion.id);
    return { updated: false, reason: 'channel-deleted' };
  }

  const counts = voteRepository.countVotes(suggestion.id);

  try {
    const message = await channel.messages.fetch(suggestion.message_id);
    await message.edit({
      embeds: [buildSuggestionEmbed(suggestion, counts)],
      components: buildSuggestionComponents(suggestion, counts),
    });
    return { updated: true, message, suggestion, counts };
  } catch (error) {
    if (channelService.isGone(error)) {
      suggestionRepository.detachMessage(suggestion.id);
      log.warn(`Suggestion message ${suggestion.message_id} no longer exists; unlinked it.`);
      return { updated: false, reason: 'message-deleted' };
    }
    log.error(`Failed to update suggestion message ${suggestion.message_id}:`, error);
    return { updated: false, reason: 'api-error', error };
  }
}

/* ------------------------------------------------------------------ *
 * Staff status changes
 * ------------------------------------------------------------------ */

/**
 * Applies a staff status change and updates the original message in place --
 * never posting a second copy of the suggestion.
 */
async function changeStatus(guild, suggestionId, { status, staffResponse, staffResponderId }) {
  return withSuggestionLock(suggestionId, async () => {
    const current = suggestionRepository.getSuggestionById(suggestionId);
    if (!current) throw new SuggestionError('That suggestion no longer exists.');

    const previous = getStatus(current.status);
    const updated = suggestionRepository.updateStatus(suggestionId, {
      status,
      staffResponse: staffResponse || null,
      staffResponderId: staffResponderId ?? null,
    });

    const sync = await syncSuggestionMessage(guild, suggestionId);
    const next = getStatus(updated.status);

    await channelService.sendStaffLog(guild, {
      title: `${next.emoji} Suggestion ${formatNumber(updated.suggestion_number)} — ${next.label}`,
      color: next.color,
      description: `**${updated.title}**`,
      fields: [
        { name: 'Changed by', value: `<@${staffResponderId}>`, inline: true },
        { name: 'Previous status', value: `${previous.emoji} ${previous.label}`, inline: true },
        { name: 'Author', value: `<@${updated.author_id}>`, inline: true },
        ...(staffResponse ? [{ name: 'Response', value: staffResponse }] : []),
      ],
    });

    return { suggestion: updated, sync, previous, next };
  });
}

/** Convenience accessor used by interaction handlers. */
function getSuggestion(suggestionId) {
  return suggestionRepository.getSuggestionById(suggestionId);
}

module.exports = {
  SuggestionError,
  validateSuggestionInput,
  publishSuggestion,
  syncSuggestionMessage,
  changeStatus,
  getSuggestion,
  withSuggestionLock,
};
