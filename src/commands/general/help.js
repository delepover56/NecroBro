'use strict';

const { COMMAND_CATEGORIES } = require('../../config');
const { buildHelpPage } = require('../../interactions/help');

module.exports = {
  name: 'help',
  aliases: ['commands'],
  category: 'general',
  description: 'Show the bot guide with every command, grouped by category.',
  permission: 'everyone',
  cooldown: 3,
  args: [
    {
      name: 'category',
      type: 'string',
      description: 'Jump straight to a category.',
      required: false,
      choices: Object.values(COMMAND_CATEGORIES).map((c) => ({ name: c.label, value: c.key })),
    },
  ],
  examples: ['help', 'help moderation'],
  async execute(ctx) {
    const key = ctx.get('category') ?? 'home';
    return ctx.reply({ ...buildHelpPage(ctx.member, ctx.user.id, key), ephemeral: true });
  },
};
