'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../config');
const configRepository = require('../database/config');
const settingsRepository = require('../database/settings');
const { formatNumber } = require('../utils/format');
const { createLogger } = require('../utils/logger');
const channelService = require('./channelService');

const log = createLogger('welcome');

/** Welcome messages for new members, sent to the Admin-configured channel. */

function buildWelcomeEmbed(member) {
  const { guild, user } = member;
  const config = configRepository.getGuildConfig(guild.id);
  const prefix = settingsRepository.getPrefix(guild.id);

  const tips = [
    `• Type \`${prefix}help\` or \`/help\` to see everything I can do.`,
    `• Use \`${prefix}vote\` to support the server on the voting sites.`,
  ];
  if (config?.suggestions_channel_id) {
    tips.push(`• Have an idea? Head to <#${config.suggestions_channel_id}>.`);
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND.successColor)
    .setAuthor({ name: `Welcome to ${guild.name}!`, iconURL: guild.iconURL() ?? undefined })
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setDescription(
      `Hey ${member}, welcome aboard! You are member **#${formatNumber(guild.memberCount)}**.\n\n` +
        `**Username:** \`${user.username}\`\n\n${tips.join('\n')}`,
    )
    .setFooter({ text: `${BRAND.name} • Enjoy your stay` })
    .setTimestamp(new Date());
  const imageUrl = settingsRepository.getSettings(guild.id)?.welcome_image_url;
  if (imageUrl) embed.setImage(imageUrl);
  return embed;
}

/** Sends the welcome message if a channel is configured. Never throws. */
async function sendWelcome(member) {
  const settings = settingsRepository.getSettings(member.guild.id);
  if (!settings?.welcome_channel_id) return false;

  const channel = await channelService.fetchChannel(member.guild, settings.welcome_channel_id);
  if (!channel?.isTextBased()) {
    log.warn(
      `Welcome channel ${settings.welcome_channel_id} no longer exists in ${member.guild.id}; clearing it.`,
    );
    settingsRepository.updateSettings(member.guild.id, { welcome_channel_id: null });
    return false;
  }

  try {
    await channel.send({
      content: `${member}`,
      embeds: [buildWelcomeEmbed(member)],
      allowedMentions: { users: [member.id] },
    });
    return true;
  } catch (error) {
    log.error(`Failed to send a welcome message in ${member.guild.id}:`, error);
    return false;
  }
}

module.exports = { sendWelcome, buildWelcomeEmbed };
