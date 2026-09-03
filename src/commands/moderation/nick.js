'use strict';

const { PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const roleService = require('../../services/roleService');
const { sanitize } = require('../../utils/format');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:nick');

const { ACTIONS } = moderationService;
const NICK_MAX = 32;

/** Shared authorisation for both nickname commands; returns a failure message or `null`. */
function authorise(ctx, target) {
  const check = presenters.checkTarget(ctx, target);
  if (!check.ok) return check.reason;
  const botCheck = roleService.botCanManageMember(target);
  if (!botCheck.ok) return botCheck.reason;
  if (!target.manageable) return `I cannot change ${target}'s nickname.`;
  return null;
}

function showNick(value) {
  return value ? `\`${sanitize(value, NICK_MAX)}\`` : '_none_';
}

const nick = {
  name: 'nick',
  aliases: ['nickname', 'setnick'],
  category: 'moderation',
  description: 'Change a member\'s nickname.',
  permission: 'admin',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.ManageNicknames],
  args: [
    { name: 'user', type: 'member', description: 'The member to rename.', required: true },
    { name: 'nickname', type: 'text', description: `The new nickname (max ${NICK_MAX} characters).`, required: true, max: NICK_MAX },
  ],
  examples: ['nick @user Steve', 'nick @user "Nekro Builder"'],
  async execute(ctx) {
    const target = ctx.get('user');
    const nickname = String(ctx.get('nickname') ?? '').trim().slice(0, NICK_MAX);
    if (!nickname) return ctx.failure('Provide a nickname (1-32 characters).');

    const denied = authorise(ctx, target);
    if (denied) return ctx.failure(denied);

    const from = target.nickname ?? null;
    if (from === nickname) return ctx.failure(`${target} is already nicknamed ${showNick(nickname)}.`);

    await target.setNickname(nickname, `Changed by ${ctx.user.tag}`);

    const caseRow = await moderationService.createCase({
      guild: ctx.guild,
      action: ACTIONS.NICK.key,
      target,
      moderator: ctx.member,
      reason: `Nickname changed from ${from ?? 'none'} to ${nickname}`,
      metadata: { from, to: nickname },
    });
    log.info(`[${ctx.guildId}] ${ctx.user.id} renamed ${target.id} "${from ?? ''}" -> "${nickname}" (case #${caseRow.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.NICK.key,
      caseRow,
      target,
      moderator: ctx.member,
      reason: caseRow.reason,
      fields: [
        { name: 'Before', value: showNick(from), inline: true },
        { name: 'After', value: showNick(nickname), inline: true },
      ],
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

const resetnick = {
  name: 'resetnick',
  aliases: ['clearnick'],
  category: 'moderation',
  description: 'Remove a member\'s nickname, restoring their username.',
  permission: 'admin',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.ManageNicknames],
  args: [{ name: 'user', type: 'member', description: 'The member whose nickname to reset.', required: true }],
  examples: ['resetnick @user'],
  async execute(ctx) {
    const target = ctx.get('user');

    const denied = authorise(ctx, target);
    if (denied) return ctx.failure(denied);

    const from = target.nickname ?? null;
    if (!from) return ctx.failure(`${target} has no nickname to reset.`);

    await target.setNickname(null, `Reset by ${ctx.user.tag}`);

    const caseRow = await moderationService.createCase({
      guild: ctx.guild,
      action: ACTIONS.RESETNICK.key,
      target,
      moderator: ctx.member,
      reason: `Nickname ${from} removed`,
      metadata: { from, to: null },
    });
    log.info(`[${ctx.guildId}] ${ctx.user.id} reset the nickname of ${target.id} (was "${from}", case #${caseRow.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.RESETNICK.key,
      caseRow,
      target,
      moderator: ctx.member,
      reason: caseRow.reason,
      fields: [
        { name: 'Before', value: showNick(from), inline: true },
        { name: 'After', value: `\`${sanitize(target.user.username, NICK_MAX)}\``, inline: true },
      ],
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};

module.exports = [nick, resetnick];
