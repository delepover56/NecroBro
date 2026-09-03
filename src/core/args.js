'use strict';

const { ChannelType } = require('discord.js');

const { parseDuration } = require('../utils/duration');

/**
 * One argument schema, two front-ends.
 *
 * A command declares its arguments once (see `commandRegistry.js` for the
 * shape). From that single declaration this module:
 *   - builds the slash-command options (`applySlashOptions`)
 *   - reads them back from an interaction (`resolveSlashArgs`)
 *   - tokenises and resolves a prefix invocation (`resolvePrefixArgs`)
 * so both paths hand the command an identical `values` object.
 *
 * Supported `type`s:
 *   member    GuildMember (mention / ID / name)
 *   user      User (mention / ID) - works for people not in the server
 *   role      Role (mention / ID / name)
 *   channel   GuildChannel (mention / ID / name)
 *   string    single token; `choices: [{name, value}]` restricts it
 *   text      greedy: everything that is left, joined with spaces (must be last)
 *   integer   whole number; `min`/`max`
 *   number    decimal number; `min`/`max`
 *   boolean   on/off, true/false, yes/no, enable/disable
 *   duration  "10h", "1d12h" -> milliseconds; `min`/`max` in ms
 *   literal   prefix-only filler word (e.g. "as" in `?setrole @Role as Admin`);
 *             consumed when present, never required, absent from slash commands
 */

const MENTION = {
  user: /^<@!?(\d{15,21})>$/,
  role: /^<@&(\d{15,21})>$/,
  channel: /^<#(\d{15,21})>$/,
  id: /^\d{15,21}$/,
};

/* ------------------------------------------------------------------ *
 * Tokeniser
 * ------------------------------------------------------------------ */

/**
 * Splits a command line into tokens, honouring "double" and 'single' quotes
 * so `"Discord Nitro"` stays one argument. Backslash escapes the next char.
 */
function tokenize(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (char === '\\' && i + 1 < input.length) {
      current += input[i + 1];
      hasToken = true;
      i += 1;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (hasToken) tokens.push(current);
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Shared resolvers
 * ------------------------------------------------------------------ */

class ArgumentError extends Error {
  constructor(message, argName) {
    super(message);
    this.name = 'ArgumentError';
    this.argName = argName;
    this.userFacing = true;
  }
}

function findByName(collection, name, ...keys) {
  const needle = name.toLowerCase();
  return (
    collection.find((item) => keys.some((key) => item[key]?.toLowerCase?.() === needle)) ??
    collection.find((item) => keys.some((key) => item[key]?.toLowerCase?.().startsWith(needle))) ??
    null
  );
}

async function resolveMember(token, { guild }) {
  const id = token.match(MENTION.user)?.[1] ?? token.match(MENTION.id)?.[0];
  if (id) {
    const cached = guild.members.cache.get(id);
    if (cached) return cached;
    try {
      return await guild.members.fetch(id);
    } catch {
      return null;
    }
  }

  const name = token.replace(/^@/, '');
  const cached = findByName(guild.members.cache, name, 'displayName');
  if (cached) return cached;
  const byUsername = guild.members.cache.find(
    (member) => member.user.username.toLowerCase() === name.toLowerCase(),
  );
  if (byUsername) return byUsername;

  try {
    const results = await guild.members.fetch({ query: name, limit: 5 });
    return findByName(results, name, 'displayName') ?? results.first() ?? null;
  } catch {
    return null;
  }
}

async function resolveUser(token, { guild, client }) {
  const id = token.match(MENTION.user)?.[1] ?? token.match(MENTION.id)?.[0];
  if (id) {
    const cached = guild.members.cache.get(id)?.user;
    if (cached) return cached;
    try {
      return (await client.users.fetch(id)) ?? null;
    } catch {
      return null;
    }
  }
  const member = await resolveMember(token, { guild, client });
  return member?.user ?? null;
}

function resolveRole(token, { guild }) {
  const id = token.match(MENTION.role)?.[1] ?? token.match(MENTION.id)?.[0];
  if (id) return guild.roles.cache.get(id) ?? null;
  return findByName(guild.roles.cache, token.replace(/^@/, ''), 'name');
}

function resolveChannel(token, { guild }, channelTypes) {
  const id = token.match(MENTION.channel)?.[1] ?? token.match(MENTION.id)?.[0];
  let channel = null;
  if (id) channel = guild.channels.cache.get(id) ?? null;
  else channel = findByName(guild.channels.cache, token.replace(/^#/, ''), 'name');
  if (channel && channelTypes?.length && !channelTypes.includes(channel.type)) return null;
  return channel;
}

function parseBoolean(token) {
  const value = token.toLowerCase();
  if (['on', 'true', 'yes', 'enable', 'enabled', '1'].includes(value)) return true;
  if (['off', 'false', 'no', 'disable', 'disabled', '0'].includes(value)) return false;
  return null;
}

function matchChoice(arg, raw) {
  if (!arg.choices?.length) return raw;
  const needle = String(raw).toLowerCase();
  const hit = arg.choices.find(
    (choice) =>
      String(choice.value).toLowerCase() === needle || choice.name.toLowerCase() === needle,
  );
  return hit ? hit.value : undefined;
}

function checkRange(arg, value) {
  if (arg.min !== undefined && value < arg.min) {
    throw new ArgumentError(`\`${arg.name}\` must be at least ${arg.min}.`, arg.name);
  }
  if (arg.max !== undefined && value > arg.max) {
    throw new ArgumentError(`\`${arg.name}\` must be at most ${arg.max}.`, arg.name);
  }
  return value;
}

function describeChoices(arg) {
  return arg.choices.map((choice) => `\`${choice.name}\``).join(', ');
}

/* ------------------------------------------------------------------ *
 * Prefix front-end
 * ------------------------------------------------------------------ */

/**
 * Resolves a token list against a schema.
 * Returns `{ values }`; throws `ArgumentError` on the first problem.
 */
async function resolvePrefixArgs(schema, tokens, context) {
  const values = {};
  let index = 0;

  for (let position = 0; position < schema.length; position += 1) {
    const arg = schema[position];
    const remaining = tokens.slice(index);

    if (arg.type === 'literal') {
      if (remaining[0]?.toLowerCase() === String(arg.value).toLowerCase()) {
        values[arg.name] = true;
        index += 1;
      } else {
        values[arg.name] = false;
      }
      continue;
    }

    if (arg.type === 'text') {
      const text = remaining.join(' ').trim();
      if (!text) {
        if (arg.required) throw new ArgumentError(`Missing \`${arg.name}\`.`, arg.name);
        values[arg.name] = arg.default ?? null;
      } else {
        values[arg.name] = arg.max ? text.slice(0, arg.max) : text;
      }
      index = tokens.length;
      continue;
    }

    const token = remaining[0];
    if (token === undefined) {
      if (arg.required) {
        throw new ArgumentError(
          `Missing \`${arg.name}\`${arg.choices ? ` (one of ${describeChoices(arg)})` : ''}.`,
          arg.name,
        );
      }
      values[arg.name] = arg.default ?? null;
      continue;
    }

    const resolved = await resolveToken(arg, token, context);
    if (resolved === undefined) {
      // Optional argument that did not match: leave the token for the next arg.
      if (!arg.required) {
        values[arg.name] = arg.default ?? null;
        continue;
      }
      throw new ArgumentError(invalidMessage(arg, token), arg.name);
    }

    values[arg.name] = resolved;
    index += 1;
  }

  return { values, leftover: tokens.slice(index) };
}

function invalidMessage(arg, token) {
  switch (arg.type) {
    case 'member':
      return `Could not find a member matching \`${token}\`.`;
    case 'user':
      return `Could not find a user matching \`${token}\`.`;
    case 'role':
      return `Could not find a role matching \`${token}\`.`;
    case 'channel':
      return `Could not find a channel matching \`${token}\`.`;
    case 'integer':
      return `\`${arg.name}\` must be a whole number (got \`${token}\`).`;
    case 'number':
      return `\`${arg.name}\` must be a number (got \`${token}\`).`;
    case 'boolean':
      return `\`${arg.name}\` must be on or off.`;
    case 'duration':
      return `\`${token}\` is not a valid duration. Try \`10m\`, \`2h\`, \`1d12h\`.`;
    default:
      return arg.choices
        ? `\`${arg.name}\` must be one of ${describeChoices(arg)}.`
        : `Invalid value for \`${arg.name}\`.`;
  }
}

/** Resolves one token for one schema entry; `undefined` means "no match". */
async function resolveToken(arg, token, context) {
  switch (arg.type) {
    case 'member':
      return (await resolveMember(token, context)) ?? undefined;
    case 'user':
      return (await resolveUser(token, context)) ?? undefined;
    case 'role':
      return resolveRole(token, context) ?? undefined;
    case 'channel':
      return resolveChannel(token, context, arg.channelTypes) ?? undefined;
    case 'integer': {
      if (!/^-?\d+$/.test(token)) return undefined;
      return checkRange(arg, Number.parseInt(token, 10));
    }
    case 'number': {
      const value = Number.parseFloat(token);
      if (!Number.isFinite(value)) return undefined;
      return checkRange(arg, value);
    }
    case 'boolean': {
      const value = parseBoolean(token);
      return value === null ? undefined : value;
    }
    case 'duration': {
      const ms = parseDuration(token);
      if (ms === null) return undefined;
      return checkRange(arg, ms);
    }
    case 'string': {
      const value = matchChoice(arg, token);
      if (value === undefined) return undefined;
      return arg.max ? String(value).slice(0, arg.max) : value;
    }
    default:
      throw new TypeError(`Unsupported argument type "${arg.type}" for "${arg.name}".`);
  }
}

/* ------------------------------------------------------------------ *
 * Slash front-end
 * ------------------------------------------------------------------ */

/** Adds the schema's options to a slash (sub)command builder. */
function applySlashOptions(builder, schema) {
  let sawOptional = false;
  for (const arg of schema) {
    if (arg.type === 'literal') continue;
    const required = Boolean(arg.required);
    if (!required) sawOptional = true;
    else if (sawOptional) {
      throw new Error(
        `Argument "${arg.name}" is required but follows an optional argument; ` +
          'Discord requires required options first.',
      );
    }

    const base = (option) =>
      option.setName(arg.name).setDescription(truncate(arg.description ?? arg.name, 100)).setRequired(required);

    switch (arg.type) {
      case 'member':
      case 'user':
        builder.addUserOption(base);
        break;
      case 'role':
        builder.addRoleOption(base);
        break;
      case 'channel':
        builder.addChannelOption((option) => {
          base(option);
          if (arg.channelTypes?.length) option.addChannelTypes(...arg.channelTypes);
          return option;
        });
        break;
      case 'integer':
        builder.addIntegerOption((option) => {
          base(option);
          if (arg.min !== undefined) option.setMinValue(arg.min);
          if (arg.max !== undefined) option.setMaxValue(arg.max);
          return option;
        });
        break;
      case 'number':
        builder.addNumberOption((option) => {
          base(option);
          if (arg.min !== undefined) option.setMinValue(arg.min);
          if (arg.max !== undefined) option.setMaxValue(arg.max);
          return option;
        });
        break;
      case 'boolean':
        builder.addBooleanOption(base);
        break;
      case 'string':
      case 'text':
      case 'duration':
        builder.addStringOption((option) => {
          base(option);
          if (arg.choices?.length) {
            option.addChoices(
              ...arg.choices.map((choice) => ({ name: choice.name, value: String(choice.value) })),
            );
          }
          if (arg.type !== 'duration' && arg.max) option.setMaxLength(Math.min(arg.max, 6000));
          return option;
        });
        break;
      default:
        throw new TypeError(`Unsupported argument type "${arg.type}" for "${arg.name}".`);
    }
  }
  return builder;
}

/** Reads a schema's values from a chat-input interaction. */
function resolveSlashArgs(schema, interaction) {
  const values = {};
  const { options } = interaction;

  for (const arg of schema) {
    if (arg.type === 'literal') {
      values[arg.name] = true;
      continue;
    }

    switch (arg.type) {
      case 'member': {
        const member = options.getMember(arg.name);
        const user = options.getUser(arg.name);
        if (user && !member) {
          throw new ArgumentError(`${user} is not a member of this server.`, arg.name);
        }
        values[arg.name] = member ?? arg.default ?? null;
        break;
      }
      case 'user':
        values[arg.name] = options.getUser(arg.name) ?? arg.default ?? null;
        break;
      case 'role':
        values[arg.name] = options.getRole(arg.name) ?? arg.default ?? null;
        break;
      case 'channel':
        values[arg.name] = options.getChannel(arg.name) ?? arg.default ?? null;
        break;
      case 'integer':
        values[arg.name] = options.getInteger(arg.name) ?? arg.default ?? null;
        break;
      case 'number':
        values[arg.name] = options.getNumber(arg.name) ?? arg.default ?? null;
        break;
      case 'boolean':
        values[arg.name] = options.getBoolean(arg.name) ?? arg.default ?? null;
        break;
      case 'duration': {
        const raw = options.getString(arg.name);
        if (raw === null) {
          values[arg.name] = arg.default ?? null;
          break;
        }
        const ms = parseDuration(raw);
        if (ms === null) throw new ArgumentError(invalidMessage(arg, raw), arg.name);
        values[arg.name] = checkRange(arg, ms);
        break;
      }
      case 'string':
      case 'text': {
        const raw = options.getString(arg.name);
        if (raw === null) {
          values[arg.name] = arg.default ?? null;
          break;
        }
        const value = matchChoice(arg, raw);
        if (value === undefined) throw new ArgumentError(invalidMessage(arg, raw), arg.name);
        values[arg.name] = arg.max ? String(value).slice(0, arg.max) : value;
        break;
      }
      default:
        throw new TypeError(`Unsupported argument type "${arg.type}" for "${arg.name}".`);
    }
  }

  return { values, leftover: [] };
}

function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Renders a schema as usage text: `<user> <duration> [reason]`. */
function usageFor(schema) {
  return schema
    .map((arg) => {
      if (arg.type === 'literal') return arg.value;
      const label = arg.choices ? arg.choices.map((c) => c.value).join('|') : arg.name;
      return arg.required ? `<${label}>` : `[${label}]`;
    })
    .join(' ');
}

module.exports = {
  ArgumentError,
  ChannelType,
  tokenize,
  resolvePrefixArgs,
  resolveSlashArgs,
  applySlashOptions,
  usageFor,
  resolveMember,
  resolveUser,
  resolveRole,
  resolveChannel,
};
