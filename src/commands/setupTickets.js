'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits } = require('discord.js');

const { BRAND, IDS } = require('../config');
const configRepository = require('../database/config');
const { missingBotPermissions, resolveStaffRoles } = require('../utils/permissions');

const REQUIRED = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function panelEmbed() {
  return new EmbedBuilder().setColor(0x9900ff).setTitle('Support Tickets').setDescription('Choose the type of ticket you need. A private channel will be created for you and staff.').addFields(
    { name: 'Report', value: 'Report a player, member, or problem.' },
    { name: 'Support', value: 'Get help with Minecraft Survival or Discord.' },
    { name: 'Appeal', value: 'Appeal a moderation action.' },
  ).setFooter({ text: BRAND.name });
}

function panelControls() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${IDS.TICKET_OPEN}:REPORT`).setLabel('Report').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${IDS.TICKET_OPEN}:SUPPORT`).setLabel('Support').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${IDS.TICKET_OPEN}:APPEAL`).setLabel('Appeal').setStyle(ButtonStyle.Secondary),
  )];
}

module.exports = {
  name: 'setup-tickets', category: 'admin', description: 'Create or repair the private ticket panel and category.', permission: 'admin', botPermissions: REQUIRED,
  args: [{ name: 'channel', type: 'channel', description: 'Channel for the ticket panel (default: #tickets).', required: false, channelTypes: [ChannelType.GuildText] }],
  examples: ['setup-tickets', 'setup-tickets #tickets'],
  async execute(ctx) {
    await ctx.defer({ ephemeral: true });
    const missing = missingBotPermissions(ctx.guild, REQUIRED);
    if (missing.length) return ctx.failure(`I need **${missing.join('**, **')}** before I can set up tickets.`);
    const config = configRepository.ensureGuildConfig(ctx.guild.id);
    const staffRoleIds = resolveStaffRoles(ctx.guild, config);
    let category = config.ticket_category_id ? await ctx.guild.channels.fetch(config.ticket_category_id).catch(() => null) : null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      category = await ctx.guild.channels.create({
        name: 'TICKETS', type: ChannelType.GuildCategory,
        permissionOverwrites: [{ id: ctx.guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] }, ...staffRoleIds.map((id) => ({ id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] }))],
        reason: 'Ticket system setup',
      });
    }
    const supplied = ctx.get('channel');
    const panel = supplied ?? (config.ticket_channel_id ? await ctx.guild.channels.fetch(config.ticket_channel_id).catch(() => null) : null) ?? await ctx.guild.channels.create({ name: 'tickets', type: ChannelType.GuildText, reason: 'Ticket system setup' });
    let message = config.ticket_panel_message_id ? await panel.messages.fetch(config.ticket_panel_message_id).catch(() => null) : null;
    if (message) await message.edit({ embeds: [panelEmbed()], components: panelControls() });
    else message = await panel.send({ embeds: [panelEmbed()], components: panelControls() });
    configRepository.updateGuildConfig(ctx.guild.id, { ticket_channel_id: panel.id, ticket_category_id: category.id, ticket_panel_message_id: message.id });
    return ctx.success(`Ticket system ready. Panel: ${panel}\nPrivate category: ${category}`);
  },
  panelEmbed, panelControls,
};
