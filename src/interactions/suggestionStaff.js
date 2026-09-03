'use strict';

const { LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const { IDS, LIMITS, getStatus } = require('../config');
const suggestionService = require('../services/suggestionService');
const { buildStaffStatusComponents, formatNumber } = require('../utils/embeds');
const { createLogger } = require('../utils/logger');
const { isStaff } = require('../utils/permissions');
const { deferEphemeral, failure, respond, success } = require('../utils/respond');

const log = createLogger('staff');

/**
 * Staff status controls.
 *
 * Flow: `🛠️ Staff Controls` -> ephemeral status picker -> optional response
 * modal -> the original suggestion embed is edited in place.
 */

function parseSuggestionId(raw) {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) ? id : null;
}

/** Shared guard for every staff entry point. */
function assertStaff(interaction) {
  if (isStaff(interaction.member)) return true;
  return false;
}

/** `🛠️ Staff Controls` -- shows the ephemeral status picker. */
async function handleManage(interaction, [rawId]) {
  const suggestionId = parseSuggestionId(rawId);
  if (suggestionId === null) {
    return failure(interaction, 'That button is malformed. Please let an administrator know.');
  }

  if (!assertStaff(interaction)) {
    return failure(interaction, 'Only staff can change a suggestion’s status.');
  }

  const suggestion = suggestionService.getSuggestion(suggestionId);
  if (!suggestion) {
    return failure(interaction, 'That suggestion no longer exists in the database.');
  }

  const status = getStatus(suggestion.status);

  return respond(interaction, {
    content:
      `**${formatNumber(suggestion.suggestion_number)} — ${suggestion.title}**\n` +
      `Current status: ${status.emoji} **${status.label}**\n` +
      'Choose a new status below. You can add an optional response on the next screen.',
    components: buildStaffStatusComponents(suggestion),
  });
}

/** Builds the optional-response modal shown after a status is chosen. */
function buildResponseModal(suggestion, statusKey) {
  const status = getStatus(statusKey);

  const response = new TextInputBuilder()
    .setCustomId(IDS.FIELD_STAFF_RESPONSE)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(LIMITS.staffResponseMax)
    .setPlaceholder('Optional — explain the decision for the community.');

  if (suggestion.staff_response) response.setValue(suggestion.staff_response);

  return new ModalBuilder()
    .setCustomId(`${IDS.STAFF_MODAL}:${suggestion.id}:${statusKey}`)
    .setTitle(`${status.label} — ${formatNumber(suggestion.suggestion_number)}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Staff Response (optional)')
        .setDescription(`Shown on the suggestion embed. Max ${LIMITS.staffResponseMax} characters.`)
        .setTextInputComponent(response),
    );
}

/** Status picker selection -- opens the response modal. */
async function handleSelect(interaction, [rawId]) {
  const suggestionId = parseSuggestionId(rawId);
  if (suggestionId === null) {
    return failure(interaction, 'That menu is malformed. Please let an administrator know.');
  }

  if (!assertStaff(interaction)) {
    return failure(interaction, 'Only staff can change a suggestion’s status.');
  }

  const suggestion = suggestionService.getSuggestion(suggestionId);
  if (!suggestion) {
    return failure(interaction, 'That suggestion no longer exists in the database.');
  }

  const statusKey = interaction.values?.[0];
  if (!statusKey || getStatus(statusKey).key !== statusKey) {
    return failure(interaction, 'Unknown status selected.');
  }

  try {
    await interaction.showModal(buildResponseModal(suggestion, statusKey));
  } catch (error) {
    log.error(`Failed to show the staff response modal for suggestion ${suggestionId}:`, error);
    await failure(interaction, 'I could not open the response form. Please try again.');
  }
  return undefined;
}

/** Response modal submitted -- apply the status change. */
async function handleStatusModal(interaction, [rawId, statusKey]) {
  const suggestionId = parseSuggestionId(rawId);
  if (suggestionId === null || getStatus(statusKey).key !== statusKey) {
    return failure(interaction, 'That form is malformed. Please try again from the suggestion.');
  }

  if (!assertStaff(interaction)) {
    return failure(interaction, 'Only staff can change a suggestion’s status.');
  }

  if (!(await deferEphemeral(interaction))) return undefined;

  const staffResponse = (interaction.fields.getTextInputValue(IDS.FIELD_STAFF_RESPONSE) ?? '')
    .trim()
    .slice(0, LIMITS.staffResponseMax);

  try {
    const { suggestion, sync, next } = await suggestionService.changeStatus(
      interaction.guild,
      suggestionId,
      {
        status: statusKey,
        staffResponse,
        staffResponderId: interaction.user.id,
      },
    );

    const label = formatNumber(suggestion.suggestion_number);
    log.info(`${interaction.user.id} set suggestion ${label} to ${statusKey}.`);

    if (!sync.updated) {
      const reason =
        sync.reason === 'message-deleted' || sync.reason === 'channel-deleted'
          ? 'the original message no longer exists, so it could not be refreshed'
          : 'the message could not be edited right now';
      return success(
        interaction,
        `Suggestion **${label}** is now ${next.emoji} **${next.label}** — but ${reason}.`,
      );
    }

    return success(
      interaction,
      `Suggestion **${label}** is now ${next.emoji} **${next.label}**.` +
        (staffResponse ? ' Your response was added to the embed.' : ''),
    );
  } catch (error) {
    if (error?.userFacing) return failure(interaction, error.message);
    log.error(`Failed to change status for suggestion ${suggestionId}:`, error);
    return failure(interaction, 'Something went wrong updating that suggestion. Please try again.');
  }
}

module.exports = {
  buttonPrefixes: { [IDS.STAFF_MANAGE]: handleManage },
  selectPrefixes: { [IDS.STAFF_SELECT]: handleSelect },
  modalPrefixes: { [IDS.STAFF_MODAL]: handleStatusModal },
};
