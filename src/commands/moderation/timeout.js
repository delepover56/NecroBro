'use strict';

const { PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const { formatDuration } = require('../../utils/duration');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:timeout');

const { ACTIONS } = moderationService;

const timeout = {
  name: 'timeout',
  aliases: ['to'],
  category: 'moderation',
  description: 'Time a member out with Discord\'s native timeout (up to 28 days).',
  permission: 'moderator',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.ModerateMembers],
  args: [
    { name: 'user', type: 'member', description: 'The member to time out.', required: true },
    { name: 'duration', type: 'duration', description: 'How long, e.g. 10m, 6h, 7d (max 28d).', required: true },
    { name: 'reason', type: 'text', description: 'Why they are being timed out.', required: false, max: 500 },
  ],
  examples: ['timeout @user 10m calm down', 'timeout @user 1d'],
  async execute(ctx) {
    const target = ctx.get('user');
    const durationMs = ctx.get('duration');
    const reason = presenters.reasonFrom(ctx);

    const check = presenters.checkTarget(ctx, target);
    if (!check.ok) return ctx.failure(check.reason);
    if (durationMs > moderationService.MAX_TIMEOUT_MS) {
      return ctx.failure('Discord timeouts cannot exceed **28 days**.');
    }

    const result = await moderationService.timeout({
      guild: ctx.guild,
      target,
      moderator: ctx.member,
      durationMs,
      reason,
    });

    const dmDelivered = await presenters.notifyTarget(target, {
      guild: ctx.guild,
      action: ACTIONS.TIMEOUT.key,
      reason,
      durationMs,
      until: result.until,
      caseNumber: result.case.case_number,
    });

    log.info(`[${ctx.guildId}] ${ctx.user.id} timed out ${target.id} for ${formatDuration(durationMs)} (case #${result.case.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.TIMEOUT.key,
      caseRow: result.case,
      target,
      moderator: ctx.member,
      reason,
      durationMs,
      until: result.until,
      dmDelivered,
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

const untimeout = {
  name: 'untimeout',
  aliases: ['removetimeout'],
  category: 'moderation',
  description: 'Remove a member\'s timeout early.',
  permission: 'moderator',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.ModerateMembers],
  args: [
    { name: 'user', type: 'member', description: 'The member whose timeout to remove.', required: true },
    { name: 'reason', type: 'text', description: 'Why the timeout is lifted.', required: false, max: 500 },
  ],
  examples: ['untimeout @user', 'untimeout @user resolved in DMs'],
  async execute(ctx) {
    const target = ctx.get('user');
    const reason = presenters.reasonFrom(ctx);

    const check = presenters.checkTarget(ctx, target);
    if (!check.ok) return ctx.failure(check.reason);

    const result = await moderationService.untimeout({ guild: ctx.guild, target, moderator: ctx.member, reason });
    log.info(`[${ctx.guildId}] ${ctx.user.id} removed the timeout of ${target.id} (case #${result.case.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.UNTIMEOUT.key,
      caseRow: result.case,
      target,
      moderator: ctx.member,
      reason,
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

module.exports = [timeout, untimeout];
