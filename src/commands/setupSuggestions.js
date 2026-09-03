'use strict';

const { ChannelType } = require('discord.js');

const { BRAND } = require('../config');
const channelService = require('../services/channelService');
const { buildLogEmbed } = require('../utils/embeds');
const { createLogger } = require('../utils/logger');
const { SUGGESTION_BOT_PERMISSIONS, missingBotPermissions } = require('../utils/permissions');

const log = createLogger('setup');

/**
 * `/setup-suggestions` / `?setup-suggestions` -- idempotent installation of
 * the suggestion system. Admin-only (configured Admin role or server owner);
 * running it twice reuses the existing category, channels and panel.
 */
module.exports = {
  name: 'setup-suggestions',
  category: 'suggestions',
  description: 'Create or repair the suggestion system (channels, panel, staff roles).',
  permission: 'admin',
  botPermissions: SUGGESTION_BOT_PERMISSIONS,
  args: [
    { name: 'staff_role', type: 'role', description: 'Extra role allowed to manage suggestions.', required: false },
    { name: 'staff_role_2', type: 'role', description: 'An additional suggestion staff role.', required: false },
    { name: 'staff_role_3', type: 'role', description: 'An additional suggestion staff role.', required: false },
    {
      name: 'suggestions_channel',
      type: 'channel',
      description: 'Channel that holds the suggestion panel (default: #suggestions).',
      required: false,
      channelTypes: [ChannelType.GuildText],
    },
    {
      name: 'voting_channel',
      type: 'channel',
      description: 'Channel where suggestions are posted (default: #suggestion-voting).',
      required: false,
      channelTypes: [ChannelType.GuildText],
    },
    {
      name: 'staff_log_channel',
      type: 'channel',
      description: 'Optional channel for suggestion staff logs.',
      required: false,
      channelTypes: [ChannelType.GuildText],
    },
  ],
  examples: ['setup-suggestions', 'setup-suggestions @Helper'],
  async execute(ctx) {
    const { guild } = ctx;
    await ctx.defer({ ephemeral: true });

    const missing = missingBotPermissions(guild, SUGGESTION_BOT_PERMISSIONS);
    if (missing.length > 0) {
      return ctx.failure(
        `I need the following server permissions before I can set this up:\n` +
          `**${missing.join('**, **')}**\n\nGrant them to my role and run this command again. ` +
          '(Administrator is *not* required.)',
      );
    }

    const staffRoleIds = [
      ...new Set(
        ['staff_role', 'staff_role_2', 'staff_role_3']
          .map((name) => ctx.get(name))
          .filter(Boolean)
          .map((role) => role.id),
      ),
    ];

    try {
      const report = await channelService.setupGuild(guild, {
        staffRoleIds,
        suggestionsChannel: ctx.get('suggestions_channel'),
        votingChannel: ctx.get('voting_channel'),
        staffLogChannel: ctx.get('staff_log_channel'),
      });

      const mark = (result) => (result.created ? '🆕 created' : '♻️ reused');
      const staffRoles =
        report.staffRoleIds.length > 0
          ? report.staffRoleIds.map((id) => `<@&${id}>`).join(', ')
          : '_none extra — Admins and Moderators manage suggestions_';

      const embed = buildLogEmbed({
        title: '✅ Suggestion system ready',
        color: BRAND.successColor,
        description:
          'Everything below is stored in the database, so the bot picks it back up after a restart. ' +
          'Running this command again is safe — it repairs permissions instead of duplicating channels.',
        fields: [
          { name: 'Submission category', value: `${report.category.channel} (${mark(report.category)})` },
          { name: 'Suggestion panel', value: `${report.intake.channel} (${mark(report.intake)})` },
          { name: 'Voting channel', value: `${report.voting.channel} (${mark(report.voting)})` },
          { name: 'Staff log', value: report.staffLog ? `${report.staffLog}` : '_not configured_' },
          { name: 'Extra staff roles', value: staffRoles },
          { name: 'Panel message', value: report.panel.created ? '🆕 posted' : '♻️ updated in place' },
        ],
      });

      log.info(`setup-suggestions completed for guild ${guild.id} by ${ctx.user.id}.`);
      return ctx.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
    } catch (error) {
      if (error?.code === 50013) {
        log.warn(`Missing channel permissions during setup in guild ${guild.id}:`, error);
        return ctx.failure(
          'Discord refused one of the changes because of missing permissions. ' +
            'Make sure my role is above the suggestion channels and try again.',
        );
      }
      if (error?.code === 30013 || error?.code === 30035) {
        return ctx.failure('This server has hit a Discord channel limit, so I could not create the required channels.');
      }
      log.error(`setup-suggestions failed in guild ${guild.id}:`, error);
      return ctx.failure('Setup failed unexpectedly. Check the bot console for details and try again.');
    }
  },
};
