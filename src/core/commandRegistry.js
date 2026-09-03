'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { InteractionContextType, SlashCommandBuilder } = require('discord.js');

const { COMMAND_CATEGORIES, PERMISSION_LEVELS } = require('../config');
const { createLogger } = require('../utils/logger');
const { applySlashOptions, usageFor } = require('./args');

const log = createLogger('registry');

/**
 * Command registry.
 *
 * A command module (anywhere under `src/commands/`) exports one object or an
 * array of objects shaped like:
 *
 *   {
 *     name: 'mute',                 // slash name and prefix word
 *     aliases: ['m'],               // prefix-only aliases (optional)
 *     category: 'moderation',       // key of COMMAND_CATEGORIES
 *     description: 'Mute a member with the configured Mute role.',
 *     permission: 'moderator',      // everyone | moderator | admin | owner
 *     cooldown: 3,                  // seconds per user (optional)
 *     botPermissions: [PermissionFlagsBits.ManageRoles],   // optional
 *     args: [ { name, type, description, required, ... } ], // see core/args.js
 *     // -- or, for grouped commands --
 *     subcommands: [ { name, description, aliases?, args } ],
 *     defaultSubcommand: 'status',  // used when the prefix form omits one
 *     examples: ['mute @user 10h spamming'],   // prefix-form examples (no prefix)
 *     hidden: false,                // omit from /help
 *     async execute(ctx) { ... },   // ctx: core/commandContext.js
 *   }
 *
 * From that one declaration the registry derives the slash-command payload
 * (`toSlashJSON`) and the prefix parser's schema, so nothing is written twice.
 */

const SLASH_NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

const commands = new Map();
const aliases = new Map();

function validateArgs(schema, owner) {
  const seen = new Set();
  schema.forEach((arg, index) => {
    if (!arg?.name || !arg?.type) throw new Error(`${owner}: argument #${index} needs name and type.`);
    if (arg.name !== arg.name.toLowerCase()) throw new Error(`${owner}: argument "${arg.name}" must be lowercase.`);
    if (seen.has(arg.name)) throw new Error(`${owner}: duplicate argument "${arg.name}".`);
    seen.add(arg.name);
    if (arg.type === 'text' && index !== schema.length - 1) {
      throw new Error(`${owner}: "text" argument "${arg.name}" must be the last argument.`);
    }
  });
}

function validateCommand(command, file) {
  const where = `${path.basename(file)} (${command?.name ?? '?'})`;
  if (!command?.name || !SLASH_NAME.test(command.name) || command.name !== command.name.toLowerCase()) {
    throw new Error(`${where}: invalid command name.`);
  }
  if (typeof command.execute !== 'function') throw new Error(`${where}: missing execute().`);
  if (!command.description) throw new Error(`${where}: missing description.`);
  if (!COMMAND_CATEGORIES[command.category]) throw new Error(`${where}: unknown category "${command.category}".`);
  if (!PERMISSION_LEVELS[command.permission ?? 'everyone']) {
    throw new Error(`${where}: unknown permission "${command.permission}".`);
  }
  if (command.args && command.subcommands) throw new Error(`${where}: use args OR subcommands.`);
  if (command.args) validateArgs(command.args, where);
  if (command.subcommands) {
    if (!Array.isArray(command.subcommands) || command.subcommands.length === 0) {
      throw new Error(`${where}: subcommands must be a non-empty array.`);
    }
    for (const sub of command.subcommands) {
      if (!sub?.name || !SLASH_NAME.test(sub.name)) throw new Error(`${where}: bad subcommand name.`);
      if (!sub.description) throw new Error(`${where}: subcommand "${sub.name}" needs a description.`);
      validateArgs(sub.args ?? [], `${where}/${sub.name}`);
    }
    if (command.defaultSubcommand && !command.subcommands.some((s) => s.name === command.defaultSubcommand)) {
      throw new Error(`${where}: defaultSubcommand "${command.defaultSubcommand}" does not exist.`);
    }
  }
}

/** Normalises optional fields so consumers never need null checks. */
function normalizeCommand(command) {
  return {
    aliases: [],
    permission: PERMISSION_LEVELS.everyone.key,
    cooldown: 0,
    botPermissions: [],
    examples: [],
    hidden: false,
    ...command,
    args: command.args ?? null,
    subcommands: command.subcommands
      ? command.subcommands.map((sub) => ({ aliases: [], args: [], ...sub }))
      : null,
  };
}

function register(command, file = 'inline') {
  validateCommand(command, file);
  const normalized = normalizeCommand(command);

  if (commands.has(normalized.name) || aliases.has(normalized.name)) {
    throw new Error(`Duplicate command name "${normalized.name}" in ${path.basename(file)}.`);
  }
  commands.set(normalized.name, normalized);

  for (const alias of normalized.aliases) {
    if (commands.has(alias) || aliases.has(alias)) {
      throw new Error(`Alias "${alias}" of ${normalized.name} collides with another command.`);
    }
    aliases.set(alias, normalized.name);
  }
  return normalized;
}

/** Recursively loads every command module under `directory`. */
function loadCommands(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      loadCommands(full);
      continue;
    }
    if (!entry.name.endsWith('.js') || entry.name === 'index.js') continue;

    const exported = require(full);
    const list = Array.isArray(exported) ? exported : [exported];
    for (const command of list) {
      if (!command || typeof command !== 'object') continue;
      register(command, full);
      log.debug(`Registered command ${command.name} from ${path.relative(process.cwd(), full)}`);
    }
  }

  return commands;
}

/** Looks up a command by name or prefix alias. */
function get(nameOrAlias) {
  const key = String(nameOrAlias ?? '').toLowerCase();
  return commands.get(key) ?? commands.get(aliases.get(key)) ?? null;
}

function all() {
  return [...commands.values()];
}

/** Commands grouped by category, ordered as COMMAND_CATEGORIES declares. */
function byCategory({ includeHidden = false } = {}) {
  const groups = new Map();
  for (const category of Object.values(COMMAND_CATEGORIES).sort((a, b) => a.order - b.order)) {
    groups.set(category.key, { category, commands: [] });
  }
  for (const command of all()) {
    if (command.hidden && !includeHidden) continue;
    groups.get(command.category).commands.push(command);
  }
  for (const group of groups.values()) {
    group.commands.sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups;
}

/** Finds a subcommand by name or alias. */
function findSubcommand(command, word) {
  if (!command.subcommands) return null;
  const key = String(word ?? '').toLowerCase();
  return (
    command.subcommands.find((sub) => sub.name === key || sub.aliases.includes(key)) ?? null
  );
}

/** Builds the slash-command payload for one command. */
function toSlashJSON(command) {
  const builder = new SlashCommandBuilder()
    .setName(command.name)
    .setDescription(truncate(command.description, 100))
    .setContexts(InteractionContextType.Guild);

  if (command.subcommands) {
    for (const sub of command.subcommands) {
      builder.addSubcommand((subBuilder) => {
        subBuilder.setName(sub.name).setDescription(truncate(sub.description, 100));
        applySlashOptions(subBuilder, sub.args);
        return subBuilder;
      });
    }
  } else if (command.args) {
    applySlashOptions(builder, command.args);
  }

  return builder.toJSON();
}

/** Usage line for help output, e.g. `mute <user> <duration> [reason]`. */
function usage(command, subcommand = null) {
  if (subcommand) return `${command.name} ${subcommand.name} ${usageFor(subcommand.args)}`.trim();
  if (command.subcommands) {
    return `${command.name} <${command.subcommands.map((s) => s.name).join('|')}>`;
  }
  return `${command.name} ${usageFor(command.args ?? [])}`.trim();
}

function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Test helper: forgets every registered command. */
function reset() {
  commands.clear();
  aliases.clear();
}

module.exports = {
  register,
  loadCommands,
  get,
  all,
  byCategory,
  findSubcommand,
  toSlashJSON,
  usage,
  reset,
  get size() {
    return commands.size;
  },
};
