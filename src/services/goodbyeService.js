'use strict';

const { EmbedBuilder } = require('discord.js');
const { BRAND } = require('../config');
const settingsRepository = require('../database/settings');
const { formatNumber } = require('../utils/format');
const { createLogger } = require('../utils/logger');
const channelService = require('./channelService');

const log = createLogger('goodbye');

function buildGoodbyeEmbed(member) {
  const { guild, user } = member;
  const name = user?.username ?? member.displayName ?? member.id;
  const avatar = user?.displayAvatarURL?.({ size: 256 });
  return new EmbedBuilder()
    .setColor(BRAND.dangerColor)
    .setAuthor({ name: `${name} left ${guild.name}`, iconURL: guild.iconURL() ?? undefined })
    .setThumbnail(avatar ?? null)
    .setDescription(`Goodbye **${name}**.\n\n**Members now:** ${formatNumber(guild.memberCount)}`)
    .setFooter({ text: `${BRAND.name} • Farewell` })
    .setTimestamp(new Date());
}

/** Sends a configured leave notification. Never throws to the gateway handler. */
async function sendGoodbye(member) {
  const settings = settingsRepository.getSettings(member.guild.id);
  if (!settings?.goodbye_channel_id) return false;

  const channel = await channelService.fetchChannel(member.guild, settings.goodbye_channel_id);
  if (!channel?.isTextBased()) {
    log.warn(`Goodbye channel ${settings.goodbye_channel_id} no longer exists in ${member.guild.id}; clearing it.`);
    settingsRepository.updateSettings(member.guild.id, { goodbye_channel_id: null });
    return false;
  }

  try {
    await channel.send({ embeds: [buildGoodbyeEmbed(member)], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    log.error(`Failed to send a goodbye message in ${member.guild.id}:`, error);
    return false;
  }
}

module.exports = { buildGoodbyeEmbed, sendGoodbye };
