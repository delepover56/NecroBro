'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const { BRAND, COMPONENT_NAMESPACES } = require('../config');
const economyRepository = require('../database/economy');
const economyService = require('../services/economyService');
const rankService = require('../services/rankService');
const { formatNumber } = require('../utils/format');
const { createLogger } = require('../utils/logger');
const { deferComponentUpdate, failure } = require('../utils/respond');

const log = createLogger('leaderboard');

/**
 * Leaderboard pages (Wealth / Rank / Top) with button navigation.
 *
 * Custom IDs:
 *   lb:page:<type>:<page>   previous / next
 *   lb:type:<type>:<page>   switch board (always page 1)
 * Anyone may press the buttons; the message is edited in place.
 */

const NS = COMPONENT_NAMESPACES.leaderboard;
const PAGE_SIZE = 10;

const TYPES = {
  wealth: { key: 'wealth', label: 'Wealth', emoji: '💰', title: '💰 WEALTH BOARD' },
  rank: { key: 'rank', label: 'Rank', emoji: '🏆', title: '🏆 RANK BOARD' },
  top: { key: 'top', label: 'Top', emoji: '👑', title: '👑 TOP BOARD' },
};

function normalizeType(type) {
  const key = String(type ?? 'wealth').toLowerCase();
  return TYPES[key] ? key : null;
}

function totalPages(count) {
  return Math.max(1, Math.ceil(count / PAGE_SIZE));
}

function clampPage(page, pages) {
  const n = Number.parseInt(page, 10);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, pages);
}

/** Rows for one page plus the total count, for any board type. */
function fetchPage(guildId, type, page) {
  const offset = (page - 1) * PAGE_SIZE;
  if (type === 'top') {
    const ranked = rankService.rankTopBoard(economyRepository.listScoreInputs(guildId));
    return { rows: ranked.slice(offset, offset + PAGE_SIZE), count: ranked.length };
  }
  const count = economyRepository.countUsers(guildId);
  const rows =
    type === 'rank'
      ? economyRepository.topByRank(guildId, offset, PAGE_SIZE)
      : economyRepository.topByCash(guildId, offset, PAGE_SIZE);
  return { rows, count };
}

function renderLine(type, row, position) {
  const mention = `<@${row.user_id}>`;
  switch (type) {
    case 'rank':
      return `**${position}.** ${mention} — Rank ${row.level} (${formatNumber(row.xp)} XP)`;
    case 'top':
      return `**${position}.** ${mention} — Score ${formatNumber(row.score)}`;
    default:
      return `**${position}.** ${mention} — ${formatNumber(row.cash)}`;
  }
}

function buildButtons(type, page, pages) {
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${NS}:page:${type}:${page - 1}`)
      .setLabel('⬅ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`${NS}:page:${type}:${page + 1}`)
      .setLabel('➡ Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
  );

  const types = new ActionRowBuilder().addComponents(
    Object.values(TYPES).map((board) =>
      new ButtonBuilder()
        .setCustomId(`${NS}:type:${board.key}:1`)
        .setLabel(board.label)
        .setEmoji(board.emoji)
        .setStyle(board.key === type ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(board.key === type),
    ),
  );

  return [nav, types];
}

/**
 * Full message payload for one leaderboard page. `page` is clamped into
 * range, so callers can pass whatever the user typed.
 */
function buildLeaderboardPage(guild, type = 'wealth', page = 1) {
  const key = normalizeType(type) ?? 'wealth';
  const board = TYPES[key];
  const settings = economyService.getEconomySettings(guild.id);

  const pages = totalPages(economyRepository.countUsers(guild.id));
  const current = clampPage(page, pages);
  const { rows } = fetchPage(guild.id, key, current);

  const offset = (current - 1) * PAGE_SIZE;
  const description =
    rows.length > 0
      ? rows.map((row, index) => renderLine(key, row, offset + index + 1)).join('\n')
      : 'Nobody is on this board yet — start chatting to earn XP and coins!';

  const subtitle =
    key === 'wealth'
      ? `${settings.currencySymbol} ${settings.currencyName}`
      : key === 'rank'
        ? 'Highest rank, then most XP'
        : 'Combined wealth + activity score (max 100,000)';

  const embed = new EmbedBuilder()
    .setColor(BRAND.accentColor)
    .setTitle(board.title)
    .setDescription(`-# ${subtitle}\n${description}`)
    .setFooter({ text: `Page ${current} / ${pages}` });

  return { embeds: [embed], components: buildButtons(key, current, pages), allowedMentions: { parse: [] } };
}

/* ------------------------------------------------------------------ *
 * Button handlers
 * ------------------------------------------------------------------ */

async function handleNavigate(interaction, [rawType, rawPage]) {
  const type = normalizeType(rawType);
  if (!type) {
    log.warn(`Malformed leaderboard custom ID: ${interaction.customId}`);
    return failure(interaction, 'Unknown leaderboard type.');
  }
  const page = Number.parseInt(rawPage, 10);
  if (!Number.isInteger(page)) {
    log.warn(`Malformed leaderboard page in custom ID: ${interaction.customId}`);
    return failure(interaction, 'That page number is not valid.');
  }

  if (!(await deferComponentUpdate(interaction))) return undefined;
  await interaction.editReply(buildLeaderboardPage(interaction.guild, type, page));
  return undefined;
}

module.exports = {
  TYPES,
  PAGE_SIZE,
  buildLeaderboardPage,
  buttonPrefixes: {
    [`${NS}:page`]: handleNavigate,
    [`${NS}:type`]: handleNavigate,
  },
};
