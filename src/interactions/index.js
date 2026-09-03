'use strict';

const { InteractionType } = require('discord.js');

const { IDS } = require('../config');
const { createLogger } = require('../utils/logger');
const { failure } = require('../utils/respond');

const suggestionPanel = require('./suggestionPanel');
const suggestionModal = require('./suggestionModal');
const suggestionVoting = require('./suggestionVoting');
const suggestionStaff = require('./suggestionStaff');

const log = createLogger('router');

/**
 * Central interaction router.
 *
 * Handler modules export any of:
 *   `buttons` / `selects` / `modals`          -- exact custom ID match
 *   `buttonPrefixes` / `selectPrefixes` / `modalPrefixes`
 *                                             -- `prefix:arg1:arg2` match
 * so adding a future feature is a matter of dropping in another module.
 */
const MODULES = [suggestionPanel, suggestionModal, suggestionVoting, suggestionStaff];

function collect(key) {
  return MODULES.reduce((acc, mod) => Object.assign(acc, mod[key] ?? {}), {});
}

const registry = {
  buttons: collect('buttons'),
  selects: collect('selects'),
  modals: collect('modals'),
  buttonPrefixes: collect('buttonPrefixes'),
  selectPrefixes: collect('selectPrefixes'),
  modalPrefixes: collect('modalPrefixes'),
};

/** Finds an exact handler, then falls back to the longest matching prefix. */
function resolve(customId, exact, prefixes) {
  if (exact[customId]) return { handler: exact[customId], args: [] };

  const match = Object.keys(prefixes)
    .filter((prefix) => customId === prefix || customId.startsWith(`${prefix}:`))
    .sort((a, b) => b.length - a.length)[0];

  if (!match) return null;

  const rest = customId.slice(match.length + 1);
  return { handler: prefixes[match], args: rest === '' ? [] : rest.split(':') };
}

/** True for any component/modal this system owns. */
function isOurs(customId) {
  return typeof customId === 'string' && customId.startsWith(`${IDS.NAMESPACE}:`);
}

/** Routes a slash command to its handler in `client.commands`. */
async function handleCommand(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) {
    log.warn(`Received an unknown command: /${interaction.commandName}`);
    return failure(interaction, 'That command is not available right now.');
  }
  return command.execute(interaction);
}

/**
 * Single entry point wired to the `interactionCreate` event.
 * Every failure is contained here so one broken handler cannot crash the bot.
 */
async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      return await handleCommand(interaction);
    }

    if (!isOurs(interaction.customId)) return undefined;

    if (!interaction.inGuild()) {
      return await failure(interaction, 'The suggestion system only works inside a server.');
    }

    let route = null;
    if (interaction.isButton()) {
      route = resolve(interaction.customId, registry.buttons, registry.buttonPrefixes);
    } else if (interaction.isStringSelectMenu()) {
      route = resolve(interaction.customId, registry.selects, registry.selectPrefixes);
    } else if (interaction.type === InteractionType.ModalSubmit) {
      route = resolve(interaction.customId, registry.modals, registry.modalPrefixes);
    }

    if (!route) {
      log.warn(`No handler for custom ID "${interaction.customId}".`);
      return await failure(
        interaction,
        'This control is no longer available. Try using the suggestion panel again.',
      );
    }

    return await route.handler(interaction, route.args);
  } catch (error) {
    log.error(`Unhandled error while processing interaction ${interaction.id}:`, error);
    if (interaction.isRepliable?.()) {
      await failure(
        interaction,
        'Something went wrong handling that action. Staff have been notified in the logs.',
      );
    }
    return undefined;
  }
}

module.exports = { handleInteraction, registry };
