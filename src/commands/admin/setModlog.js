'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const settingsRepository = require('../../database/settings');
const { createLogger } = require('../../utils/logger');
const { missingChannelPermissions } = require('../../utils/permissions');

const log = createLogger('setmodlog');

module.exports = {
  name: 'setmodlog',
  category: 'admin',
  description: 'Choose the channel where moderation cases are logged, or turn logging off.',
  permission: 'admin',
  args: [
    {
      name: 'channel',
      type: 'channel',
      description: 'Where to post moderation cases. Omit to disable the mod log.',
      required: false,
      channelTypes: [ChannelType.GuildText],
    },
  ],
  examples: ['setmodlog #mod-log', 'setmodlog'],
  async execute(ctx) {
    const channel = ctx.get('channel');

    if (!channel) {
      settingsRepository.updateSettings(ctx.guildId, { modlog_channel_id: null });
      log.info(`Mod log disabled in guild ${ctx.guildId} by ${ctx.user.id}.`);
      return ctx.success('The moderation log is now **disabled**.');
    }

    const missing = missingChannelPermissions(channel, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]);
    if (missing.length > 0) {
      return ctx.failure(`I cannot post in ${channel}: missing **${missing.join('**, **')}**.`);
    }

    settingsRepository.updateSettings(ctx.guildId, { modlog_channel_id: channel.id });
    log.info(`Mod log for guild ${ctx.guildId} set to ${channel.id} by ${ctx.user.id}.`);
    return ctx.success(`Moderation cases will be logged in ${channel}.`);
  },
};
