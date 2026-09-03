'use strict';

const { buildLeaderboardPage } = require('../../interactions/leaderboard');

module.exports = {
  name: 'leaderboard',
  aliases: ['lb'],
  category: 'leaderboards',
  description: 'Show the Wealth, Rank or Top leaderboard.',
  permission: 'everyone',
  cooldown: 3,
  args: [
    {
      name: 'type',
      type: 'string',
      description: 'Which board to show (default: Wealth).',
      required: false,
      default: 'wealth',
      choices: [
        { name: 'Wealth', value: 'wealth' },
        { name: 'Rank', value: 'rank' },
        { name: 'Top', value: 'top' },
      ],
    },
    { name: 'page', type: 'integer', description: 'Page number.', required: false, min: 1 },
  ],
  examples: ['leaderboard', 'lb rank', 'lb top 2'],
  async execute(ctx) {
    const type = ctx.get('type') ?? 'wealth';
    const page = ctx.get('page') ?? 1;
    return ctx.reply(buildLeaderboardPage(ctx.guild, type, page));
  },
};
