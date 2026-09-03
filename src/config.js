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
  name: 'Nekro Land',
  panelTitle: '💡 Nekro Land Suggestions',
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
};
