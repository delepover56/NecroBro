'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const economyService = require('../../services/economyService');
const { discordTime } = require('../../utils/format');

module.exports = {
  name: 'beg',
  category: 'economy',
  description: 'Beg for a few coins. Sometimes it even works.',
  permission: 'everyone',
  cooldown: 3,
  args: [],
  examples: ['beg'],
  async execute(ctx) {
    const result = economyService.beg(ctx.guildId, ctx.user.id);
    const { settings } = result;

    const embed = new EmbedBuilder()
      .setColor(result.success ? BRAND.successColor : BRAND.neutralColor)
      .setTitle(result.success ? '🙏 Someone took pity' : '🙏 Nothing this time')
      .setDescription(
        [
          result.line,
          '',
          `💰 Balance: **${economyService.formatCash(settings, result.balance)}**`,
          `⏰ You can beg again ${discordTime(result.nextAt, 'R')}.`,
        ].join('\n'),
      );

    return ctx.reply({ embeds: [embed] });
  },
};
