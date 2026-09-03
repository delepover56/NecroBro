'use strict';

const { PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const { missingChannelPermissions } = require('../../utils/permissions');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:purge');

const { ACTIONS } = moderationService;

/** Discord refuses to bulk-delete messages older than 14 days; keep a safety margin. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 1000;
/** How long the prefix confirmation lingers before it removes itself. */
const CONFIRMATION_TTL_MS = 6_000;

module.exports = {
  name: 'purge',
  aliases: ['clear', 'prune'],
  category: 'moderation',
  description: 'Bulk-delete recent messages in this channel, optionally only from one user.',
  permission: 'admin',
  cooldown: 5,
  botPermissions: [PermissionFlagsBits.ManageMessages],
  args: [
    { name: 'amount', type: 'integer', description: 'How many messages to delete (1-100).', required: true, min: 1, max: 100 },
    { name: 'user', type: 'user', description: 'Only delete messages from this user.', required: false },
  ],
  examples: ['purge 20', 'purge 50 @user'],
  async execute(ctx) {
    const amount = ctx.get('amount');
    const user = ctx.get('user');
    const channel = ctx.channel;

    if (!channel?.isTextBased?.() || typeof channel.bulkDelete !== 'function') {
      return ctx.failure('Messages cannot be purged in this channel.');
    }
    const missing = missingChannelPermissions(channel, [
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ]);
    if (missing.length > 0) {
      return ctx.failure(`I am missing **${missing.join('**, **')}** in this channel.`);
    }

    await ctx.defer({ ephemeral: true });

    // Prefix: fetch strictly before the invoking message so it never counts
    // toward `amount`; it is removed separately afterwards.
    const fetchOptions = { limit: 100 };
    if (ctx.isPrefix && ctx.message) fetchOptions.before = ctx.message.id;
    const fetched = await channel.messages.fetch(fetchOptions);

    const cutoff = Date.now() - MAX_AGE_MS;
    let skippedOld = 0;
    const candidates = [];
    for (const message of fetched.values()) {
      if (candidates.length >= amount) break;
      if (user && message.author?.id !== user.id) continue;
      if (message.createdTimestamp < cutoff) {
        skippedOld += 1;
        continue;
      }
      candidates.push(message);
    }

    if (candidates.length === 0) {
      return ctx.failure(
        user
          ? `No recent messages from <@${user.id}> were found in the last 100 messages.`
          : 'No messages younger than 14 days were found to delete.',
      );
    }

    const deleted = await channel.bulkDelete(candidates, true);
    const count = deleted.size;

    if (ctx.isPrefix && ctx.message) {
      await ctx.message.delete().catch(() => undefined);
    }

    const caseRow = await moderationService.createCase({
      guild: ctx.guild,
      action: ACTIONS.PURGE.key,
      target: user ?? null,
      moderator: ctx.member,
      reason: user ? `Purged ${count} message(s) from ${user.tag ?? user.id}` : `Purged ${count} message(s)`,
      metadata: { count, channelId: channel.id },
    });

    log.info(`[${ctx.guildId}] ${ctx.user.id} purged ${count} message(s) in ${channel.id}${user ? ` from ${user.id}` : ''} (case #${caseRow.case_number})`);

    const notes = [];
    if (skippedOld > 0) notes.push(`⏭️ Skipped ${skippedOld} message${skippedOld === 1 ? '' : 's'} older than 14 days.`);
    if (count < amount) notes.push(`ℹ️ Only ${count} matching message${count === 1 ? '' : 's'} could be deleted.`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.PURGE.key,
      caseRow,
      target: user ?? null,
      moderator: ctx.member,
      reason: caseRow.reason,
      fields: [
        { name: 'Deleted', value: String(count), inline: true },
        { name: 'Channel', value: `${channel}`, inline: true },
      ],
      description: notes.length ? notes.join('\n') : null,
    });

    if (ctx.isSlash) {
      return ctx.reply(presenters.replyPayload(embed, { ephemeral: true }));
    }

    // Prefix: the invoking message is gone, so send a fresh confirmation that
    // cleans itself up. (The timer is cosmetic; nothing depends on it.)
    let confirmation = null;
    try {
      confirmation = await channel.send(presenters.replyPayload(embed));
    } catch (error) {
      log.warn(`Could not send purge confirmation in ${channel.id}:`, error);
      return undefined;
    }
    setTimeout(() => {
      confirmation.delete().catch(() => undefined);
    }, CONFIRMATION_TTL_MS).unref?.();
    return confirmation;
  },
};
