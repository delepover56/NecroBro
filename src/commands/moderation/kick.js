'use strict';

const { PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const roleService = require('../../services/roleService');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:kick');

const { ACTIONS } = moderationService;

module.exports = {
  name: 'kick',
  category: 'moderation',
  description: 'Kick a member from the server.',
  permission: 'admin',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.KickMembers],
  args: [
    { name: 'user', type: 'member', description: 'The member to kick.', required: true },
    { name: 'reason', type: 'text', description: 'Why they are being kicked.', required: false, max: 500 },
  ],
  examples: ['kick @user advertising', 'kick @user'],
  async execute(ctx) {
    const target = ctx.get('user');
    const reason = presenters.reasonFrom(ctx);

    const check = presenters.checkTarget(ctx, target);
    if (!check.ok) return ctx.failure(check.reason);
    const botCheck = roleService.botCanManageMember(target);
    if (!botCheck.ok) return ctx.failure(botCheck.reason);
    if (!target.kickable) return ctx.failure(`I cannot kick ${target}.`);

    // The DM has to go out before the kick: afterwards we share no server with them.
    const dmDelivered = await presenters.notifyTarget(target, {
      guild: ctx.guild,
      action: ACTIONS.KICK.key,
      reason,
    });

    const result = await moderationService.kick({ guild: ctx.guild, target, moderator: ctx.member, reason });
    log.info(`[${ctx.guildId}] ${ctx.user.id} kicked ${target.id} (case #${result.case.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.KICK.key,
      caseRow: result.case,
      target,
      moderator: ctx.member,
      reason,
      dmDelivered,
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};
