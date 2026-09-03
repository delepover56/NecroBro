'use strict';

const crypto = require('node:crypto');

const { ECONOMY_DEFAULTS } = require('../config');
const { transaction } = require('../database/database');
const economyRepository = require('../database/economy');
const settingsRepository = require('../database/settings');
const { discordTime, formatNumber } = require('../utils/format');
const { createLogger } = require('../utils/logger');
const rankService = require('./rankService');

const log = createLogger('economy');

/**
 * Economy service: chat rewards (XP + coins), daily/work/beg income, the
 * three minigames and profile data. Every balance change goes through
 * `economyRepository.adjustCash` inside a transaction, so a game can never
 * deduct a bet without also settling the outcome.
 *
 * Per-guild tuning (currency name, chat reward ranges, toggles) comes from
 * `guild_settings`; everything without a column falls back to
 * `config.ECONOMY_DEFAULTS`.
 */

class EconomyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EconomyError';
    this.userFacing = true;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SPAM_WINDOW_MS = 10_000;
const SPAM_MAX_MESSAGES = 5;
const LEVEL_UP_NOTICE_INTERVAL_MS = 2 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function int(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function chance01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Effective economy settings for a guild (DB columns merged over defaults). */
function getEconomySettings(guildId) {
  const row = settingsRepository.getSettings(guildId) ?? {};
  const D = ECONOMY_DEFAULTS;
  const settings = {
    currencyName: typeof row.currency_name === 'string' && row.currency_name.trim() ? row.currency_name.trim() : D.currencyName,
    currencySymbol: typeof row.currency_symbol === 'string' && row.currency_symbol.trim() ? row.currency_symbol.trim() : D.currencySymbol,
    economyEnabled: row.economy_enabled === undefined ? true : Number(row.economy_enabled) !== 0,
    chatRewardsEnabled: row.chat_rewards_enabled === undefined ? true : Number(row.chat_rewards_enabled) !== 0,
    chatXpMin: int(row.chat_xp_min, D.chatXpMin),
    chatXpMax: int(row.chat_xp_max, D.chatXpMax),
    chatCashMin: int(row.chat_cash_min, D.chatCashMin),
    chatCashMax: int(row.chat_cash_max, D.chatCashMax),
    chatCashChance: chance01(row.chat_cash_chance, D.chatCashChance),
    chatCooldownSeconds: Math.max(0, int(row.chat_cooldown_seconds, D.chatCooldownSeconds)),
    chatMinLength: Math.max(0, int(row.chat_min_length, D.chatMinLength)),
    dailyAmount: D.dailyAmount,
    dailyStreakBonus: D.dailyStreakBonus,
    dailyStreakMax: D.dailyStreakMax,
    workMin: D.workMin,
    workMax: D.workMax,
    workCooldownSeconds: D.workCooldownSeconds,
    begMin: D.begMin,
    begMax: D.begMax,
    begCooldownSeconds: D.begCooldownSeconds,
    begFailChance: D.begFailChance,
    minigameCooldownSeconds: D.minigameCooldownSeconds,
    minBet: D.minBet,
    maxBet: D.maxBet,
  };
  // Keep ranges sane even if someone stored min > max.
  if (settings.chatXpMin > settings.chatXpMax) [settings.chatXpMin, settings.chatXpMax] = [settings.chatXpMax, settings.chatXpMin];
  if (settings.chatCashMin > settings.chatCashMax) [settings.chatCashMin, settings.chatCashMax] = [settings.chatCashMax, settings.chatCashMin];
  return settings;
}

/** `'💰 12,500 Nekro Coins'` */
function formatCash(settings, amount) {
  return `${settings.currencySymbol} ${formatNumber(amount)} ${settings.currencyName}`;
}

/** Settings for the guild, or a user-facing error when the economy is switched off. */
function requireEnabled(guildId) {
  const settings = getEconomySettings(guildId);
  if (!settings.economyEnabled) {
    throw new EconomyError('The economy is **disabled** on this server. An Admin can turn it back on in the bot settings.');
  }
  return settings;
}

function isEnabled(guildId) {
  return getEconomySettings(guildId).economyEnabled;
}

/* ------------------------------------------------------------------ *
 * Randomness (crypto-backed, never Math.random)
 * ------------------------------------------------------------------ */

/** Uniform integer in [min, max] inclusive. */
function randomInt(min, max) {
  let lo = Math.trunc(Number(min) || 0);
  let hi = Math.trunc(Number(max) || 0);
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) return lo;
  return crypto.randomInt(lo, hi + 1);
}

/** True with probability `p` (0..1). */
function chance(p) {
  const clamped = Math.min(1, Math.max(0, Number(p) || 0));
  if (clamped <= 0) return false;
  if (clamped >= 1) return true;
  return crypto.randomInt(0, 1_000_000) < Math.round(clamped * 1_000_000);
}

function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

/* ------------------------------------------------------------------ *
 * Empty user shape (for members with no row yet)
 * ------------------------------------------------------------------ */

function emptyUser(guildId, userId) {
  return {
    guild_id: guildId,
    user_id: userId,
    cash: 0,
    lifetime_cash: 0,
    xp: 0,
    level: 0,
    message_count: 0,
    last_daily_at: null,
    daily_streak: 0,
    last_work_at: null,
    last_beg_at: null,
    last_chat_reward_at: null,
    last_message_hash: null,
    created_at: null,
    updated_at: null,
  };
}

function userOrEmpty(guildId, userId) {
  return economyRepository.getUser(guildId, userId) ?? emptyUser(guildId, userId);
}

/* ------------------------------------------------------------------ *
 * Chat rewards
 * ------------------------------------------------------------------ */

/** In-memory sliding windows for spam detection: `guild:user` → timestamps. */
const recentMessages = new Map();
/** Last level-up announcement per member so chat is not flooded. */
const levelUpNotices = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, stamps] of recentMessages) {
    const kept = stamps.filter((t) => now - t < SPAM_WINDOW_MS);
    if (kept.length === 0) recentMessages.delete(key);
    else recentMessages.set(key, kept);
  }
  for (const [key, at] of levelUpNotices) {
    if (now - at > LEVEL_UP_NOTICE_INTERVAL_MS) levelUpNotices.delete(key);
  }
}, 5 * 60 * 1000).unref();

/** Records a message in the sliding window; true when the member is spamming. */
function isSpamming(key, now) {
  const stamps = (recentMessages.get(key) ?? []).filter((t) => now - t < SPAM_WINDOW_MS);
  stamps.push(now);
  recentMessages.set(key, stamps);
  return stamps.length > SPAM_MAX_MESSAGES;
}

/** sha1 of the lower-cased, whitespace-collapsed content. */
function contentHash(content) {
  const normalized = String(content).toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

/**
 * Applies XP (and maybe coins) for one ordinary chat message.
 * Returns `null` when nothing was awarded, else `{ xp, cash, level, levelUp }`.
 * Never throws into the message handler.
 */
async function handleChatMessage(message) {
  try {
    if (!message?.guildId || !message.author || message.author.bot || message.system) return null;

    const guildId = message.guildId;
    const userId = message.author.id;
    const settings = getEconomySettings(guildId);
    if (!settings.economyEnabled) return null;

    const now = Date.now();
    const content = String(message.content ?? '').trim();
    const key = `${guildId}:${userId}`;

    // Every message counts towards the member's activity, rewarded or not.
    const user = economyRepository.incrementMessages(guildId, userId);

    if (!settings.chatRewardsEnabled) return null;

    // Spam window is evaluated for every message so bursts are always noticed.
    const spamming = isSpamming(key, now);
    if (spamming) return null;

    if (user.last_chat_reward_at && now - Number(user.last_chat_reward_at) < settings.chatCooldownSeconds * 1000) {
      return null;
    }
    if (content.length < settings.chatMinLength) return null;

    const hash = contentHash(content);
    if (user.last_message_hash === hash) return null;

    const xp = randomInt(settings.chatXpMin, settings.chatXpMax);
    const cash = chance(settings.chatCashChance) ? randomInt(settings.chatCashMin, settings.chatCashMax) : 0;

    const result = transaction(() => {
      const before = Number(user.level);
      const updated = economyRepository.addXp(guildId, userId, xp);
      const level = rankService.levelFromTotalXp(updated.xp);
      if (level !== Number(updated.level)) economyRepository.setLevel(guildId, userId, level);
      if (cash > 0) economyRepository.adjustCash(guildId, userId, cash, 'chat');
      economyRepository.updateUser(guildId, userId, { last_chat_reward_at: now, last_message_hash: hash });
      return { xp, cash, level, levelUp: level > before };
    });

    log.debug(`[${guildId}] chat reward user=${userId} xp=+${xp} cash=+${cash} level=${result.level}`);

    if (result.levelUp) {
      log.info(`[${guildId}] ${userId} reached rank ${result.level}.`);
      const lastNotice = levelUpNotices.get(key) ?? 0;
      if (now - lastNotice >= LEVEL_UP_NOTICE_INTERVAL_MS) {
        levelUpNotices.set(key, now);
        await message.channel
          ?.send({
            content: `🎉 <@${userId}> reached **Rank ${result.level}**!`,
            allowedMentions: { users: [userId] },
          })
          .catch((error) => log.debug(`Could not announce level-up in ${message.channelId}:`, error));
      }
    }

    return result;
  } catch (error) {
    log.error(`Chat reward failed for ${message?.author?.id} in ${message?.guildId}:`, error);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Income: daily / work / beg
 * ------------------------------------------------------------------ */

function cooldownError(what, readyAt) {
  return new EconomyError(`${what} — try again ${discordTime(readyAt, 'R')}.`);
}

/**
 * Claims the daily reward. A streak continues when the previous claim was
 * less than 48 h ago, otherwise it restarts at 1. Bonus = streakBonus × min(streak, streakMax).
 */
function daily(guildId, userId) {
  const settings = requireEnabled(guildId);
  const user = userOrEmpty(guildId, userId);
  const now = Date.now();
  const last = user.last_daily_at ? Number(user.last_daily_at) : null;

  if (last && now - last < DAY_MS) throw cooldownError('You already claimed your daily reward', last + DAY_MS);

  const continues = last !== null && now - last < 2 * DAY_MS;
  const streak = continues ? Number(user.daily_streak) + 1 : 1;
  const base = settings.dailyAmount;
  const bonus = settings.dailyStreakBonus * Math.min(streak, settings.dailyStreakMax);
  const amount = base + bonus;

  const { after } = transaction(() => {
    const change = economyRepository.adjustCash(guildId, userId, amount, 'daily');
    economyRepository.updateUser(guildId, userId, { last_daily_at: now, daily_streak: streak });
    return change;
  });

  log.info(`[${guildId}] daily user=${userId} amount=${amount} streak=${streak}`);
  return { settings, amount, base, bonus, streak, streakMax: settings.dailyStreakMax, maxed: streak >= settings.dailyStreakMax, balance: after, nextAt: now + DAY_MS };
}

const WORK_LINES = [
  'You mined a fresh vein of diamonds and sold them at spawn for {amount}.',
  'You spent the shift repairing the Nether hub. The council paid {amount}.',
  'You farmed a mountain of pumpkins. The villagers handed over {amount}.',
  'You escorted a trader through the Deep Dark and lived to collect {amount}.',
  'You fixed the redstone in the community sorter and earned {amount}.',
  'You sold enchanted books at the market for {amount}.',
  'You cleared a zombie spawner for a nervous newbie and got {amount} for it.',
  'You brewed potions all night. The apothecary paid {amount}.',
];

function work(guildId, userId) {
  const settings = requireEnabled(guildId);
  const user = userOrEmpty(guildId, userId);
  const now = Date.now();
  const cooldownMs = settings.workCooldownSeconds * 1000;
  const last = user.last_work_at ? Number(user.last_work_at) : null;
  if (last && now - last < cooldownMs) throw cooldownError('You are still tired from your last shift', last + cooldownMs);

  const amount = randomInt(settings.workMin, settings.workMax);
  const { after } = transaction(() => {
    const change = economyRepository.adjustCash(guildId, userId, amount, 'work');
    economyRepository.updateUser(guildId, userId, { last_work_at: now });
    return change;
  });

  log.info(`[${guildId}] work user=${userId} amount=${amount}`);
  return { settings, amount, line: pick(WORK_LINES).replace('{amount}', `**${formatCash(settings, amount)}**`), balance: after, nextAt: now + cooldownMs };
}

const BEG_SUCCESS_LINES = [
  'A kind villager took pity on you and tossed over {amount}.',
  'You found {amount} in a chest someone forgot to lock.',
  'A wandering trader felt generous today: {amount}.',
  'Someone at spawn flicked {amount} your way just to make you go away.',
  'A piglin misjudged a trade and you walked off with {amount}.',
];

const BEG_FAIL_LINES = [
  'A creeper answered your plea. It did not go well.',
  'Everyone at spawn suddenly had somewhere else to be.',
  'A villager stared at you, said "Hrmm", and walked off.',
  'You begged so hard a phantom spawned. No coins though.',
  'Your pockets stay empty. Try again later.',
];

function beg(guildId, userId) {
  const settings = requireEnabled(guildId);
  const user = userOrEmpty(guildId, userId);
  const now = Date.now();
  const cooldownMs = settings.begCooldownSeconds * 1000;
  const last = user.last_beg_at ? Number(user.last_beg_at) : null;
  if (last && now - last < cooldownMs) throw cooldownError('People are tired of your begging', last + cooldownMs);

  if (chance(settings.begFailChance)) {
    economyRepository.updateUser(guildId, userId, { last_beg_at: now });
    log.debug(`[${guildId}] beg user=${userId} failed`);
    return { settings, success: false, amount: 0, line: pick(BEG_FAIL_LINES), balance: Number(user.cash), nextAt: now + cooldownMs };
  }

  const amount = randomInt(settings.begMin, settings.begMax);
  const { after } = transaction(() => {
    const change = economyRepository.adjustCash(guildId, userId, amount, 'beg');
    economyRepository.updateUser(guildId, userId, { last_beg_at: now });
    return change;
  });

  log.info(`[${guildId}] beg user=${userId} amount=${amount}`);
  return { settings, success: true, amount, line: pick(BEG_SUCCESS_LINES).replace('{amount}', `**${formatCash(settings, amount)}**`), balance: after, nextAt: now + cooldownMs };
}

/* ------------------------------------------------------------------ *
 * Minigames
 * ------------------------------------------------------------------ */

const GAMES = {
  coinflip: { key: 'coinflip', label: 'Coinflip', emoji: '🪙' },
  slots: { key: 'slots', label: 'Slots', emoji: '🎰' },
  dice: { key: 'dice', label: 'Dice', emoji: '🎲' },
};

const SLOT_SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '💎', '7️⃣'];

/** Validates a bet against the guild limits and the member's balance. */
function validateBet(settings, user, bet) {
  const amount = Math.trunc(Number(bet));
  if (!Number.isInteger(amount) || amount <= 0) throw new EconomyError('The bet must be a whole number greater than zero.');
  if (amount < settings.minBet) throw new EconomyError(`The minimum bet is **${formatCash(settings, settings.minBet)}**.`);
  if (amount > settings.maxBet) throw new EconomyError(`The maximum bet is **${formatCash(settings, settings.maxBet)}**.`);
  if (Number(user.cash) < amount) {
    throw new EconomyError(`You cannot afford that bet — you have **${formatCash(settings, user.cash)}**.`);
  }
  return amount;
}

/** Shared pre-flight for every game: economy on, bet valid, not on cooldown. */
function prepareGame(guildId, userId, gameKey, bet) {
  const settings = requireEnabled(guildId);
  const user = userOrEmpty(guildId, userId);
  const amount = validateBet(settings, user, bet);
  const readyAt = economyRepository.getCooldown(guildId, userId, gameKey);
  if (readyAt) throw cooldownError(`Slow down, the ${GAMES[gameKey].label.toLowerCase()} table is cooling off`, readyAt);
  return { settings, user, amount };
}

/**
 * Settles a game in ONE transaction: bet out, payout in (when > 0), cooldown
 * stored. `payout` is the total returned to the player (0 = lost, bet = refund).
 */
function settleGame(guildId, userId, gameKey, settings, bet, payout, reason) {
  return transaction(() => {
    economyRepository.adjustCash(guildId, userId, -bet, `${gameKey}:bet`);
    let after = economyRepository.getUser(guildId, userId).cash;
    if (payout > 0) after = economyRepository.adjustCash(guildId, userId, payout, `${gameKey}:${reason}`).after;
    economyRepository.setCooldown(guildId, userId, gameKey, Date.now() + settings.minigameCooldownSeconds * 1000);
    return Number(after);
  });
}

/** `side` must be 'heads' or 'tails'. Win pays 2× the bet. */
function coinflip(guildId, userId, bet, side) {
  const choice = String(side ?? '').toLowerCase();
  if (choice !== 'heads' && choice !== 'tails') throw new EconomyError('Pick **heads** or **tails**.');
  const { settings, amount } = prepareGame(guildId, userId, GAMES.coinflip.key, bet);

  const landed = chance(0.5) ? 'heads' : 'tails';
  const won = landed === choice;
  const payout = won ? amount * 2 : 0;
  const balance = settleGame(guildId, userId, GAMES.coinflip.key, settings, amount, payout, 'win');

  log.info(`[${guildId}] coinflip user=${userId} bet=${amount} pick=${choice} landed=${landed} ${won ? 'WIN' : 'LOSS'} balance=${balance}`);
  return { settings, game: GAMES.coinflip, bet: amount, choice, landed, won, payout, net: payout - amount, balance };
}

/** Three reels of six symbols. 3 of a kind → 5×, a pair → 1.5× (floored), else lose. */
function slots(guildId, userId, bet) {
  const { settings, amount } = prepareGame(guildId, userId, GAMES.slots.key, bet);

  const reels = [pick(SLOT_SYMBOLS), pick(SLOT_SYMBOLS), pick(SLOT_SYMBOLS)];
  const [a, b, c] = reels;
  let outcome = 'lose';
  let payout = 0;
  if (a === b && b === c) {
    outcome = 'jackpot';
    payout = amount * 5;
  } else if (a === b || b === c || a === c) {
    outcome = 'pair';
    payout = Math.floor(amount * 1.5);
  }
  const balance = settleGame(guildId, userId, GAMES.slots.key, settings, amount, payout, outcome);

  log.info(`[${guildId}] slots user=${userId} bet=${amount} reels=${reels.join('')} ${outcome} payout=${payout} balance=${balance}`);
  return { settings, game: GAMES.slots, bet: amount, reels, outcome, won: payout > 0, payout, net: payout - amount, balance };
}

/**
 * With a guess (1-6): exact hit pays 5×. Without: your roll vs the bot's —
 * higher wins 2×, a tie refunds the bet.
 */
function dice(guildId, userId, bet, guess = null) {
  let target = null;
  if (guess !== null && guess !== undefined) {
    target = Math.trunc(Number(guess));
    if (!Number.isInteger(target) || target < 1 || target > 6) throw new EconomyError('The guess must be a number from **1** to **6**.');
  }
  const { settings, amount } = prepareGame(guildId, userId, GAMES.dice.key, bet);

  const roll = randomInt(1, 6);
  let botRoll = null;
  let outcome;
  let payout = 0;
  if (target !== null) {
    outcome = roll === target ? 'exact' : 'lose';
    payout = roll === target ? amount * 5 : 0;
  } else {
    botRoll = randomInt(1, 6);
    if (roll > botRoll) {
      outcome = 'win';
      payout = amount * 2;
    } else if (roll === botRoll) {
      outcome = 'tie';
      payout = amount;
    } else {
      outcome = 'lose';
    }
  }
  const balance = settleGame(guildId, userId, GAMES.dice.key, settings, amount, payout, outcome === 'tie' ? 'refund' : outcome);

  log.info(`[${guildId}] dice user=${userId} bet=${amount} guess=${target ?? '-'} roll=${roll} bot=${botRoll ?? '-'} ${outcome} balance=${balance}`);
  return { settings, game: GAMES.dice, bet: amount, guess: target, roll, botRoll, outcome, won: payout > amount, payout, net: payout - amount, balance };
}

/* ------------------------------------------------------------------ *
 * Profile / balance
 * ------------------------------------------------------------------ */

/** Everything the balance/profile commands render. Works for members without a row. */
function getProfile(guildId, userId) {
  const settings = getEconomySettings(guildId);
  const row = economyRepository.getUser(guildId, userId);
  const user = row ?? emptyUser(guildId, userId);
  const progress = rankService.progress(user.xp);
  const positions = row
    ? {
        wealth: economyRepository.rankPosition(guildId, userId, 'wealth'),
        rank: economyRepository.rankPosition(guildId, userId, 'rank'),
        top: rankService.topPosition(economyRepository.listScoreInputs(guildId), userId),
      }
    : { wealth: null, rank: null, top: null };

  return {
    settings,
    user,
    exists: Boolean(row),
    progress,
    bar: rankService.progressBar(progress.current, progress.needed, 10),
    positions,
    total: economyRepository.countUsers(guildId),
  };
}

/* ------------------------------------------------------------------ *
 * Scheduler hook
 * ------------------------------------------------------------------ */

/** Removes expired minigame cooldown rows. Registered with the scheduler by index.js. */
function sweepCooldowns() {
  const removed = economyRepository.sweepCooldowns();
  if (removed > 0) log.debug(`Swept ${removed} expired economy cooldown(s).`);
  return removed;
}

module.exports = {
  EconomyError,
  GAMES,
  SLOT_SYMBOLS,
  getEconomySettings,
  formatCash,
  requireEnabled,
  isEnabled,
  handleChatMessage,
  daily,
  work,
  beg,
  validateBet,
  coinflip,
  slots,
  dice,
  getProfile,
  sweepCooldowns,
  // exposed for tests
  randomInt,
  chance,
  contentHash,
};
