'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND, ECONOMY_DEFAULTS } = require('../../config');
const economyService = require('../../services/economyService');
const { formatNumber } = require('../../utils/format');

const FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

module.exports = {
  name: 'dice',
  category: 'economy',
  description: 'Roll a die for coins. Guess the exact number for 5×, or roll against the bot for 2×.',
  permission: 'everyone',
  cooldown: 3,
  args: [
    { name: 'bet', type: 'integer', description: 'How many coins to bet.', required: true, min: 1, max: ECONOMY_DEFAULTS.maxBet },
    { name: 'guess', type: 'integer', description: 'Optional exact guess (1-6) for a 5× payout.', required: false, min: 1, max: 6 },
  ],
  examples: ['dice 100', 'dice 100 6'],
  async execute(ctx) {
    const result = economyService.dice(ctx.guildId, ctx.user.id, ctx.get('bet'), ctx.get('guess'));
    const { settings } = result;

    let title;
    let summary;
    if (result.guess !== null) {
      title = result.outcome === 'exact' ? '🎲 Exact hit!' : '🎲 Missed';
      summary = `You guessed **${result.guess}** and rolled ${FACES[result.roll]} **${result.roll}**.`;
    } else {
      title = result.outcome === 'win' ? '🎲 You won!' : result.outcome === 'tie' ? '🎲 Tie' : '🎲 You lost';
      summary = `You rolled ${FACES[result.roll]} **${result.roll}** — I rolled ${FACES[result.botRoll]} **${result.botRoll}**.`;
    }

    let money;
    if (result.outcome === 'tie') money = `It's a tie — your **${economyService.formatCash(settings, result.bet)}** is refunded.`;
    else if (result.won) money = `You win **${economyService.formatCash(settings, result.payout)}** (+${formatNumber(result.net)}).`;
    else money = `You lose **${economyService.formatCash(settings, result.bet)}**.`;

    const embed = new EmbedBuilder()
      .setColor(result.won ? BRAND.successColor : result.outcome === 'tie' ? BRAND.neutralColor : BRAND.dangerColor)
      .setTitle(title)
      .setDescription([summary, money, '', `💰 Balance: **${economyService.formatCash(settings, result.balance)}**`].join('\n'));

    return ctx.reply({ embeds: [embed] });
  },
};
