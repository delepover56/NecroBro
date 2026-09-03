'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const economyService = require('../../services/economyService');

module.exports = {
  name: 'minigames',
  category: 'economy',
  description: 'List the coin minigames and how to play them.',
  permission: 'everyone',
  cooldown: 3,
  args: [],
  examples: ['minigames'],
  async execute(ctx) {
    const settings = economyService.requireEnabled(ctx.guildId);
    const p = ctx.isSlash ? '/' : ctx.prefix;

    const embed = new EmbedBuilder()
      .setColor(BRAND.accentColor)
      .setTitle('🎮 Minigames')
      .setDescription(
        `Bet between **${economyService.formatCash(settings, settings.minBet)}** and ` +
          `**${economyService.formatCash(settings, settings.maxBet)}**. ` +
          `Each game has a ${settings.minigameCooldownSeconds}s cooldown.`,
      )
      .addFields(
        {
          name: '🪙 Coinflip',
          value: `\`${p}coinflip <bet> <heads|tails>\`\nCall it right to win **2×** your bet.`,
        },
        {
          name: '🎰 Slots',
          value: `\`${p}slots <bet>\`\nThree reels of ${economyService.SLOT_SYMBOLS.join(' ')}. Three of a kind pays **5×**, a pair pays **1.5×**.`,
        },
        {
          name: '🎲 Dice',
          value:
            `\`${p}dice <bet> [guess 1-6]\`\nGuess the exact roll for **5×**. ` +
            'No guess? Roll against me: higher wins **2×**, a tie refunds your bet.',
        },
      )
      .setFooter({ text: `Check your coins with ${p}balance` });

    return ctx.reply({ embeds: [embed] });
  },
};
