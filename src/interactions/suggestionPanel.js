'use strict';

const { PermissionFlagsBits } = require('discord.js');

const { IDS } = require('../config');
const configRepository = require('../database/config');
const channelService = require('../services/channelService');
const { createLogger } = require('../utils/logger');
const { isStaff, missingBotPermissions } = require('../utils/permissions');
const { deferEphemeral, failure, info, success } = require('../utils/respond');

const log = createLogger('panel');

/**
 * The permanent panel button (`💡 Create Suggestion`) and the draft channel's
 * `❌ Cancel` button.
 */

/**
 * Guards against double-clicks: Discord happily delivers two interactions if a
 * member spams the button, and each would create its own channel.
 */
const creating = new Set();

async function handleCreateSuggestion(interaction) {
  const { guild, member, user } = interaction;

  if (creating.has(user.id)) {
    return info(interaction, 'I am already opening your suggestion channel — one moment.');
  }
  creating.add(user.id);

  try {
    if (!(await deferEphemeral(interaction))) return undefined;

    const config = configRepository.getGuildConfig(guild.id);
    if (!config?.submission_category_id) {
      return failure(
        interaction,
        'The suggestion system has not been set up yet. Ask a staff member to run `/setup-suggestions`.',
      );
    }

    // A draft already open? Point the member at it instead of making another.
    const existingRecord = configRepository.getTempChannelForUser(guild.id, user.id);
    if (existingRecord) {
      const existingChannel = await channelService.fetchChannel(guild, existingRecord.channel_id);
      if (existingChannel) {
        return info(
          interaction,
          `You already have a suggestion draft open: <#${existingChannel.id}>\n` +
            'Finish it or press **❌ Cancel** there before starting another.',
        );
      }
      // The channel was deleted while the record survived -- clean up and continue.
      configRepository.deleteTempChannel(existingRecord.channel_id);
    }

    const missing = missingBotPermissions(guild, [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
    ]);
    if (missing.length > 0) {
      log.warn(`Missing permissions in guild ${guild.id}: ${missing.join(', ')}`);
      return failure(
        interaction,
        `I am missing the **${missing.join('**, **')}** permission(s), so I cannot create your ` +
          'private channel. Please let a staff member know.',
      );
    }

    const category = await channelService.fetchChannel(guild, config.submission_category_id);
    if (!category) {
      return failure(
        interaction,
        'The suggestion submission category is missing. Ask a staff member to run ' +
          '`/setup-suggestions` again.',
      );
    }

    const channel = await channelService.createTempChannel(guild, member, config);

    return success(
      interaction,
      `Your private suggestion channel is ready: <#${channel.id}>\n` +
        'Head over there and press **📝 Submit Suggestion**.',
    );
  } catch (error) {
    log.error(`Failed to open a suggestion draft for ${user.id}:`, error);
    return failure(
      interaction,
      'I could not open your suggestion channel. Please try again in a moment.',
    );
  } finally {
    creating.delete(user.id);
  }
}

/** `❌ Cancel` inside a draft channel. */
async function handleCancel(interaction) {
  const { guild, channelId, member, user } = interaction;

  const record = configRepository.getTempChannel(channelId);
  if (!record) {
    return failure(interaction, 'This does not look like an active suggestion draft channel.');
  }

  if (record.user_id !== user.id && !isStaff(member)) {
    return failure(interaction, 'Only the member who opened this draft (or staff) can cancel it.');
  }

  if (!(await deferEphemeral(interaction))) return undefined;

  await success(interaction, 'Cancelled. This channel is being deleted…');
  await channelService.deleteTempChannel(
    guild,
    channelId,
    `Suggestion draft cancelled by ${user.tag}`,
  );
  log.info(`Draft channel ${channelId} cancelled by ${user.id}.`);
  return undefined;
}

module.exports = {
  buttons: {
    [IDS.PANEL_CREATE]: handleCreateSuggestion,
    [IDS.TEMP_CANCEL]: handleCancel,
  },
};
