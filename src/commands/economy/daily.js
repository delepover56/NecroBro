'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const economyService = require('../../services/economyService');
const { discordTime } = require('../../utils/format');

module.exports = {
  name: 'daily',
  category: 'economy',
  description: 'Claim your daily coins. Claim every day to build a streak bonus.',
  permission: 'everyone',
  cooldown: 3,
  args: [],
  examples: ['daily'],
  async execute(ctx) {
    const result = economyService.daily(ctx.guildId, ctx.user.id);
    const { settings } = result;
    const streakNote = result.maxed ? ' (max bonus!)' : '';

    const embed = new EmbedBuilder()
      .setColor(BRAND.successColor)
      .setTitle('📅 Daily reward claimed')
      .setDescription(
        [
          `You received **${economyService.formatCash(settings, result.amount)}**.`,
          `Base ${settings.currencySymbol} ${result.base.toLocaleString('en-US')} + streak bonus ${settings.currencySymbol} ${result.bonus.toLocaleString('en-US')}`,
          '',
          `🔥 Streak: **${result.streak}** day${result.streak === 1 ? '' : 's'}${streakNote}`,
          `💰 Balance: **${economyService.formatCash(settings, result.balance)}**`,
          `⏰ Next claim ${discordTime(result.nextAt, 'R')} — claim within 48 h to keep the streak.`,
        ].join('\n'),
      );

    return ctx.reply({ embeds: [embed] });
  },
};
