'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const economyService = require('../../services/economyService');
const { formatNumber } = require('../../utils/format');

module.exports = {
  name: 'balance',
  aliases: ['bal'],
  category: 'economy',
  description: 'Show your coin balance, or someone else’s.',
  permission: 'everyone',
  cooldown: 3,
  args: [{ name: 'user', type: 'user', description: 'Whose balance to show (default: you).', required: false }],
  examples: ['balance', 'bal @user'],
  async execute(ctx) {
    economyService.requireEnabled(ctx.guildId);
    const target = ctx.get('user') ?? ctx.user;
    const profile = economyService.getProfile(ctx.guildId, target.id);
    const { settings, user, positions } = profile;

    const lines = [
      `<@${target.id}> has **${economyService.formatCash(settings, user.cash)}**.`,
      `Lifetime earned: **${formatNumber(user.lifetime_cash)}** · Wealth board: ${
        positions.wealth ? `**#${positions.wealth}** of ${profile.total}` : '_unranked_'
      }`,
    ];

    const embed = new EmbedBuilder()
      .setColor(BRAND.accentColor)
      .setTitle(`${settings.currencySymbol} Balance`)
      .setDescription(lines.join('\n'))
      .setThumbnail(target.displayAvatarURL?.({ size: 128 }) ?? null);

    return ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
