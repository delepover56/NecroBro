'use strict';

const path = require('node:path');
require('dotenv').config();

/**
 * Central, immutable configuration for the Nekro Land suggestion system.
 *
 * Anything guild-specific (channel IDs, role IDs) lives in the database, not
 * here -- this file only holds process-level settings and shared constants.
 */

/** Reads a required environment variable, throwing a helpful error if absent. */
function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

const env = {
  get token() {
    return requireEnv('DISCORD_TOKEN');
  },
  get clientId() {
    return requireEnv('CLIENT_ID');
  },
  get guildId() {
    return requireEnv('GUILD_ID');
  },
  databasePath:
    process.env.DATABASE_PATH?.trim() ||
    path.join(process.cwd(), 'data', 'nekrobro.db'),
  logLevel: process.env.LOG_LEVEL?.trim().toLowerCase() || 'info',
};

/** Branding used across every embed / panel. */
const BRAND = {
  name: '𝐍𝐞𝐤𝐫𝐨𝐁𝐫𝐨',
  panelTitle: '💡 𝐍𝐞𝐤𝐫𝐨𝐁𝐫𝐨 Suggestions',
  panelDescription:
    'Have an idea for Nekro Land? Suggest new features, improvements, events, ' +
    'or changes and let the community help decide what comes next.',
  accentColor: 0x5865f2,
  successColor: 0x57f287,
  dangerColor: 0xed4245,
  neutralColor: 0x2b2d31,
};

/**
 * Suggestion statuses. `key` is what is stored in the database, everything
 * else is presentation. Adding a status here automatically adds it to the
 * staff status picker.
 */
const STATUSES = {
  UNDER_REVIEW: {
    key: 'UNDER_REVIEW',
    emoji: '🟡',
    label: 'Under Review',
    color: 0xfee75c,
    staffAction: 'Return to Under Review',
  },
  ACCEPTED: {
    key: 'ACCEPTED',
    emoji: '🟢',
    label: 'Accepted',
    color: 0x57f287,
    staffAction: 'Accept',
  },
  IMPLEMENTED: {
    key: 'IMPLEMENTED',
    emoji: '🔵',
    label: 'Implemented',
    color: 0x3498db,
    staffAction: 'Implement',
  },
  REJECTED: {
    key: 'REJECTED',
    emoji: '🔴',
    label: 'Rejected',
    color: 0xed4245,
    staffAction: 'Reject',
  },
  DUPLICATE: {
    key: 'DUPLICATE',
    emoji: '⚪',
    label: 'Duplicate',
    color: 0x99aab5,
    staffAction: 'Mark as Duplicate',
  },
};

const DEFAULT_STATUS = STATUSES.UNDER_REVIEW.key;

/** Resolves a stored status key to its presentation data, with a safe fallback. */
function getStatus(key) {
  return STATUSES[key] ?? STATUSES[DEFAULT_STATUS];
}

/** Categories offered in the suggestion modal's select menu. */
const CATEGORIES = [
  { value: 'FEATURE', label: 'Feature Request', emoji: '✨', description: 'A brand new feature or mechanic.' },
  { value: 'GAMEPLAY', label: 'Gameplay & Balance', emoji: '⚔️', description: 'Tweaks to how survival plays.' },
  { value: 'BUILDS', label: 'Builds & World', emoji: '🏗️', description: 'Spawn, terrain, warps, world changes.' },
  { value: 'ECONOMY', label: 'Shop & Economy', emoji: '🛒', description: 'Prices, shops, currency, trading.' },
  { value: 'EVENTS', label: 'Events', emoji: '🎉', description: 'Community events and competitions.' },
  { value: 'QOL', label: 'Quality of Life', emoji: '🧰', description: 'Small improvements and conveniences.' },
  { value: 'RULES', label: 'Rules & Moderation', emoji: '🛡️', description: 'Server rules and enforcement.' },
  { value: 'DISCORD', label: 'Discord & Community', emoji: '💬', description: 'Changes to this Discord server.' },
  { value: 'OTHER', label: 'Other', emoji: '📦', description: "Anything that doesn't fit above." },
];

/** Resolves a stored category value to its presentation data. */
function getCategory(value) {
  return (
    CATEGORIES.find((category) => category.value === value) ?? {
      value: 'OTHER',
      label: 'Other',
      emoji: '📦',
    }
  );
}

/** Modal validation limits. Kept well inside Discord's own hard limits. */
const LIMITS = {
  titleMin: 5,
  titleMax: 100,
  descriptionMin: 20,
  descriptionMax: 1500,
  staffResponseMax: 500,
};

/** Default channel names used only when a channel has to be created. */
const CHANNEL_NAMES = {
  intake: 'suggestions',
  voting: 'suggestion-voting',
  category: 'SUGGESTION SUBMISSIONS',
};

/** How long (ms) a temporary channel lingers after a successful submission. */
const TEMP_CHANNEL_CLEANUP_DELAY_MS = 6_000;

/** Namespaced custom IDs. Every interactive component routes through these. */
const IDS = {
  NAMESPACE: 'sg',
  PANEL_CREATE: 'sg:panel:create',
  TEMP_SUBMIT: 'sg:temp:submit',
  TEMP_CANCEL: 'sg:temp:cancel',
  TICKET_OPEN: 'tk:open',
  TICKET_MODAL: 'tk:modal',
  TICKET_CLOSE: 'tk:close',
  TICKET_DELETE: 'tk:delete',
  TICKET_PLATFORM: 'tk:platform',
  TICKET_DETAILS: 'tk:details',
  TICKET_FILES: 'tk:files',
  SUGGESTION_MODAL: 'sg:modal:suggestion',
  VOTE: 'sg:vote', // sg:vote:<UP|DOWN>:<suggestionId>
  STAFF_MANAGE: 'sg:staff:manage', // sg:staff:manage:<suggestionId>
  STAFF_SELECT: 'sg:staff:select', // sg:staff:select:<suggestionId>
  STAFF_MODAL: 'sg:staff:modal', // sg:staff:modal:<suggestionId>:<statusKey>
  FIELD_TITLE: 'title',
  FIELD_CATEGORY: 'category',
  FIELD_DESCRIPTION: 'description',
  FIELD_STAFF_RESPONSE: 'staff_response',
};

/* ------------------------------------------------------------------ *
 * Bot-wide (non-suggestion) configuration
 * ------------------------------------------------------------------ */

/** Default prefix for text commands when a guild has not chosen one. */
const DEFAULT_PREFIX = '?';
const PREFIX_MAX_LENGTH = 5;

/**
 * Permission levels, lowest to highest. A command declares the minimum level
 * it needs; `utils/permissions.js` resolves a member's level from the
 * configured logical roles (never from Discord's Administrator flag).
 */
const PERMISSION_LEVELS = {
  everyone: { key: 'everyone', rank: 0, label: 'Everyone' },
  moderator: { key: 'moderator', rank: 1, label: 'Moderator' },
  admin: { key: 'admin', rank: 2, label: 'Admin' },
  owner: { key: 'owner', rank: 3, label: 'Server Owner' },
};

/**
 * Logical role types. The database maps each type to a real Discord role ID
 * per guild; adding a type here makes it available to `/setrole` immediately.
 */
const ROLE_TYPES = {
  ADMIN: { key: 'ADMIN', label: 'Admin', emoji: '👑', description: 'Full bot access.' },
  MODERATOR: {
    key: 'MODERATOR',
    label: 'Moderator',
    emoji: '🛡️',
    description: 'Limited moderation commands.',
  },
  MEMBER: { key: 'MEMBER', label: 'Member', emoji: '👤', description: 'Assigned on join.' },
  SURVIVAL: {
    key: 'SURVIVAL',
    label: 'Survival',
    emoji: '⛏️',
    description: 'Assigned on join (Minecraft access).',
  },
  MUTE: { key: 'MUTE', label: 'Mute', emoji: '🔇', description: 'Applied by /mute.' },
};

/** Resolves a user-supplied role type ("admin", "Mute", ...) to its definition. */
function getRoleType(input) {
  const key = String(input ?? '').trim().toUpperCase();
  return ROLE_TYPES[key] ?? null;
}

/**
 * Initial role mapping for the home guild. Applied ONCE, the first time the
 * bot sees the guild with no mappings stored; after that the database is the
 * only source of truth and `/setrole` replaces any of these freely.
 */
const SEED_ROLES = {
  ADMIN: '1541167442791768187',
  MODERATOR: '1541173765004861621',
  MEMBER: '1541172960428040313',
  SURVIVAL: '1545160149834924132',
  MUTE: '1545160047808614400',
};

/** Help categories. Each command declares one `category` key. */
const COMMAND_CATEGORIES = {
  general: { key: 'general', emoji: '🏠', label: 'General', order: 0 },
  suggestions: { key: 'suggestions', emoji: '💡', label: 'Suggestions', order: 1 },
  giveaways: { key: 'giveaways', emoji: '🎉', label: 'Giveaways', order: 2 },
  economy: { key: 'economy', emoji: '💰', label: 'Economy', order: 3 },
  leaderboards: { key: 'leaderboards', emoji: '🏆', label: 'Leaderboards', order: 4 },
  moderation: { key: 'moderation', emoji: '🛡️', label: 'Moderation', order: 5 },
  admin: { key: 'admin', emoji: '⚙️', label: 'Administration', order: 6 },
  automod: { key: 'automod', emoji: '🤖', label: 'Automod', order: 7 },
};

/** Minecraft server-list voting links shown by `/vote`. */
const VOTE_LINKS = [
  { label: 'Vote #1', url: 'https://www.minecraftiplist.com/server/NekroLand-44215/vote' },
  { label: 'Vote #2', url: 'https://minecraftservers.org/vote/692286' },
  { label: 'Vote #3', url: 'https://minecraft-mp.com/server/363060/vote/' },
  { label: 'Vote #4', url: 'https://minecraft.buzz/vote/nekro-land' },
  { label: 'Vote #5', url: 'https://minecraft-serverlist.com/server/6241/vote' },
];

/** Economy defaults (per-guild overrides live in `guild_settings`). */
const ECONOMY_DEFAULTS = {
  currencyName: 'Nekro Coins',
  currencySymbol: '💰',
  chatXpMin: 15,
  chatXpMax: 25,
  chatCashMin: 1,
  chatCashMax: 5,
  chatCashChance: 0.35,
  chatCooldownSeconds: 60,
  chatMinLength: 5,
  dailyAmount: 500,
  dailyStreakBonus: 50,
  dailyStreakMax: 7,
  workMin: 150,
  workMax: 400,
  workCooldownSeconds: 60 * 60,
  begMin: 10,
  begMax: 80,
  begCooldownSeconds: 5 * 60,
  begFailChance: 0.3,
  minigameCooldownSeconds: 30,
  minBet: 10,
  maxBet: 50_000,
};

/** How often (ms) the background scheduler checks for expired mutes/bans/giveaways. */
const SCHEDULER_INTERVAL_MS = 15_000;

/** Namespaces for component custom IDs owned by each feature. */
const COMPONENT_NAMESPACES = {
  suggestions: 'sg',
  help: 'help',
  leaderboard: 'lb',
  giveaway: 'gw',
  moderation: 'mod',
  tickets: 'tk',
};

module.exports = {
  env,
  BRAND,
  STATUSES,
  DEFAULT_STATUS,
  getStatus,
  CATEGORIES,
  getCategory,
  LIMITS,
  CHANNEL_NAMES,
  TEMP_CHANNEL_CLEANUP_DELAY_MS,
  IDS,
  DEFAULT_PREFIX,
  PREFIX_MAX_LENGTH,
  PERMISSION_LEVELS,
  ROLE_TYPES,
  getRoleType,
  SEED_ROLES,
  COMMAND_CATEGORIES,
  VOTE_LINKS,
  ECONOMY_DEFAULTS,
  SCHEDULER_INTERVAL_MS,
  COMPONENT_NAMESPACES,
};
