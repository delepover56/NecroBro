'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const settingsRepository = require('../../database/settings');
const { createLogger } = require('../../utils/logger');
const { missingChannelPermissions } = require('../../utils/permissions');

const log = createLogger('setwelcome');

module.exports = {
  name: 'setwelcome',
  category: 'admin',
  description: 'Choose the channel for welcome messages, or turn them off.',
  permission: 'admin',
  args: [
    {
      name: 'channel',
      type: 'channel',
      description: 'Where to welcome new members. Omit to disable welcome messages.',
      required: false,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    },
  ],
  examples: ['setwelcome #welcome', 'setwelcome'],
  async execute(ctx) {
    const channel = ctx.get('channel');

    if (!channel) {
      settingsRepository.updateSettings(ctx.guildId, { welcome_channel_id: null });
      log.info(`Welcome messages disabled in guild ${ctx.guildId} by ${ctx.user.id}.`);
      return ctx.success('Welcome messages are now **disabled**. Run this again with a channel to enable them.');
    }

    const missing = missingChannelPermissions(channel, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]);
    if (missing.length > 0) {
      return ctx.failure(`I cannot post in ${channel}: missing **${missing.join('**, **')}**.`);
    }

    settingsRepository.updateSettings(ctx.guildId, { welcome_channel_id: channel.id });
    log.info(`Welcome channel for guild ${ctx.guildId} set to ${channel.id} by ${ctx.user.id}.`);
    return ctx.success(`New members will be welcomed in ${channel}.`);
  },
};
