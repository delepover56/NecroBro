'use strict';

const {
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const { CATEGORIES, IDS, LIMITS, TEMP_CHANNEL_CLEANUP_DELAY_MS } = require('../config');
const configRepository = require('../database/config');
const channelService = require('../services/channelService');
const suggestionService = require('../services/suggestionService');
const { buildNoticeEmbed, formatNumber } = require('../utils/embeds');
const { createLogger } = require('../utils/logger');
const { deferEphemeral, failure, success } = require('../utils/respond');

const log = createLogger('modal');

/**
 * The `📝 Submit Suggestion` button, the modal it opens, and everything that
 * happens when the modal comes back.
 *
 * The modal uses the modern label-based component layout (`LabelBuilder`),
 * which lets the category be a real select menu rather than a free-text field
 * that has to be parsed and guessed at.
 */

function buildSuggestionModal() {
  const title = new TextInputBuilder()
    .setCustomId(IDS.FIELD_TITLE)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(LIMITS.titleMin)
    .setMaxLength(LIMITS.titleMax)
    .setPlaceholder('Add a public /warp shop hub');

  const category = new StringSelectMenuBuilder()
    .setCustomId(IDS.FIELD_CATEGORY)
    .setPlaceholder('Pick the closest category…')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      CATEGORIES.map((entry) =>
        new StringSelectMenuOptionBuilder()
          .setValue(entry.value)
          .setLabel(entry.label)
          .setDescription(entry.description)
          .setEmoji(entry.emoji),
      ),
    );

  const description = new TextInputBuilder()
    .setCustomId(IDS.FIELD_DESCRIPTION)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(LIMITS.descriptionMin)
    .setMaxLength(LIMITS.descriptionMax)
    .setPlaceholder('What should change, and why would it make Nekro Land better?');

  return new ModalBuilder()
    .setCustomId(IDS.SUGGESTION_MODAL)
    .setTitle('New Nekro Land Suggestion')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Suggestion Title')
        .setDescription(`${LIMITS.titleMin}-${LIMITS.titleMax} characters.`)
        .setTextInputComponent(title),
      new LabelBuilder()
        .setLabel('Category')
        .setDescription('Helps staff and members find your idea.')
        .setStringSelectMenuComponent(category),
      new LabelBuilder()
        .setLabel('Suggestion Description')
        .setDescription(`${LIMITS.descriptionMin}-${LIMITS.descriptionMax} characters.`)
        .setTextInputComponent(description),
    );
}

/** `📝 Submit Suggestion` -- opens the modal for the draft channel's owner. */
async function handleOpenModal(interaction) {
  const record = configRepository.getTempChannel(interaction.channelId);

  if (!record) {
    return failure(
      interaction,
      'This draft channel is no longer registered. Please start again from the suggestion panel.',
    );
  }

  if (record.user_id !== interaction.user.id) {
    return failure(interaction, 'Only the member who opened this draft can submit the suggestion.');
  }

  try {
    await interaction.showModal(buildSuggestionModal());
  } catch (error) {
    log.error(`Failed to show the suggestion modal to ${interaction.user.id}:`, error);
    await failure(interaction, 'I could not open the suggestion form. Please try again.');
  }
  return undefined;
}

/** Draft channels currently mid-publish, so a double submit cannot double-post. */
const submitting = new Set();

/** Modal submission: validate, publish, then tear the draft channel down. */
async function handleModalSubmit(interaction) {
  const { guild, channelId, user } = interaction;

  if (!(await deferEphemeral(interaction))) return undefined;

  const record = configRepository.getTempChannel(channelId);
  if (!record || record.user_id !== user.id) {
    return failure(
      interaction,
      'This draft is no longer active. Please start again from the suggestion panel.',
    );
  }

  if (submitting.has(channelId)) {
    return failure(interaction, 'Your suggestion is already being submitted — one moment.');
  }
  submitting.add(channelId);
  try {
    return await publishFromModal(interaction, channelId);
  } finally {
    submitting.delete(channelId);
  }
}

/** The publishing half of `handleModalSubmit`, kept separate for readability. */
async function publishFromModal(interaction, channelId) {
  const { guild, user } = interaction;

  const raw = {
    title: interaction.fields.getTextInputValue(IDS.FIELD_TITLE),
    category: interaction.fields.getStringSelectValues(IDS.FIELD_CATEGORY)?.[0],
    description: interaction.fields.getTextInputValue(IDS.FIELD_DESCRIPTION),
  };

  const validation = suggestionService.validateSuggestionInput(raw);
  if (!validation.ok) {
    return failure(
      interaction,
      `Your suggestion could not be submitted:\n${validation.errors.map((e) => `• ${e}`).join('\n')}\n\n` +
        'Nothing was posted — press **📝 Submit Suggestion** again to retry.',
    );
  }

  let published;
  try {
    published = await suggestionService.publishSuggestion(guild, {
      authorId: user.id,
      // Snapshot the identity now: the embed must still render correctly if the
      // member later leaves the server or changes their avatar.
      authorUsername: user.username,
      authorAvatarUrl: user.displayAvatarURL({ size: 128, extension: 'png' }),
      ...validation.values,
    });
  } catch (error) {
    if (error?.userFacing) return failure(interaction, error.message);
    log.error(`Unexpected failure publishing a suggestion for ${user.id}:`, error);
    return failure(interaction, 'Something went wrong posting your suggestion. Please try again.');
  }

  const { suggestion, message } = published;
  const label = formatNumber(suggestion.suggestion_number);

  // Retire the draft record immediately: the channel lingers only long enough
  // for the member to read the confirmation, but it must not accept a second
  // submission in the meantime.
  configRepository.deleteTempChannel(channelId);

  await success(
    interaction,
    `Suggestion **${label}** posted! [Jump to it](${message.url})\n` +
      'This draft channel will be deleted in a few seconds.',
  );

  await channelService.sendStaffLog(guild, {
    title: `📥 New suggestion ${label}`,
    description: `**${suggestion.title}**\n[Jump to suggestion](${message.url})`,
    fields: [
      { name: 'Author', value: `<@${user.id}>`, inline: true },
      { name: 'Category', value: suggestion.category, inline: true },
    ],
  });

  // Show a visible goodbye in the channel, then remove it.
  const draftChannel = await channelService.fetchChannel(guild, channelId);
  if (draftChannel?.isTextBased()) {
    await draftChannel
      .send({
        embeds: [
          buildNoticeEmbed(
            'success',
            `Suggestion **${label}** submitted — [view it here](${message.url}).\n` +
              'This channel will now be deleted.',
          ),
        ],
      })
      .catch(() => undefined);
  }

  setTimeout(() => {
    channelService
      .deleteTempChannel(guild, channelId, `Suggestion ${label} submitted`)
      .catch((error) => log.warn(`Delayed draft cleanup failed for ${channelId}:`, error));
  }, TEMP_CHANNEL_CLEANUP_DELAY_MS).unref?.();

  return undefined;
}

module.exports = {
  buildSuggestionModal,
  buttons: { [IDS.TEMP_SUBMIT]: handleOpenModal },
  modals: { [IDS.SUGGESTION_MODAL]: handleModalSubmit },
};
