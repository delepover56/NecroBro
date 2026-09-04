'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits } = require('discord.js');

const { IDS } = require('../config');
const configRepository = require('../database/config');
const ticketRepository = require('../database/tickets');
const { slugify } = require('./channelService');
const { resolveStaffRoles } = require('../utils/permissions');

const TYPE_LABELS = { REPORT: 'Report', SUPPORT: 'Support', APPEAL: 'Appeal' };
const PLATFORM_LABELS = { MINECRAFT_SURVIVAL: 'Minecraft Survival', DISCORD: 'Discord' };
const TICKET_COLOR = 0x9900ff;

function overwrites(guild, userId, staffRoleIds) {
  return [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: userId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: guild.members.me.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ...staffRoleIds.map((id) => ({ id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })),
  ];
}

function ticketEmbed(ticket, user) {
  return new EmbedBuilder()
    .setColor(TICKET_COLOR)
    .setTitle(`${TYPE_LABELS[ticket.type]} Ticket`)
    .addFields(
      { name: 'User', value: `<@${ticket.creator_id}> (${user.username})`, inline: true },
      { name: 'Platform', value: PLATFORM_LABELS[ticket.platform], inline: true },
      { name: 'Details', value: ticket.details.slice(0, 1024) },
    )
    .setTimestamp(ticket.created_at)
    .setFooter({ text: `Ticket #${ticket.id}` });
}

function ticketControls() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.TICKET_CLOSE).setLabel('Close Ticket').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.TICKET_DELETE).setLabel('Delete Ticket').setStyle(ButtonStyle.Danger),
  )];
}

async function createTicket(guild, member, { type, platform, details, attachmentUrls }) {
  const config = configRepository.getGuildConfig(guild.id);
  if (!config?.ticket_category_id) throw new Error('Tickets have not been configured.');
  const staffRoleIds = resolveStaffRoles(guild, config);
  const base = `ticket-${slugify(member.user.username)}`;
  const taken = guild.channels.cache.some((channel) => channel.name === base);
  const channel = await guild.channels.create({
    name: taken ? `${base}-${member.id.slice(-4)}` : base,
    type: ChannelType.GuildText,
    parent: config.ticket_category_id,
    topic: `${TYPE_LABELS[type]} ticket from ${member.user.tag} (${member.id})`,
    permissionOverwrites: overwrites(guild, member.id, staffRoleIds),
    reason: `Ticket opened by ${member.user.tag}`,
  });
  const ticket = ticketRepository.createTicket({ guildId: guild.id, channelId: channel.id, creatorId: member.id, type, platform, details, attachmentUrls });
  await channel.send({ embeds: [ticketEmbed(ticket, member.user)], components: ticketControls(), allowedMentions: { users: [member.id], parse: [] } });
  // Re-upload the submitted files as normal channel attachments immediately
  // after the embed, so Discord displays images/videos natively instead of
  // reducing them to "Attachment 1" links inside the ticket information.
  if (attachmentUrls.length > 0) {
    await channel.send({ files: attachmentUrls, allowedMentions: { parse: [] } });
  }
  return { ticket, channel };
}

async function closeTicket(guild, channel, ticket, closerId) {
  const closed = ticketRepository.closeTicket(channel.id, closerId);
  await channel.permissionOverwrites.delete(ticket.creator_id, 'Ticket closed; creator access removed');
  return closed;
}

async function deleteTicket(channel, reason) {
  ticketRepository.deleteTicket(channel.id);
  await channel.delete(reason);
}

module.exports = { TYPE_LABELS, PLATFORM_LABELS, TICKET_COLOR, createTicket, closeTicket, deleteTicket, ticketEmbed, ticketControls };
