'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:lock');

const { ACTIONS } = moderationService;

const LOCKABLE = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
];

/** Editing permission overwrites needs Manage Roles in that channel. */
const CHANNEL_PERMS = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];

function everyoneDeniesSend(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
  return Boolean(overwrite?.deny.has(PermissionFlagsBits.SendMessages));
}

function channelArg(description) {
  return { name: 'channel', type: 'channel', description, required: false, channelTypes: LOCKABLE };
}

/** Announces the change inside the affected channel when it differs from where the command ran. */
async function announceInChannel(ctx, channel, embed) {
  if (channel.id === ctx.channelId) return;
  if (typeof channel.send !== 'function') return;
  await channel.send(presenters.replyPayload(embed)).catch((error) =>
    log.debug(`Could not announce lock state in ${channel.id}: ${error?.message ?? error}`),
  );
}

const lock = {
  name: 'lock',
  category: 'moderation',
  description: 'Lock a channel so @everyone can no longer send messages.',
  permission: 'moderator',
  cooldown: 2,
  botPermissions: CHANNEL_PERMS,
  args: [
    channelArg('The channel to lock (default: this one).'),
    { name: 'reason', type: 'text', description: 'Why the channel is locked.', required: false, max: 500 },
  ],
  examples: ['lock', 'lock #general raid in progress', 'lock cooling down'],
  async execute(ctx) {
    const channel = presenters.resolveTargetChannel(ctx, { required: CHANNEL_PERMS, allowedTypes: LOCKABLE });
    const reason = presenters.reasonFrom(ctx);

    if (everyoneDeniesSend(channel)) return ctx.failure(`${channel} is already locked.`);

    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone,
      { SendMessages: false, SendMessagesInThreads: false },
      { reason: `Locked by ${ctx.user.tag}: ${reason ?? presenters.DEFAULT_REASON}` },
    );

    const caseRow = await moderationService.createCase({
      guild: ctx.guild,
      action: ACTIONS.LOCK.key,
      moderator: ctx.member,
      reason,
      metadata: { channelId: channel.id },
    });
    log.info(`[${ctx.guildId}] ${ctx.user.id} locked ${channel.id} (case #${caseRow.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.LOCK.key,
      caseRow,
      moderator: ctx.member,
      reason,
      fields: [{ name: 'Channel', value: `${channel}`, inline: true }],
      description: `🔒 ${channel} is now locked. Members can no longer send messages here.`,
    });
    await announceInChannel(ctx, channel, embed);
    return ctx.reply(presenters.replyPayload(embed));
  },
};

const unlock = {
  name: 'unlock',
  category: 'moderation',
  description: 'Unlock a channel, restoring @everyone\'s ability to send messages.',
  permission: 'moderator',
  cooldown: 2,
  botPermissions: CHANNEL_PERMS,
  args: [
    channelArg('The channel to unlock (default: this one).'),
    { name: 'reason', type: 'text', description: 'Why the channel is unlocked.', required: false, max: 500 },
  ],
  examples: ['unlock', 'unlock #general all clear'],
  async execute(ctx) {
    const channel = presenters.resolveTargetChannel(ctx, { required: CHANNEL_PERMS, allowedTypes: LOCKABLE });
    const reason = presenters.reasonFrom(ctx);

    if (!everyoneDeniesSend(channel)) return ctx.failure(`${channel} is not locked.`);

    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone,
      { SendMessages: null, SendMessagesInThreads: null },
      { reason: `Unlocked by ${ctx.user.tag}: ${reason ?? presenters.DEFAULT_REASON}` },
    );

    const caseRow = await moderationService.createCase({
      guild: ctx.guild,
      action: ACTIONS.UNLOCK.key,
      moderator: ctx.member,
      reason,
      metadata: { channelId: channel.id },
    });
    log.info(`[${ctx.guildId}] ${ctx.user.id} unlocked ${channel.id} (case #${caseRow.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.UNLOCK.key,
      caseRow,
      moderator: ctx.member,
      reason,
      fields: [{ name: 'Channel', value: `${channel}`, inline: true }],
      description: `🔓 ${channel} is unlocked. Members can send messages again.`,
    });
    await announceInChannel(ctx, channel, embed);
    return ctx.reply(presenters.replyPayload(embed));
  },
};

module.exports = [lock, unlock];
