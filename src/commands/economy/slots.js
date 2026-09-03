'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND, ECONOMY_DEFAULTS } = require('../../config');
const economyService = require('../../services/economyService');
const { formatNumber } = require('../../utils/format');

const OUTCOME = {
  jackpot: { title: '🎰 JACKPOT!', text: 'Three of a kind — **5×** payout!' },
  pair: { title: '🎰 A pair!', text: 'Two matching symbols — **1.5×** payout.' },
  lose: { title: '🎰 No luck', text: 'The reels did not line up.' },
};

module.exports = {
  name: 'slots',
  category: 'economy',
  description: 'Spin the slot machine. Three of a kind pays 5×, a pair pays 1.5×.',
  permission: 'everyone',
  cooldown: 3,
  args: [
    { name: 'bet', type: 'integer', description: 'How many coins to bet.', required: true, min: 1, max: ECONOMY_DEFAULTS.maxBet },
  ],
  examples: ['slots 100'],
  async execute(ctx) {
    const result = economyService.slots(ctx.guildId, ctx.user.id, ctx.get('bet'));
    const { settings } = result;
    const info = OUTCOME[result.outcome] ?? OUTCOME.lose;

    const embed = new EmbedBuilder()
      .setColor(result.won ? BRAND.successColor : BRAND.dangerColor)
      .setTitle(info.title)
      .setDescription(
        [
          `# [ ${result.reels.join(' | ')} ]`,
          info.text,
          result.won
            ? `You win **${economyService.formatCash(settings, result.payout)}** (${result.net >= 0 ? '+' : ''}${formatNumber(result.net)}).`
            : `You lose **${economyService.formatCash(settings, result.bet)}**.`,
          '',
          `💰 Balance: **${economyService.formatCash(settings, result.balance)}**`,
        ].join('\n'),
      );

    return ctx.reply({ embeds: [embed] });
  },
};
