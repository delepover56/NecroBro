'use strict';

const { FileUploadBuilder, LabelBuilder, ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const { IDS } = require('../config');
const configRepository = require('../database/config');
const tickets = require('../database/tickets');
const ticketService = require('../services/ticketService');
const { isStaff } = require('../utils/permissions');
const { deferEphemeral, failure, success } = require('../utils/respond');

const TYPES = new Set(['REPORT', 'SUPPORT', 'APPEAL']);
const creating = new Set();

function ticketModal(type) {
  const platform = new StringSelectMenuBuilder().setCustomId(IDS.TICKET_PLATFORM).setPlaceholder('Choose a platform').setMinValues(1).setMaxValues(1).addOptions(
    new StringSelectMenuOptionBuilder().setLabel('Minecraft Survival').setValue('MINECRAFT_SURVIVAL'),
    new StringSelectMenuOptionBuilder().setLabel('Discord').setValue('DISCORD'),
  );
  const details = new TextInputBuilder().setCustomId(IDS.TICKET_DETAILS).setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(10).setMaxLength(4000).setPlaceholder('Explain the issue clearly, including names, dates, and relevant details.');
  const files = new FileUploadBuilder().setCustomId(IDS.TICKET_FILES).setRequired(false).setMinValues(0).setMaxValues(5);
  return new ModalBuilder().setCustomId(`${IDS.TICKET_MODAL}:${type}`).setTitle(`${ticketService.TYPE_LABELS[type]} Ticket`).addLabelComponents(
    new LabelBuilder().setLabel('Platform').setDescription('Where did this happen?').setStringSelectMenuComponent(platform),
    new LabelBuilder().setLabel('Details').setDescription('Give staff enough information to investigate.').setTextInputComponent(details),
    new LabelBuilder().setLabel('Attachments (optional)').setDescription('Upload screenshots, images, or videos (up to five).').setFileUploadComponent(files),
  );
}

async function open(interaction, [type]) {
  if (!TYPES.has(type)) return failure(interaction, 'Unknown ticket type.');
  if (!configRepository.getGuildConfig(interaction.guild.id)?.ticket_category_id) return failure(interaction, 'Tickets have not been set up. Ask an Admin to run `/setup-tickets`.');
  return interaction.showModal(ticketModal(type));
}

async function submit(interaction, [type]) {
  if (!TYPES.has(type)) return failure(interaction, 'Unknown ticket type.');
  if (!(await deferEphemeral(interaction))) return undefined;
  if (creating.has(interaction.user.id)) return failure(interaction, 'Your ticket is already being created.');
  if (tickets.getOpenTicketForCreator(interaction.guild.id, interaction.user.id)) return failure(interaction, 'You already have an open ticket. Close it before opening another.');
  creating.add(interaction.user.id);
  try {
    const platform = interaction.fields.getStringSelectValues(IDS.TICKET_PLATFORM)?.[0];
    const details = interaction.fields.getTextInputValue(IDS.TICKET_DETAILS)?.trim();
    const files = interaction.fields.getUploadedFiles(IDS.TICKET_FILES, false);
    if (!['MINECRAFT_SURVIVAL', 'DISCORD'].includes(platform) || !details || details.length < 10) return failure(interaction, 'Choose a platform and provide at least 10 characters of detail.');
    const attachmentUrls = files ? [...files.values()].map((file) => file.url) : [];
    const { channel } = await ticketService.createTicket(interaction.guild, interaction.member, { type, platform, details, attachmentUrls });
    return success(interaction, `Your private ticket is ready: <#${channel.id}>`);
  } catch (error) {
    return failure(interaction, `I could not create your ticket. ${error.message}`);
  } finally { creating.delete(interaction.user.id); }
}

async function close(interaction) {
  const ticket = tickets.getTicketByChannel(interaction.channelId);
  if (!ticket) return failure(interaction, 'This is not a ticket channel.');
  if (ticket.creator_id !== interaction.user.id && !isStaff(interaction.member)) return failure(interaction, 'Only the ticket creator or staff can close this ticket.');
  if (!(await deferEphemeral(interaction))) return undefined;
  if (ticket.status === 'CLOSED') return failure(interaction, 'This ticket is already closed.');
  await ticketService.closeTicket(interaction.guild, interaction.channel, ticket, interaction.user.id);
  await interaction.message.edit({ components: [] }).catch(() => undefined);
  return success(interaction, 'Ticket closed. The creator no longer has access; staff can keep the channel as a record or delete it.');
}

async function remove(interaction) {
  const ticket = tickets.getTicketByChannel(interaction.channelId);
  if (!ticket) return failure(interaction, 'This is not a ticket channel.');
  if (!isStaff(interaction.member)) return failure(interaction, 'Only staff can delete ticket channels.');
  if (!(await deferEphemeral(interaction))) return undefined;
  await success(interaction, 'Ticket channel is being deleted.');
  await ticketService.deleteTicket(interaction.channel, `Ticket deleted by ${interaction.user.tag}`);
  return undefined;
}

module.exports = { buttonPrefixes: { [IDS.TICKET_OPEN]: open }, buttons: { [IDS.TICKET_CLOSE]: close, [IDS.TICKET_DELETE]: remove }, modalPrefixes: { [IDS.TICKET_MODAL]: submit }, ticketModal };
