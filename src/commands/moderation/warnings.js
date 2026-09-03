'use strict';

const { EmbedBuilder } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const { discordTime, sanitize } = require('../../utils/format');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:warn');

const { ACTIONS } = moderationService;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LISTED = 15;

/** Fetches the guild member for a User, or `null` when they are not in the server. */
async function memberFor(ctx, user) {
  return ctx.guild.members.cache.get(user.id) ?? (await ctx.guild.members.fetch(user.id).catch(() => null));
}

const warn = {
  name: 'warn',
  category: 'moderation',
  description: 'Warn a member. The warning is recorded and the member is notified by DM.',
  permission: 'moderator',
  cooldown: 2,
  args: [
    { name: 'user', type: 'member', description: 'The member to warn.', required: true },
    { name: 'reason', type: 'text', description: 'Why they are being warned.', required: false, max: 500 },
  ],
  examples: ['warn @user spamming in general', 'warn @user'],
  async execute(ctx) {
    const target = ctx.get('user');
    const reason = presenters.reasonFrom(ctx);

    const check = presenters.checkTarget(ctx, target);
    if (!check.ok) return ctx.failure(check.reason);
    if (target.user.bot) return ctx.failure('Bots cannot be warned.');

    const result = await moderationService.warn({ guild: ctx.guild, target, moderator: ctx.member, reason });
    const dmDelivered = await presenters.notifyTarget(target, {
      guild: ctx.guild,
      action: ACTIONS.WARN.key,
      reason,
      caseNumber: result.case.case_number,
      extra: `**Active warnings:** ${result.count}`,
    });

    log.info(`[${ctx.guildId}] ${ctx.user.id} warned ${target.id} (case #${result.case.case_number}, now ${result.count} active)`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.WARN.key,
      caseRow: result.case,
      target,
      moderator: ctx.member,
      reason,
      dmDelivered,
      fields: [{ name: 'Active warnings', value: String(result.count), inline: true }],
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

const warnings = {
  name: 'warnings',
  aliases: ['warns'],
  category: 'moderation',
  description: 'List the active warnings of a user, plus their recent case count.',
  permission: 'moderator',
  cooldown: 2,
  args: [{ name: 'user', type: 'user', description: 'The user to look up (ID works for people who left).', required: true }],
  examples: ['warnings @user', 'warnings 123456789012345678'],
  async execute(ctx) {
    const user = ctx.get('user');
    const list = moderationService.listWarnings(ctx.guildId, user.id);
    const total = moderationService.countWarnings(ctx.guildId, user.id);

    const cases = moderationService.listCasesForUser(ctx.guildId, user.id, { limit: 100 });
    const since = Date.now() - THIRTY_DAYS_MS;
    const recent = cases.filter((row) => row.created_at >= since).length;
    const caseTotal = cases.length >= 100 ? '100+' : String(cases.length);

    const embed = new EmbedBuilder()
      .setColor(total > 0 ? ACTIONS.WARN.color : 0x57f287)
      .setTitle(`${ACTIONS.WARN.emoji} Warnings for ${user.tag ?? user.username}`)
      .setThumbnail(user.displayAvatarURL?.({ size: 128 }) ?? null)
      .setFooter({ text: `User ID: ${user.id}` })
      .setTimestamp(new Date());

    if (list.length === 0) {
      embed.setDescription(`<@${user.id}> has **no active warnings**.`);
    } else {
      const caseById = new Map(cases.map((row) => [row.id, row]));
      const lines = list.slice(0, MAX_LISTED).map((row) => {
        const caseRow = row.case_id ? caseById.get(row.case_id) ?? null : null;
        const caseTag = caseRow ? ` · Case #${caseRow.case_number}` : '';
        const source = row.source === 'AUTOMOD' ? ' · 🤖 automod' : '';
        return (
          `**#${row.id}** by <@${row.moderator_id}> · ${discordTime(row.created_at, 'R')}${caseTag}${source}\n` +
          `‣ ${sanitize(row.reason || presenters.DEFAULT_REASON, 200)}`
        );
      });
      const overflow = list.length > MAX_LISTED ? `\n\n…and ${list.length - MAX_LISTED} more.` : '';
      embed.setDescription(`<@${user.id}> has **${total}** active warning${total === 1 ? '' : 's'}.\n\n${lines.join('\n')}${overflow}`.slice(0, 4096));
    }

    embed.addFields(
      { name: 'Active warnings', value: String(total), inline: true },
      { name: 'Cases (last 30 days)', value: String(recent), inline: true },
      { name: 'Cases (total)', value: caseTotal, inline: true },
    );

    return ctx.reply(presenters.replyPayload(embed));
  },
};

const clearwarnings = {
  name: 'clearwarnings',
  aliases: ['clearwarns', 'unwarnall'],
  category: 'moderation',
  description: 'Clear every active warning of a user.',
  permission: 'admin',
  cooldown: 2,
  args: [
    { name: 'user', type: 'user', description: 'The user whose warnings to clear (ID works).', required: true },
    { name: 'reason', type: 'text', description: 'Why the warnings are cleared.', required: false, max: 500 },
  ],
  examples: ['clearwarnings @user appeal accepted', 'clearwarnings 123456789012345678'],
  async execute(ctx) {
    const user = ctx.get('user');
    const reason = presenters.reasonFrom(ctx);

    const member = await memberFor(ctx, user);
    if (member) {
      const check = presenters.checkTarget(ctx, member);
      if (!check.ok) return ctx.failure(check.reason);
    } else if (user.id === ctx.user.id) {
      return ctx.failure('You cannot moderate yourself.');
    }

    const active = moderationService.countWarnings(ctx.guildId, user.id);
    if (active === 0) return ctx.failure(`<@${user.id}> has no active warnings to clear.`);

    const result = await moderationService.clearWarnings({ guild: ctx.guild, target: user, moderator: ctx.member, reason });
    log.info(`[${ctx.guildId}] ${ctx.user.id} cleared ${result.cleared} warning(s) of ${user.id} (case #${result.case.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.CLEARWARNINGS.key,
      caseRow: result.case,
      target: member ?? user,
      moderator: ctx.member,
      reason,
      fields: [{ name: 'Cleared', value: `${result.cleared} warning${result.cleared === 1 ? '' : 's'}`, inline: true }],
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

module.exports = [warn, warnings, clearwarnings];
