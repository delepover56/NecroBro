'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const economyService = require('../../services/economyService');
const { formatNumber } = require('../../utils/format');

function position(value, total) {
  return value ? `#${value} of ${total}` : 'unranked';
}

module.exports = {
  name: 'profile',
  category: 'economy',
  description: 'Show a member’s economy profile: coins, rank, XP progress and board positions.',
  permission: 'everyone',
  cooldown: 3,
  args: [{ name: 'user', type: 'user', description: 'Whose profile to show (default: you).', required: false }],
  examples: ['profile', 'profile @user'],
  async execute(ctx) {
    economyService.requireEnabled(ctx.guildId);
    const target = ctx.get('user') ?? ctx.user;
    const profile = economyService.getProfile(ctx.guildId, target.id);
    const { settings, user, progress, positions, total } = profile;

    const member = ctx.guild.members.cache.get(target.id) ?? null;
    const displayName = member?.displayName ?? target.globalName ?? target.username ?? target.id;

    const embed = new EmbedBuilder()
      .setColor(BRAND.accentColor)
      .setTitle(`👤 ${displayName}`)
      .setThumbnail(member?.displayAvatarURL?.({ size: 256 }) ?? target.displayAvatarURL?.({ size: 256 }) ?? null)
      .setDescription(
        [
          `💰 **Balance:** ${economyService.formatCash(settings, user.cash)}`,
          `🏆 **Rank ${progress.level}**`,
          `✨ **XP:** ${formatNumber(progress.current)} / ${formatNumber(progress.needed)}  \`${profile.bar}\``,
          `💬 **Messages:** ${formatNumber(user.message_count)}`,
        ].join('\n'),
      )
      .addFields({
        name: 'Leaderboards',
        value: [
          `💰 Wealth: **${position(positions.wealth, total)}**`,
          `🏆 Rank: **${position(positions.rank, total)}**`,
          `👑 Top: **${position(positions.top, total)}**`,
        ].join('\n'),
      })
      .setFooter({ text: `Total XP ${formatNumber(user.xp)} • Lifetime earned ${formatNumber(user.lifetime_cash)}` });

    return ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
