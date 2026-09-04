'use strict';

const { InteractionType } = require('discord.js');

const { COMPONENT_NAMESPACES } = require('../config');
const { ArgumentError, resolveSlashArgs } = require('../core/args');
const { CommandContext } = require('../core/commandContext');
const registry = require('../core/commandRegistry');
const { dispatch, handleError } = require('../core/dispatcher');
const settingsRepository = require('../database/settings');
const { createLogger } = require('../utils/logger');
const { failure } = require('../utils/respond');

const log = createLogger('router');

/**
 * Central interaction router.
 *
 * Component/modal handler modules export any of:
 *   `buttons` / `selects` / `modals`          -- exact custom ID match
 *   `buttonPrefixes` / `selectPrefixes` / `modalPrefixes`
 *                                             -- `prefix:arg1:arg2` match
 * A module's custom IDs must start with one of the namespaces declared in
 * `COMPONENT_NAMESPACES`; anything else is ignored so foreign bots' components
 * never produce error replies.
 *
 * Slash commands go through the shared command registry + dispatcher, the
 * same path prefix commands take.
 */
const MODULES = [
  require('./suggestionPanel'),
  require('./suggestionModal'),
  require('./suggestionVoting'),
  require('./suggestionStaff'),
  require('./tickets'),
  require('./help'),
  ...loadOptional('./leaderboard'),
  ...loadOptional('./giveaway'),
  ...loadOptional('./moderation'),
];

/** Feature modules that may not exist yet resolve to nothing instead of crashing. */
function loadOptional(modulePath) {
  try {
    return [require(modulePath)];
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && String(error.message).includes(modulePath.slice(2))) {
      return [];
    }
    throw error;
  }
}

function collect(key) {
  return MODULES.reduce((acc, mod) => Object.assign(acc, mod[key] ?? {}), {});
}

const registryOfComponents = {
  buttons: collect('buttons'),
  selects: collect('selects'),
  modals: collect('modals'),
  buttonPrefixes: collect('buttonPrefixes'),
  selectPrefixes: collect('selectPrefixes'),
  modalPrefixes: collect('modalPrefixes'),
};

const NAMESPACES = Object.values(COMPONENT_NAMESPACES).map((ns) => `${ns}:`);

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

function isOurs(customId) {
  return typeof customId === 'string' && NAMESPACES.some((ns) => customId.startsWith(ns));
}

/* ------------------------------------------------------------------ *
 * Slash commands
 * ------------------------------------------------------------------ */

async function handleCommand(interaction) {
  const command = registry.get(interaction.commandName);
  if (!command) {
    log.warn(`Received an unknown command: /${interaction.commandName}`);
    return failure(interaction, 'That command is not available right now. Try `npm run deploy` to refresh commands.');
  }

  let subcommand = null;
  let schema = command.args ?? [];
  if (command.subcommands) {
    const name = interaction.options.getSubcommand(false);
    subcommand = registry.findSubcommand(command, name) ?? null;
    if (!subcommand) return failure(interaction, 'Unknown subcommand.');
    schema = subcommand.args;
  }

  const ctx = new CommandContext({
    kind: 'slash',
    interaction,
    command,
    subcommand: subcommand?.name ?? null,
    values: {},
    prefix: settingsRepository.getPrefix(interaction.guildId),
  });

  try {
    ctx.values = resolveSlashArgs(schema, interaction).values;
  } catch (error) {
    if (error instanceof ArgumentError) return handleError(ctx, error);
    throw error;
  }

  return dispatch(ctx);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) return await failure(interaction, 'Commands only work inside a server.');
      return await handleCommand(interaction);
    }

    if (!isOurs(interaction.customId)) return undefined;

    if (!interaction.inGuild()) {
      return await failure(interaction, 'These controls only work inside a server.');
    }

    let route = null;
    if (interaction.isButton()) {
      route = resolve(interaction.customId, registryOfComponents.buttons, registryOfComponents.buttonPrefixes);
    } else if (interaction.isStringSelectMenu()) {
      route = resolve(interaction.customId, registryOfComponents.selects, registryOfComponents.selectPrefixes);
    } else if (interaction.type === InteractionType.ModalSubmit) {
      route = resolve(interaction.customId, registryOfComponents.modals, registryOfComponents.modalPrefixes);
    }

    if (!route) {
      log.warn(`No handler for custom ID "${interaction.customId}".`);
      return await failure(interaction, 'This control is no longer available.');
    }

    return await route.handler(interaction, route.args);
  } catch (error) {
    log.error(`Unhandled error while processing interaction ${interaction.id}:`, error);
    if (interaction.isRepliable?.()) {
      await failure(interaction, 'Something went wrong handling that action. The error has been logged.');
    }
    return undefined;
  }
}

module.exports = { handleInteraction, registry: registryOfComponents };
