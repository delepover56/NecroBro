'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const giveawayService = require('../../services/giveawayService');
const { discordTime, sanitize } = require('../../utils/format');

const { GiveawayError, LIMITS, TYPES } = giveawayService;

const TYPE_CHOICES = Object.values(TYPES).map((type) => ({ name: type.label, value: type.key }));

/** `Discord Nitro #giveaways` -> `{ prize: 'Discord Nitro', channelId: '...' }` */
const TRAILING_CHANNEL = /\s*<#(\d{15,21})>\s*$/;

function splitPrize(text) {
  const raw = String(text ?? '').trim();
  const match = raw.match(TRAILING_CHANNEL);
  if (!match) return { prize: raw, channelId: null };
  return { prize: raw.slice(0, match.index).trim(), channelId: match[1] };
}

function mentions(ids) {
  return ids.map((id) => `<@${id}>`).join(', ');
}

/**
 * `giveaway` / `gw` -- Admin-only giveaway management. One definition serves
 * both `/giveaway create …` and `?gw create Discord 24h 1 Discord Nitro`.
 *
 * The prize is greedy text so it needs no quotes in the prefix form. To post
 * somewhere other than the current channel, finish the prize with a channel
 * mention (`… Discord Nitro #giveaways`) -- that works identically for slash
 * and prefix invocations.
 */
module.exports = {
  name: 'giveaway',
  aliases: ['gw'],
  category: 'giveaways',
  description: 'Run button-based giveaways: create, end, cancel, reroll and list them.',
  permission: 'admin',
  cooldown: 2,
  defaultSubcommand: 'list',
  subcommands: [
    {
      name: 'create',
      description: 'Start a giveaway here. End the prize with #channel to post it elsewhere.',
      aliases: ['start', 'new'],
      args: [
        {
          name: 'type',
          type: 'string',
          description: 'Discord giveaway or Survival (Minecraft) giveaway.',
          required: true,
          choices: TYPE_CHOICES,
        },
        {
          name: 'duration',
          type: 'duration',
          description: 'How long it runs: 1 minute to 30 days (e.g. 30m, 12h, 3d).',
          required: true,
        },
        {
          name: 'winners',
          type: 'integer',
          description: 'How many winners to draw (1-20).',
          required: true,
          min: LIMITS.minWinners,
          max: LIMITS.maxWinners,
        },
        {
          name: 'prize',
          type: 'text',
          description: 'What is being given away. Add #channel at the end to post there.',
          required: true,
          max: LIMITS.prizeMax + 32,
        },
      ],
    },
    {
      name: 'end',
      description: 'End an active giveaway now and draw the winners.',
      aliases: ['stop', 'finish'],
      args: [{ name: 'id', type: 'integer', description: 'Giveaway ID (see giveaway list).', required: true, min: 1 }],
    },
    {
      name: 'cancel',
      description: 'Cancel an active giveaway without drawing winners.',
      aliases: ['delete', 'abort'],
      args: [{ name: 'id', type: 'integer', description: 'Giveaway ID (see giveaway list).', required: true, min: 1 }],
    },
    {
      name: 'reroll',
      description: 'Draw new winner(s) for an ended giveaway, avoiding previous winners.',
      aliases: ['redraw'],
      args: [
        { name: 'id', type: 'integer', description: 'Giveaway ID of an ended giveaway.', required: true, min: 1 },
        {
          name: 'winners',
          type: 'integer',
          description: 'How many new winners to draw (default 1).',
          required: false,
          min: LIMITS.minWinners,
          max: LIMITS.maxWinners,
        },
      ],
    },
    {
      name: 'list',
      description: 'Show the active giveaways in this server.',
      aliases: ['active', 'ls'],
      args: [],
    },
  ],
  examples: [
    'giveaway create Discord 24h 1 Discord Nitro',
    'gw create Survival 3d 2 Diamond Kit #giveaways',
    'giveaway end 12',
    'giveaway reroll 12 2',
    'giveaway list',
  ],

  async execute(ctx) {
    switch (ctx.subcommand) {
      case 'create':
        return create(ctx);
      case 'end':
        return end(ctx);
      case 'cancel':
        return cancel(ctx);
      case 'reroll':
        return reroll(ctx);
      default:
        return list(ctx);
    }
  },
};

/* ------------------------------------------------------------------ *
 * Subcommands
 * ------------------------------------------------------------------ */

async function create(ctx) {
  const type = String(ctx.get('type') ?? '').toUpperCase();
  const durationMs = ctx.get('duration');
  const winnerCount = ctx.get('winners');
  const { prize, channelId } = splitPrize(ctx.get('prize'));

  if (!prize) throw new GiveawayError('Please tell me what the prize is.');
  if (prize.length > LIMITS.prizeMax) {
    throw new GiveawayError(`The prize must be ${LIMITS.prizeMax} characters or fewer.`);
  }

  let channel = ctx.channel;
  if (channelId) {
    channel = ctx.guild.channels.cache.get(channelId) ?? (await ctx.guild.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased?.() || channel.isThread?.()) {
      throw new GiveawayError('That channel does not exist or is not a text channel I can post in.');
    }
  }

  await ctx.defer({ ephemeral: true });

  const { giveaway, message } = await giveawayService.createGiveaway({
    guild: ctx.guild,
    channel,
    creator: ctx.user,
    type,
    prize,
    winnerCount,
    durationMs,
  });

  const info = giveawayService.typeInfo(giveaway.type);
  return ctx.success(
    `${info.emoji} **${info.label}** giveaway **#${giveaway.id}** for **${sanitize(giveaway.prize, 100)}** is live in ${channel}!\n` +
      `Ends ${discordTime(giveaway.ends_at, 'R')} · ${giveaway.winner_count} winner${giveaway.winner_count === 1 ? '' : 's'} · ` +
      `[Jump to it](${message.url})\n-# End early with \`${ctx.prefix}giveaway end ${giveaway.id}\`.`,
    { ephemeral: true, allowedMentions: { parse: [] } },
  );
}

async function end(ctx) {
  const id = ctx.get('id');
  await ctx.defer({ ephemeral: true });

  const result = await giveawayService.endGiveaway({
    client: ctx.client,
    giveawayId: id,
    guildId: ctx.guildId,
    by: ctx.user.id,
  });

  if (result.outcome === 'cancelled') {
    return ctx.failure(
      `The ${result.reason} for giveaway **#${id}** no longer exists, so it was **cancelled** instead of ended.`,
    );
  }

  const { row, winners, participantCount, announced } = result;
  const summary =
    winners.length > 0
      ? `Winner${winners.length === 1 ? '' : 's'}: ${mentions(winners)}` +
        (winners.length < row.winner_count ? ` (only ${winners.length}/${row.winner_count} could be drawn)` : '')
      : 'No winners — not enough participants.';

  return ctx.success(
    `Giveaway **#${row.id}** (**${sanitize(row.prize, 100)}**) ended with **${participantCount}** participant${participantCount === 1 ? '' : 's'}.\n${summary}` +
      (announced ? '' : '\n-# I could not post the announcement in the giveaway channel.'),
    { ephemeral: true, allowedMentions: { parse: [] } },
  );
}

async function cancel(ctx) {
  const id = ctx.get('id');
  await ctx.defer({ ephemeral: true });

  const { row, messageUpdated } = await giveawayService.cancelGiveaway({
    client: ctx.client,
    giveawayId: id,
    guildId: ctx.guildId,
    by: ctx.user.id,
    note: `cancelled by ${ctx.user.tag ?? ctx.user.id}`,
  });

  return ctx.success(
    `Giveaway **#${row.id}** (**${sanitize(row.prize, 100)}**) has been cancelled. No winners were drawn.` +
      (messageUpdated ? '' : '\n-# The original giveaway message could not be updated.'),
    { ephemeral: true, allowedMentions: { parse: [] } },
  );
}

async function reroll(ctx) {
  const id = ctx.get('id');
  const count = ctx.get('winners') ?? 1;
  await ctx.defer({ ephemeral: true });

  const { row, winners, participantCount, announced } = await giveawayService.rerollGiveaway({
    client: ctx.client,
    giveawayId: id,
    guildId: ctx.guildId,
    by: ctx.user.id,
    count,
  });

  return ctx.success(
    `Rerolled giveaway **#${row.id}** (**${sanitize(row.prize, 100)}**) — reroll #${row.reroll_count} from ` +
      `${participantCount} participant${participantCount === 1 ? '' : 's'}.\nNew winner${winners.length === 1 ? '' : 's'}: ${mentions(winners)}` +
      (winners.length < count ? `\n-# Only ${winners.length} could be drawn.` : '') +
      (announced ? '' : '\n-# I could not post the announcement in the giveaway channel.'),
    { ephemeral: true, allowedMentions: { parse: [] } },
  );
}

async function list(ctx) {
  const rows = giveawayService.listActive(ctx.guildId);
  if (rows.length === 0) {
    return ctx.info(
      `There are no active giveaways right now. Start one with \`${ctx.prefix}giveaway create Discord 24h 1 Discord Nitro\`.`,
    );
  }

  const lines = rows.slice(0, 20).map((row) => {
    const type = giveawayService.typeInfo(row.type);
    return (
      `**#${row.id}** ${type.emoji} ${sanitize(row.prize, 80)}\n` +
      `-# <#${row.channel_id}> · ends ${discordTime(row.ends_at, 'R')} · 👥 ${row.entry_count} · 🏆 ${row.winner_count} · host <@${row.creator_id}>`
    );
  });
  if (rows.length > 20) lines.push(`-# …and ${rows.length - 20} more.`);

  const embed = new EmbedBuilder()
    .setColor(BRAND.accentColor)
    .setTitle(`🎉 Active Giveaways (${rows.length})`)
    .setDescription(lines.join('\n').slice(0, 4096))
    .setFooter({ text: `${ctx.prefix}giveaway end <id> · ${ctx.prefix}giveaway cancel <id> · ${ctx.prefix}giveaway reroll <id>` });

  return ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
