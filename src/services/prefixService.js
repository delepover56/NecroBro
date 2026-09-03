'use strict';

const { ChannelType } = require('discord.js');

const { DEFAULT_PREFIX, PREFIX_MAX_LENGTH } = require('../config');
const settingsRepository = require('../database/settings');
const { ArgumentError, resolvePrefixArgs, tokenize } = require('../core/args');
const { CommandContext } = require('../core/commandContext');
const registry = require('../core/commandRegistry');
const { dispatch, handleError } = require('../core/dispatcher');
const { createLogger } = require('../utils/logger');

const log = createLogger('prefix');

/**
 * Prefix (text) command front-end.
 *
 * `handleMessage()` decides whether a message is a command for the guild's
 * configured prefix (or a mention of the bot), parses it against the same
 * argument schema the slash command uses, and hands it to the dispatcher.
 * Returns `true` when the message was consumed as a command so callers can
 * skip chat rewards / automod for it.
 */

const COMMAND_WORD = /^[\p{L}\p{N}_-]{1,32}$/u;

/** Validates a proposed prefix; returns an error string or null. */
function validatePrefix(prefix) {
  if (typeof prefix !== 'string') return 'The prefix must be text.';
  const value = prefix.trim();
  if (value.length === 0) return 'The prefix cannot be empty or whitespace.';
  if (value !== prefix) return 'The prefix cannot start or end with whitespace.';
  if (value.length > PREFIX_MAX_LENGTH) return `The prefix must be ${PREFIX_MAX_LENGTH} characters or fewer.`;
  if (/\s/.test(value)) return 'The prefix cannot contain spaces.';
  if (/^[\p{L}\p{N}]/u.test(value)) {
    return 'The prefix cannot start with a letter or number — that would clash with normal chat.';
  }
  if (value === '/' || value.startsWith('/')) return 'The prefix cannot begin with `/` (reserved for slash commands).';
  if (value.startsWith('<') || value.startsWith('@') || value.startsWith('#')) {
    return 'The prefix cannot look like a mention.';
  }
  if (/[`*_~|]/.test(value)) return 'The prefix cannot contain Markdown characters.';
  return null;
}

/** Strips the prefix / bot mention; returns the remaining text or null. */
function stripPrefix(message, prefix) {
  const content = message.content;
  if (content.startsWith(prefix)) return content.slice(prefix.length);

  const botId = message.client.user?.id;
  if (!botId) return null;
  const mention = new RegExp(`^<@!?${botId}>\\s*`);
  const match = content.match(mention);
  if (match) return content.slice(match[0].length);
  return null;
}

/**
 * Handles one message. Returns true if it was treated as a command
 * (successfully or not), false if it is ordinary chat.
 */
async function handleMessage(message) {
  if (message.author.bot || message.system) return false;
  if (!message.inGuild() || message.channel.type === ChannelType.DM) return false;

  const prefix = settingsRepository.getPrefix(message.guildId);
  const rest = stripPrefix(message, prefix);
  if (rest === null) return false;

  const tokens = tokenize(rest);
  const word = tokens[0];
  // "?" alone, "??", "?!", emoticons etc. are chat, not commands.
  if (!word || !COMMAND_WORD.test(word)) return false;

  const command = registry.get(word);
  if (!command) {
    await message
      .reply({
        content: `Unknown command. Use \`${prefix}help\` to see what I can do.`,
        allowedMentions: { repliedUser: false, parse: [] },
      })
      .catch(() => undefined);
    return true;
  }

  let subcommand = null;
  let argTokens = tokens.slice(1);
  if (command.subcommands) {
    const found = registry.findSubcommand(command, argTokens[0]);
    if (found) {
      subcommand = found;
      argTokens = argTokens.slice(1);
    } else if (command.defaultSubcommand) {
      subcommand = registry.findSubcommand(command, command.defaultSubcommand);
    } else {
      const list = command.subcommands.map((sub) => `\`${sub.name}\``).join(', ');
      await message
        .reply({
          content: `Choose a subcommand: ${list}\nExample: \`${prefix}${command.name} ${command.subcommands[0].name}\``,
          allowedMentions: { repliedUser: false, parse: [] },
        })
        .catch(() => undefined);
      return true;
    }
  }

  const schema = subcommand ? subcommand.args : (command.args ?? []);
  const ctx = new CommandContext({
    kind: 'prefix',
    message,
    command,
    subcommand: subcommand?.name ?? null,
    values: {},
    prefix,
  });

  try {
    const { values } = await resolvePrefixArgs(schema, argTokens, {
      guild: message.guild,
      client: message.client,
    });
    ctx.values = values;
  } catch (error) {
    if (error instanceof ArgumentError) {
      await handleError(ctx, error);
      return true;
    }
    log.error(`Argument resolution failed for ${command.name}:`, error);
    await ctx.failure('I could not understand those arguments.');
    return true;
  }

  await dispatch(ctx);
  return true;
}

module.exports = { handleMessage, validatePrefix, DEFAULT_PREFIX };
