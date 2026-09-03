'use strict';

const { MessageFlags } = require('discord.js');

const { buildNoticeEmbed } = require('./embeds');
const { createLogger } = require('./logger');

const log = createLogger('respond');

/**
 * Interaction reply helpers.
 *
 * Discord interactions fail hard if you reply twice, reply after deferring, or
 * reply to an expired token. These wrappers pick the correct method and never
 * throw into the caller, so a failed *reply* can never mask the original error.
 */

/** Replies (or follows up / edits) with an ephemeral message. */
async function respond(interaction, payload) {
  const body = { ...payload, flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred) return await interaction.editReply(stripFlags(body));
    if (interaction.replied) return await interaction.followUp(body);
    return await interaction.reply(body);
  } catch (error) {
    log.warn(`Could not respond to interaction ${interaction.id}:`, error);
    return null;
  }
}

/** `editReply` rejects the ephemeral flag; drop it when editing. */
function stripFlags({ flags, ...rest }) {
  return rest;
}

const success = (interaction, message, extra = {}) =>
  respond(interaction, { embeds: [buildNoticeEmbed('success', message)], ...extra });

const info = (interaction, message, extra = {}) =>
  respond(interaction, { embeds: [buildNoticeEmbed('info', message)], ...extra });

const failure = (interaction, message, extra = {}) =>
  respond(interaction, { embeds: [buildNoticeEmbed('error', message)], ...extra });

/**
 * Defers an interaction ephemerally, reporting whether it succeeded.
 * A `false` return means the token is already dead -- stop working on it.
 */
async function deferEphemeral(interaction) {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (error) {
    log.warn(`Could not defer interaction ${interaction.id}:`, error);
    return false;
  }
}

/** Acknowledges a component press without changing the message. */
async function deferComponentUpdate(interaction) {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferUpdate();
    return true;
  } catch (error) {
    log.warn(`Could not acknowledge component ${interaction.id}:`, error);
    return false;
  }
}

module.exports = { respond, success, info, failure, deferEphemeral, deferComponentUpdate };
