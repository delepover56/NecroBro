'use strict';

const { MessageFlags } = require('discord.js');

const { buildNoticeEmbed } = require('../utils/embeds');
const { createLogger } = require('../utils/logger');

const log = createLogger('context');

/**
 * One execution context for both front-ends.
 *
 * A command's `execute(ctx)` never touches the interaction or the message
 * directly: it reads arguments with `ctx.get()` and answers with `ctx.reply()`
 * and friends. The context translates those into the right Discord calls --
 * `interaction.reply`/`editReply` with the ephemeral flag for slash commands,
 * `message.reply` for prefix commands -- so the command logic exists once.
 */
class CommandContext {
  constructor({ kind, interaction = null, message = null, command, subcommand = null, values = {}, prefix = '?' }) {
    this.kind = kind;
    this.interaction = interaction;
    this.message = message;
    this.command = command;
    this.subcommand = subcommand;
    this.values = values;
    this.prefix = prefix;

    const source = interaction ?? message;
    this.client = source.client;
    this.guild = source.guild ?? null;
    this.guildId = source.guildId ?? null;
    this.channel = source.channel ?? null;
    this.channelId = source.channelId ?? null;
    this.member = source.member ?? null;
    this.user = interaction ? interaction.user : message.author;

    this._replyMessage = null;
    this._deferred = false;
  }

  get isSlash() {
    return this.kind === 'slash';
  }

  get isPrefix() {
    return this.kind === 'prefix';
  }

  /** Reads a resolved argument. */
  get(name) {
    return this.values[name] ?? null;
  }

  /** How this command is written for the current front-end, for usage hints. */
  get invocation() {
    const sub = this.subcommand ? ` ${this.subcommand}` : '';
    return this.isSlash ? `/${this.command.name}${sub}` : `${this.prefix}${this.command.name}${sub}`;
  }

  /* ---------------------------------------------------------------- *
   * Replies
   * ---------------------------------------------------------------- */

  /**
   * Acknowledge early for work that may take more than ~2 seconds.
   * Slash: deferReply. Prefix: typing indicator (best effort).
   */
  async defer({ ephemeral = false } = {}) {
    if (this.isSlash) {
      if (this.interaction.deferred || this.interaction.replied) return;
      await this.interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      this._deferred = true;
      return;
    }
    await this.channel?.sendTyping?.().catch(() => undefined);
  }

  /**
   * Sends the command's answer. `ephemeral` only has meaning for slash commands.
   * Returns the sent/edited Message when one is available.
   */
  async reply(payload) {
    const { ephemeral = false, ...rest } = normalize(payload);

    if (this.isSlash) {
      const body = ephemeral ? { ...rest, flags: MessageFlags.Ephemeral } : rest;
      if (this.interaction.deferred) {
        this._replyMessage = await this.interaction.editReply(rest);
      } else if (this.interaction.replied) {
        this._replyMessage = await this.interaction.followUp(body);
      } else {
        await this.interaction.reply(body);
        this._replyMessage = await this.interaction.fetchReply().catch(() => null);
      }
      return this._replyMessage;
    }

    const body = {
      ...rest,
      allowedMentions: rest.allowedMentions ?? { repliedUser: false, parse: [] },
    };
    if (this._replyMessage) {
      this._replyMessage = await this.channel.send(body);
    } else {
      this._replyMessage = await this.message.reply(body);
    }
    return this._replyMessage;
  }

  /** Edits the message sent by `reply()`. */
  async edit(payload) {
    const { ephemeral, ...rest } = normalize(payload);
    if (this.isSlash) {
      this._replyMessage = await this.interaction.editReply(rest);
      return this._replyMessage;
    }
    if (!this._replyMessage) return this.reply(rest);
    this._replyMessage = await this._replyMessage.edit(rest);
    return this._replyMessage;
  }

  /** The Message produced by `reply()`, if any. */
  get replyMessage() {
    return this._replyMessage;
  }

  success(message, extra = {}) {
    return this.notice('success', message, extra);
  }

  info(message, extra = {}) {
    return this.notice('info', message, extra);
  }

  /** Errors are ephemeral on slash commands and plain replies on prefix commands. */
  failure(message, extra = {}) {
    return this.notice('error', message, { ephemeral: true, ...extra });
  }

  async notice(kind, message, extra = {}) {
    try {
      return await this.reply({ embeds: [buildNoticeEmbed(kind, message)], ...extra });
    } catch (error) {
      log.warn(`Could not send ${kind} notice for ${this.command?.name}:`, error);
      return null;
    }
  }
}

function normalize(payload) {
  if (typeof payload === 'string') return { content: payload };
  return { ...payload };
}

module.exports = { CommandContext };
