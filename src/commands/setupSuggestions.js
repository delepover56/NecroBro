'use strict';

const {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const { BRAND } = require('../config');
const channelService = require('../services/channelService');
const { buildLogEmbed } = require('../utils/embeds');
const { createLogger } = require('../utils/logger');
const { REQUIRED_BOT_PERMISSIONS, missingBotPermissions } = require('../utils/permissions');
const { deferEphemeral, failure, respond } = require('../utils/respond');

const log = createLogger('setup');

/**
 * `/setup-suggestions` -- idempotent installation of the suggestion system.
 *
 * Gated on **Manage Server**, never Administrator. Running it twice reuses the
 * existing category, channels and panel instead of duplicating them.
 */
const data = new SlashCommandBuilder()
  .setName('setup-suggestions')
  .setDescription('Create or repair the Nekro Land suggestion system in this server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addRoleOption((option) =>
    option.setName('staff_role').setDescription('Role allowed to manage suggestions.'),
  )
  .addRoleOption((option) =>
    option.setName('staff_role_2').setDescription('An additional staff role.'),
  )
  .addRoleOption((option) =>
    option.setName('staff_role_3').setDescription('An additional staff role.'),
  )
  .addChannelOption((option) =>
    option
      .setName('suggestions_channel')
      .setDescription('Channel that holds the suggestion panel (default: #suggestions).')
      .addChannelTypes(ChannelType.GuildText),
  )
  .addChannelOption((option) =>
    option
      .setName('voting_channel')
      .setDescription('Channel where suggestions are posted (default: #suggestion-voting).')
      .addChannelTypes(ChannelType.GuildText),
  )
  .addChannelOption((option) =>
    option
      .setName('staff_log_channel')
      .setDescription('Optional channel for staff audit logs.')
      .addChannelTypes(ChannelType.GuildText),
  );

/** Collects the up-to-three staff role options into a de-duplicated list. */
function readStaffRoles(interaction) {
  const roles = ['staff_role', 'staff_role_2', 'staff_role_3']
    .map((name) => interaction.options.getRole(name))
    .filter(Boolean);
  return [...new Set(roles.map((role) => role.id))];
}

async function execute(interaction) {
  const { guild } = interaction;

  if (!(await deferEphemeral(interaction))) return undefined;

  const missing = missingBotPermissions(guild, REQUIRED_BOT_PERMISSIONS);
  if (missing.length > 0) {
    return failure(
      interaction,
      `I need the following server permissions before I can set this up:\n` +
        `**${missing.join('**, **')}**\n\n` +
        'Grant them to my role and run this command again. ' +
        '(Administrator is *not* required.)',
    );
  }

  try {
    const report = await channelService.setupGuild(guild, {
      staffRoleIds: readStaffRoles(interaction),
      suggestionsChannel: interaction.options.getChannel('suggestions_channel'),
      votingChannel: interaction.options.getChannel('voting_channel'),
      staffLogChannel: interaction.options.getChannel('staff_log_channel'),
    });

    const mark = (result) => (result.created ? '🆕 created' : '♻️ reused');
    const staffRoles =
      report.staffRoleIds.length > 0
        ? report.staffRoleIds.map((id) => `<@&${id}>`).join(', ')
        : '_none configured — members with **Manage Server** or **Manage Channels** count as staff_';

    const embed = buildLogEmbed({
      title: '✅ Suggestion system ready',
      color: BRAND.successColor,
      description:
        'Everything below is stored in the database, so the bot picks it back up after a restart. ' +
        'Running this command again is safe — it repairs permissions instead of duplicating channels.',
      fields: [
        {
          name: 'Submission category',
          value: `${report.category.channel} (${mark(report.category)})`,
        },
        { name: 'Suggestion panel', value: `${report.intake.channel} (${mark(report.intake)})` },
        { name: 'Voting channel', value: `${report.voting.channel} (${mark(report.voting)})` },
        {
          name: 'Staff log',
          value: report.staffLog ? `${report.staffLog}` : '_not configured_',
        },
        { name: 'Staff roles', value: staffRoles },
        {
          name: 'Panel message',
          value: report.panel.created ? '🆕 posted' : '♻️ updated in place',
        },
      ],
    });

    log.info(`/setup-suggestions completed for guild ${guild.id} by ${interaction.user.id}.`);
    return respond(interaction, { embeds: [embed] });
  } catch (error) {
    if (error?.code === 50013) {
      log.warn(`Missing channel permissions during setup in guild ${guild.id}:`, error);
      return failure(
        interaction,
        'Discord refused one of the changes because of missing permissions. ' +
          'Make sure my role is above the suggestion channels and try again.',
      );
    }
    if (error?.code === 30013 || error?.code === 30035) {
      return failure(
        interaction,
        'This server has hit a Discord channel limit, so I could not create the required channels.',
      );
    }
    log.error(`/setup-suggestions failed in guild ${guild.id}:`, error);
    return failure(
      interaction,
      'Setup failed unexpectedly. Check the bot console for details and try again.',
    );
  }
}

module.exports = { data, execute };
