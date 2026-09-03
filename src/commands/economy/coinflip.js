'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND, ECONOMY_DEFAULTS } = require('../../config');
const economyService = require('../../services/economyService');
const { formatNumber } = require('../../utils/format');

module.exports = {
  name: 'coinflip',
  category: 'economy',
  description: 'Bet coins on a coin toss. Win pays 2×.',
  permission: 'everyone',
  cooldown: 3,
  args: [
    { name: 'bet', type: 'integer', description: 'How many coins to bet.', required: true, min: 1, max: ECONOMY_DEFAULTS.maxBet },
    {
      name: 'side',
      type: 'string',
      description: 'Heads or tails.',
      required: true,
      choices: [
        { name: 'Heads', value: 'heads' },
        { name: 'Tails', value: 'tails' },
      ],
    },
  ],
  examples: ['coinflip 100 heads', 'cf 50 tails'],
  async execute(ctx) {
    const result = economyService.coinflip(ctx.guildId, ctx.user.id, ctx.get('bet'), ctx.get('side'));
    const { settings } = result;
    const face = result.landed === 'heads' ? '🪙 Heads' : '🪙 Tails';

    const embed = new EmbedBuilder()
      .setColor(result.won ? BRAND.successColor : BRAND.dangerColor)
      .setTitle(result.won ? '🪙 You won!' : '🪙 You lost')
      .setDescription(
        [
          `You called **${result.choice}** — the coin landed on **${face}**.`,
          result.won
            ? `You win **${economyService.formatCash(settings, result.payout)}** (+${formatNumber(result.net)}).`
            : `You lose **${economyService.formatCash(settings, result.bet)}**.`,
          '',
          `💰 Balance: **${economyService.formatCash(settings, result.balance)}**`,
        ].join('\n'),
      );

    return ctx.reply({ embeds: [embed] });
  },
};
