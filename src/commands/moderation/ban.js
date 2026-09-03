'use strict';

const { PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const roleService = require('../../services/roleService');
const { formatDuration } = require('../../utils/duration');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:ban');

const { ACTIONS } = moderationService;

/** Fetches the guild member for a User, or `null` when they are not in the server. */
async function memberFor(ctx, user) {
  return ctx.guild.members.cache.get(user.id) ?? (await ctx.guild.members.fetch(user.id).catch(() => null));
}

async function isBanned(guild, userId) {
  try {
    await guild.bans.fetch(userId);
    return true;
  } catch {
    return false;
  }
}

const ban = {
  name: 'ban',
  category: 'moderation',
  description: 'Ban a user (by mention or ID), permanently or for a duration.',
  permission: 'admin',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.BanMembers],
  args: [
    { name: 'user', type: 'user', description: 'The user to ban. An ID works for people not in the server.', required: true },
    // Optional duration BEFORE the greedy reason: the prefix parser tries the
    // token as a duration and, when it is not one, hands it to `reason`.
    { name: 'duration', type: 'duration', description: 'Temporary ban length, e.g. 7d. Omit for permanent.', required: false },
    { name: 'reason', type: 'text', description: 'Why they are being banned.', required: false, max: 500 },
  ],
  examples: ['ban @user raiding', 'ban @user 7d spamming links', 'ban 123456789012345678 alt account'],
  async execute(ctx) {
    const user = ctx.get('user');
    const durationMs = ctx.get('duration');
    const reason = presenters.reasonFrom(ctx);

    if (user.id === ctx.user.id) return ctx.failure('You cannot moderate yourself.');
    if (user.id === ctx.client.user.id) return ctx.failure('I will not moderate myself.');
    if (user.id === ctx.guild.ownerId) return ctx.failure('The server owner cannot be moderated.');

    const member = await memberFor(ctx, user);
    if (member) {
      const check = presenters.checkTarget(ctx, member);
      if (!check.ok) return ctx.failure(check.reason);
      const botCheck = roleService.botCanManageMember(member);
      if (!botCheck.ok) return ctx.failure(botCheck.reason);
      if (!member.bannable) return ctx.failure(`I cannot ban ${member}.`);
    }

    await ctx.defer();

    if (await isBanned(ctx.guild, user.id)) {
      return ctx.failure(`<@${user.id}> is already banned.`);
    }

    const until = durationMs ? Date.now() + durationMs : null;

    // DM first: once banned they share no server with the bot.
    const dmDelivered = member
      ? await presenters.notifyTarget(member, {
          guild: ctx.guild,
          action: durationMs ? ACTIONS.TEMPBAN.key : ACTIONS.BAN.key,
          reason,
          durationMs,
          until,
        })
      : false;

    const result = await moderationService.ban({
      guild: ctx.guild,
      target: user,
      moderator: ctx.member,
      durationMs,
      reason,
    });

    log.info(
      `[${ctx.guildId}] ${ctx.user.id} banned ${user.id}` +
        (durationMs ? ` for ${formatDuration(durationMs)}` : ' permanently') +
        ` (case #${result.case.case_number})`,
    );

    const embed = presenters.buildActionEmbed({
      action: result.case.action,
      caseRow: result.case,
      target: member ?? user,
      moderator: ctx.member,
      reason,
      durationMs,
      until: result.until,
      dmDelivered: member ? dmDelivered : null,
      description: member ? null : 'ℹ️ The user was not in the server; no DM was sent.',
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

const unban = {
  name: 'unban',
  category: 'moderation',
  description: 'Lift a ban by user mention or ID.',
  permission: 'admin',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.BanMembers],
  args: [
    { name: 'user', type: 'user', description: 'The banned user (ID recommended).', required: true },
    { name: 'reason', type: 'text', description: 'Why the ban is lifted.', required: false, max: 500 },
  ],
  examples: ['unban 123456789012345678 appeal accepted', 'unban @user'],
  async execute(ctx) {
    const user = ctx.get('user');
    const reason = presenters.reasonFrom(ctx);

    if (user.id === ctx.user.id) return ctx.failure('You are not banned — you are right here.');

    await ctx.defer();

    const result = await moderationService.unban({ guild: ctx.guild, userId: user.id, moderator: ctx.member, reason });
    log.info(`[${ctx.guildId}] ${ctx.user.id} unbanned ${user.id} (case #${result.case.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.UNBAN.key,
      caseRow: result.case,
      target: user,
      moderator: ctx.member,
      reason,
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

module.exports = [ban, unban];
