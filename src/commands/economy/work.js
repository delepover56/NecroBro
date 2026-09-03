'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const economyService = require('../../services/economyService');
const { discordTime } = require('../../utils/format');

module.exports = {
  name: 'work',
  category: 'economy',
  description: 'Work a shift for coins (hourly).',
  permission: 'everyone',
  cooldown: 3,
  args: [],
  examples: ['work'],
  async execute(ctx) {
    const result = economyService.work(ctx.guildId, ctx.user.id);
    const { settings } = result;

    const embed = new EmbedBuilder()
      .setColor(BRAND.successColor)
      .setTitle('⛏️ Shift complete')
      .setDescription(
        [
          result.line,
          '',
          `💰 Balance: **${economyService.formatCash(settings, result.balance)}**`,
          `⏰ You can work again ${discordTime(result.nextAt, 'R')}.`,
        ].join('\n'),
      );

    return ctx.reply({ embeds: [embed] });
  },
};
