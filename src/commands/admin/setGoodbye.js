'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const settingsRepository = require('../../database/settings');
const { missingChannelPermissions } = require('../../utils/permissions');

module.exports = {
  name: 'setgoodbye',
  aliases: ['setgoodbyechannel'],
  category: 'admin',
  description: 'Choose the channel for goodbye messages, or turn them off.',
  permission: 'admin',
  args: [{ name: 'channel', type: 'channel', description: 'Where to post goodbye messages. Omit to disable.', required: false, channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement] }],
  examples: ['setgoodbye #goodbye', 'setgoodbye'],
  async execute(ctx) {
    const channel = ctx.get('channel');
    if (!channel) {
      settingsRepository.updateSettings(ctx.guildId, { goodbye_channel_id: null });
      return ctx.success('Goodbye messages are now **disabled**.');
    }
    const missing = missingChannelPermissions(channel, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
    if (missing.length) return ctx.failure(`I cannot post in ${channel}: missing **${missing.join('**, **')}**.`);
    settingsRepository.updateSettings(ctx.guildId, { goodbye_channel_id: channel.id });
    return ctx.success(`Goodbye messages will be posted in ${channel}.`);
  },
};
