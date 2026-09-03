'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const settingsRepository = require('../../database/settings');
const { createLogger } = require('../../utils/logger');
const { missingChannelPermissions } = require('../../utils/permissions');

const log = createLogger('setgiveawaychannel');

module.exports = {
  name: 'setgiveawaychannel',
  aliases: ['setgwchannel'],
  category: 'admin',
  description: 'Choose the channel used for all new giveaways, or turn giveaway creation off.',
  permission: 'admin',
  args: [{ name: 'channel', type: 'channel', required: false, description: 'The giveaway channel. Omit to clear it.', channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement] }],
  examples: ['setgiveawaychannel #giveaways', 'setgiveawaychannel'],
  async execute(ctx) {
    const channel = ctx.get('channel');
    if (!channel) {
      settingsRepository.updateSettings(ctx.guildId, { giveaway_channel_id: null });
      return ctx.success('The giveaway channel is now **disabled**.');
    }
    const missing = missingChannelPermissions(channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    if (missing.length) return ctx.failure(`I cannot use ${channel}: missing **${missing.join('**, **')}**.`);
    settingsRepository.updateSettings(ctx.guildId, { giveaway_channel_id: channel.id });
    log.info(`Giveaway channel for guild ${ctx.guildId} set to ${channel.id} by ${ctx.user.id}.`);
    return ctx.success(`All new giveaways will be created in ${channel}.`);
  },
};
