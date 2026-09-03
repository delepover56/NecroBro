'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const { BRAND, VOTE_LINKS } = require('../../config');

function buildVotePayload() {
  const embed = new EmbedBuilder()
    .setColor(BRAND.accentColor)
    .setTitle('🗳️ Vote for Nekro Land')
    .setDescription(
      'Voting on the server lists helps new players find Nekro Land.\n' +
        'You can vote on **every** site below once per day.\n\n' +
        VOTE_LINKS.map((link, index) => `**${index + 1}.** [${link.label}](${link.url})`).join('\n'),
    )
    .setFooter({ text: `${BRAND.name} • Thank you for voting!` });

  const buttons = VOTE_LINKS.map((link) =>
    new ButtonBuilder().setLabel(link.label).setStyle(ButtonStyle.Link).setURL(link.url),
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
}

module.exports = {
  name: 'vote',
  category: 'general',
  description: 'Show the Minecraft server-list voting links for Nekro Land.',
  permission: 'everyone',
  cooldown: 5,
  args: [],
  examples: ['vote'],
  async execute(ctx) {
    return ctx.reply(buildVotePayload());
  },
  buildVotePayload,
};
