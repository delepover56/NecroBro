'use strict';

const { PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const { formatDuration } = require('../../utils/duration');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:mute');

const { ACTIONS } = moderationService;

const mute = {
  name: 'mute',
  category: 'moderation',
  description: 'Mute a member with the configured Mute role. Persists across restarts and rejoins.',
  permission: 'moderator',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.ManageRoles],
  args: [
    { name: 'user', type: 'member', description: 'The member to mute.', required: true },
    { name: 'duration', type: 'duration', description: 'How long, e.g. 10m, 2h, 1d12h.', required: true },
    { name: 'reason', type: 'text', description: 'Why they are being muted.', required: false, max: 500 },
  ],
  examples: ['mute @user 1h spamming', 'mute @user 3d'],
  async execute(ctx) {
    const target = ctx.get('user');
    const durationMs = ctx.get('duration');
    const reason = presenters.reasonFrom(ctx);

    const check = presenters.checkTarget(ctx, target);
    if (!check.ok) return ctx.failure(check.reason);

    // Fails early with a clear message when the Mute role is unset / deleted / too high.
    moderationService.requireMuteRole(ctx.guild);

    const previous = moderationService.getActiveMute(ctx.guildId, target.id);

    const result = await moderationService.mute({
      guild: ctx.guild,
      target,
      moderator: ctx.member,
      durationMs,
      reason,
    });

    const dmDelivered = await presenters.notifyTarget(target, {
      guild: ctx.guild,
      action: ACTIONS.MUTE.key,
      reason,
      durationMs,
      until: result.until,
      caseNumber: result.case.case_number,
    });

    log.info(
      `[${ctx.guildId}] ${ctx.user.id} muted ${target.id} for ${formatDuration(durationMs)} (case #${result.case.case_number})` +
        (previous ? ' replacing an existing mute' : ''),
    );

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.MUTE.key,
      caseRow: result.case,
      target,
      moderator: ctx.member,
      reason,
      durationMs,
      until: result.until,
      dmDelivered,
      fields: [{ name: 'Role', value: `${result.role}`, inline: true }],
      description: previous ? '♻️ This replaces the member\'s previous mute.' : null,
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

const unmute = {
  name: 'unmute',
  category: 'moderation',
  description: 'Remove the Mute role from a member and close their mute record.',
  permission: 'moderator',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.ManageRoles],
  args: [
    { name: 'user', type: 'member', description: 'The member to unmute.', required: true },
    { name: 'reason', type: 'text', description: 'Why the mute is lifted.', required: false, max: 500 },
  ],
  examples: ['unmute @user apologised', 'unmute @user'],
  async execute(ctx) {
    const target = ctx.get('user');
    const reason = presenters.reasonFrom(ctx);

    const check = presenters.checkTarget(ctx, target);
    if (!check.ok) return ctx.failure(check.reason);

    const result = await moderationService.unmute({ guild: ctx.guild, target, moderator: ctx.member, reason });
    log.info(`[${ctx.guildId}] ${ctx.user.id} unmuted ${target.id} (case #${result.case.case_number})`);

    const notes = [];
    if (!result.roleRemoved) notes.push('ℹ️ The member did not hold the Mute role; only the record was closed.');
    if (!result.released) notes.push('ℹ️ No active mute record existed; the role was removed anyway.');

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.UNMUTE.key,
      caseRow: result.case,
      target,
      moderator: ctx.member,
      reason,
      description: notes.length ? notes.join('\n') : null,
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

module.exports = [mute, unmute];
