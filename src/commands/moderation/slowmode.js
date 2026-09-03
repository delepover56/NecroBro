'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const moderationService = require('../../services/moderationService');
const presenters = require('../../services/moderationPresenters');
const { formatDuration, parseDuration } = require('../../utils/duration');
const { createLogger } = require('../../utils/logger');

const log = createLogger('cmd:slowmode');

const { ACTIONS } = moderationService;

/** Discord's hard ceiling for rate_limit_per_user (6 hours). */
const MAX_SECONDS = 21_600;

/** Channel types that support a per-user rate limit. */
const SLOWABLE = [
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
];

/**
 * Parses the `seconds` argument: `off`, a plain integer 0-21600, or a
 * duration such as `10s` / `5m`. Returns the seconds or `null` when invalid.
 */
function parseSeconds(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (['off', 'none', 'disable', 'disabled', 'reset'].includes(text)) return 0;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  const ms = parseDuration(text);
  if (ms === null) return null;
  return Math.round(ms / 1000);
}

module.exports = {
  name: 'slowmode',
  aliases: ['slow'],
  category: 'moderation',
  description: 'Set or disable slowmode in a channel (0-21600 seconds, or "off").',
  permission: 'admin',
  cooldown: 2,
  botPermissions: [PermissionFlagsBits.ManageChannels],
  args: [
    { name: 'seconds', type: 'string', description: 'Seconds between messages (0-21600), a duration like 5m, or "off".', required: true, max: 20 },
    { name: 'channel', type: 'channel', description: 'The channel to change (default: this one).', required: false, channelTypes: SLOWABLE },
  ],
  examples: ['slowmode 10', 'slowmode 5m #general', 'slowmode off'],
  async execute(ctx) {
    const seconds = parseSeconds(ctx.get('seconds'));
    if (seconds === null || !Number.isInteger(seconds) || seconds < 0) {
      return ctx.failure('`seconds` must be `off`, a whole number of seconds (0-21600), or a duration like `5m`.');
    }
    if (seconds > MAX_SECONDS) {
      return ctx.failure(`Slowmode cannot exceed **${MAX_SECONDS}** seconds (6 hours).`);
    }

    const channel = presenters.resolveTargetChannel(ctx, {
      required: [PermissionFlagsBits.ManageChannels],
      allowedTypes: SLOWABLE,
    });
    if (typeof channel.setRateLimitPerUser !== 'function') {
      return ctx.failure(`${channel} does not support slowmode.`);
    }

    const previous = channel.rateLimitPerUser ?? 0;
    if (previous === seconds) {
      return ctx.failure(
        seconds === 0 ? `Slowmode is already off in ${channel}.` : `${channel} already has a ${formatDuration(seconds * 1000)} slowmode.`,
      );
    }

    await channel.setRateLimitPerUser(seconds, `Slowmode set by ${ctx.user.tag}`);

    const summary = seconds === 0 ? 'Slowmode disabled' : `Slowmode set to ${formatDuration(seconds * 1000)}`;
    const caseRow = await moderationService.createCase({
      guild: ctx.guild,
      action: ACTIONS.SLOWMODE.key,
      moderator: ctx.member,
      reason: summary,
      metadata: { seconds, channelId: channel.id, previous },
    });
    log.info(`[${ctx.guildId}] ${ctx.user.id} set slowmode in ${channel.id} to ${seconds}s (was ${previous}s, case #${caseRow.case_number})`);

    const embed = presenters.buildActionEmbed({
      action: ACTIONS.SLOWMODE.key,
      caseRow,
      moderator: ctx.member,
      reason: summary,
      fields: [
        { name: 'Channel', value: `${channel}`, inline: true },
        { name: 'Interval', value: seconds === 0 ? 'Off' : formatDuration(seconds * 1000), inline: true },
        { name: 'Previously', value: previous === 0 ? 'Off' : formatDuration(previous * 1000), inline: true },
      ],
      description: seconds === 0 ? `🐌 Slowmode is **off** in ${channel}.` : `🐌 Members can post once every **${formatDuration(seconds * 1000)}** in ${channel}.`,
    });
    return ctx.reply(presenters.replyPayload(embed));
  },
};
