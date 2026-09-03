'use strict';

const { createLogger } = require('../utils/logger');

const log = createLogger('migrations');

/**
 * Ordered, forward-only migrations. Each entry runs exactly once and the
 * applied version is recorded in `schema_migrations`, so upgrading the bot
 * never destroys existing suggestions or votes.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS guild_config (
          guild_id                TEXT PRIMARY KEY,
          suggestions_channel_id  TEXT,
          voting_channel_id       TEXT,
          submission_category_id  TEXT,
          staff_log_channel_id    TEXT,
          panel_message_id        TEXT,
          staff_role_ids          TEXT NOT NULL DEFAULT '[]',
          suggestion_counter      INTEGER NOT NULL DEFAULT 0,
          created_at              INTEGER NOT NULL,
          updated_at              INTEGER NOT NULL
        );
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS suggestions (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id           TEXT    NOT NULL,
          suggestion_number  INTEGER NOT NULL,
          author_id          TEXT    NOT NULL,
          title              TEXT    NOT NULL,
          category           TEXT    NOT NULL,
          description        TEXT    NOT NULL,
          status             TEXT    NOT NULL DEFAULT 'UNDER_REVIEW',
          staff_response     TEXT,
          staff_responder_id TEXT,
          message_id         TEXT,
          channel_id         TEXT,
          created_at         INTEGER NOT NULL,
          updated_at         INTEGER NOT NULL
        );
      `);

      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_guild_number ' +
          'ON suggestions (guild_id, suggestion_number);',
      );
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_suggestions_message ON suggestions (message_id);',
      );
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_suggestions_author ON suggestions (guild_id, author_id);',
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS votes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          suggestion_id INTEGER NOT NULL,
          user_id       TEXT    NOT NULL,
          vote_type     TEXT    NOT NULL CHECK (vote_type IN ('UP', 'DOWN')),
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          FOREIGN KEY (suggestion_id) REFERENCES suggestions (id) ON DELETE CASCADE
        );
      `);

      // The hard guarantee that one member cannot hold two votes on one suggestion.
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_unique ' +
          'ON votes (suggestion_id, user_id);',
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS temp_channels (
          channel_id  TEXT PRIMARY KEY,
          guild_id    TEXT NOT NULL,
          user_id     TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
      `);
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_temp_channels_user ' +
          'ON temp_channels (guild_id, user_id);',
      );
    },
  },
  {
    version: 2,
    name: 'author_identity_snapshot',
    up(db) {
      // Snapshot the author's name and avatar at submission time so the embed
      // can render them without an API lookup -- and still renders correctly
      // after a restart, or once the member has left the server.
      db.exec('ALTER TABLE suggestions ADD COLUMN author_username TEXT');
      db.exec('ALTER TABLE suggestions ADD COLUMN author_avatar_url TEXT');
    },
  },
  {
    version: 3,
    name: 'multi_feature_platform',
    up(db) {
      /* ---------------- guild-wide settings (prefix, channels, economy) ---------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS guild_settings (
          guild_id               TEXT PRIMARY KEY,
          prefix                 TEXT    NOT NULL DEFAULT '?',
          welcome_channel_id     TEXT,
          modlog_channel_id      TEXT,
          currency_name          TEXT    NOT NULL DEFAULT 'Nekro Coins',
          currency_symbol        TEXT    NOT NULL DEFAULT '💰',
          economy_enabled        INTEGER NOT NULL DEFAULT 1,
          chat_rewards_enabled   INTEGER NOT NULL DEFAULT 1,
          chat_xp_min            INTEGER NOT NULL DEFAULT 15,
          chat_xp_max            INTEGER NOT NULL DEFAULT 25,
          chat_cash_min          INTEGER NOT NULL DEFAULT 1,
          chat_cash_max          INTEGER NOT NULL DEFAULT 5,
          chat_cash_chance       REAL    NOT NULL DEFAULT 0.35,
          chat_cooldown_seconds  INTEGER NOT NULL DEFAULT 60,
          chat_min_length        INTEGER NOT NULL DEFAULT 5,
          case_counter           INTEGER NOT NULL DEFAULT 0,
          created_at             INTEGER NOT NULL,
          updated_at             INTEGER NOT NULL
        );
      `);

      /* ---------------- logical role mappings ---------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS guild_roles (
          guild_id    TEXT NOT NULL,
          role_type   TEXT NOT NULL,
          role_id     TEXT NOT NULL,
          updated_by  TEXT,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (guild_id, role_type)
        );
      `);

      /* ---------------- economy + rank ---------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS economy_users (
          guild_id             TEXT    NOT NULL,
          user_id              TEXT    NOT NULL,
          cash                 INTEGER NOT NULL DEFAULT 0,
          lifetime_cash        INTEGER NOT NULL DEFAULT 0,
          xp                   INTEGER NOT NULL DEFAULT 0,
          level                INTEGER NOT NULL DEFAULT 0,
          message_count        INTEGER NOT NULL DEFAULT 0,
          last_daily_at        INTEGER,
          daily_streak         INTEGER NOT NULL DEFAULT 0,
          last_work_at         INTEGER,
          last_beg_at          INTEGER,
          last_chat_reward_at  INTEGER,
          last_message_hash    TEXT,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_economy_cash ON economy_users (guild_id, cash DESC);');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_economy_rank ON economy_users (guild_id, level DESC, xp DESC);',
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS economy_cooldowns (
          guild_id    TEXT    NOT NULL,
          user_id     TEXT    NOT NULL,
          key         TEXT    NOT NULL,
          expires_at  INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id, key)
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_economy_cooldowns_expiry ON economy_cooldowns (expires_at);',
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS economy_transactions (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id       TEXT    NOT NULL,
          user_id        TEXT    NOT NULL,
          amount         INTEGER NOT NULL,
          balance_after  INTEGER NOT NULL,
          reason         TEXT    NOT NULL,
          created_at     INTEGER NOT NULL
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_economy_tx_user ON economy_transactions (guild_id, user_id, created_at);',
      );

      /* ---------------- giveaways ---------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS giveaways (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id      TEXT    NOT NULL,
          channel_id    TEXT    NOT NULL,
          message_id    TEXT,
          type          TEXT    NOT NULL CHECK (type IN ('DISCORD', 'SURVIVAL')),
          prize         TEXT    NOT NULL,
          winner_count  INTEGER NOT NULL,
          creator_id    TEXT    NOT NULL,
          status        TEXT    NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'ENDED', 'CANCELLED')),
          ends_at       INTEGER NOT NULL,
          ended_at      INTEGER,
          winners       TEXT    NOT NULL DEFAULT '[]',
          reroll_count  INTEGER NOT NULL DEFAULT 0,
          audit         TEXT    NOT NULL DEFAULT '[]',
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_giveaways_active ON giveaways (status, ends_at);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways (guild_id, status);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_giveaways_message ON giveaways (message_id);');

      db.exec(`
        CREATE TABLE IF NOT EXISTS giveaway_entries (
          giveaway_id  INTEGER NOT NULL,
          user_id      TEXT    NOT NULL,
          created_at   INTEGER NOT NULL,
          PRIMARY KEY (giveaway_id, user_id),
          FOREIGN KEY (giveaway_id) REFERENCES giveaways (id) ON DELETE CASCADE
        );
      `);

      /* ---------------- moderation ---------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS moderation_cases (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id        TEXT    NOT NULL,
          case_number     INTEGER NOT NULL,
          action          TEXT    NOT NULL,
          target_id       TEXT,
          moderator_id    TEXT    NOT NULL,
          reason          TEXT,
          duration_ms     INTEGER,
          expires_at      INTEGER,
          metadata        TEXT,
          log_message_id  TEXT,
          created_at      INTEGER NOT NULL,
          UNIQUE (guild_id, case_number)
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_cases_target ON moderation_cases (guild_id, target_id, created_at);',
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS warnings (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id      TEXT    NOT NULL,
          user_id       TEXT    NOT NULL,
          moderator_id  TEXT    NOT NULL,
          reason        TEXT,
          case_id       INTEGER,
          source        TEXT    NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'AUTOMOD')),
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    INTEGER NOT NULL,
          cleared_at    INTEGER,
          cleared_by    TEXT
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings (guild_id, user_id, active, created_at);',
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS mutes (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id        TEXT    NOT NULL,
          user_id         TEXT    NOT NULL,
          mute_role_id    TEXT    NOT NULL,
          moderator_id    TEXT    NOT NULL,
          reason          TEXT,
          case_id         INTEGER,
          muted_at        INTEGER NOT NULL,
          mute_until      INTEGER,
          active          INTEGER NOT NULL DEFAULT 1,
          released_at     INTEGER,
          release_reason  TEXT
        );
      `);
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_mutes_active_user ON mutes (guild_id, user_id) WHERE active = 1;',
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_mutes_expiry ON mutes (active, mute_until);');

      db.exec(`
        CREATE TABLE IF NOT EXISTS temp_bans (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id      TEXT    NOT NULL,
          user_id       TEXT    NOT NULL,
          moderator_id  TEXT    NOT NULL,
          reason        TEXT,
          case_id       INTEGER,
          banned_at     INTEGER NOT NULL,
          unban_at      INTEGER NOT NULL,
          active        INTEGER NOT NULL DEFAULT 1,
          released_at   INTEGER
        );
      `);
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_temp_bans_active_user ON temp_bans (guild_id, user_id) WHERE active = 1;',
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_temp_bans_expiry ON temp_bans (active, unban_at);');

      /* ---------------- automod ---------------- */
      db.exec(`
        CREATE TABLE IF NOT EXISTS automod_settings (
          guild_id                  TEXT PRIMARY KEY,
          enabled                   INTEGER NOT NULL DEFAULT 0,
          bad_words_enabled         INTEGER NOT NULL DEFAULT 1,
          bad_words                 TEXT    NOT NULL DEFAULT '[]',
          links_enabled             INTEGER NOT NULL DEFAULT 0,
          allowed_domains           TEXT    NOT NULL DEFAULT '[]',
          spam_enabled              INTEGER NOT NULL DEFAULT 1,
          spam_max_messages         INTEGER NOT NULL DEFAULT 5,
          spam_interval_seconds     INTEGER NOT NULL DEFAULT 5,
          repeat_enabled            INTEGER NOT NULL DEFAULT 1,
          repeat_threshold          INTEGER NOT NULL DEFAULT 3,
          caps_enabled              INTEGER NOT NULL DEFAULT 1,
          caps_min_length           INTEGER NOT NULL DEFAULT 12,
          caps_percent              INTEGER NOT NULL DEFAULT 70,
          mentions_enabled          INTEGER NOT NULL DEFAULT 1,
          mentions_max              INTEGER NOT NULL DEFAULT 5,
          ignored_channels          TEXT    NOT NULL DEFAULT '[]',
          ignored_roles             TEXT    NOT NULL DEFAULT '[]',
          warn_threshold            INTEGER NOT NULL DEFAULT 3,
          timeout_threshold         INTEGER NOT NULL DEFAULT 5,
          timeout_minutes           INTEGER NOT NULL DEFAULT 10,
          violation_window_minutes  INTEGER NOT NULL DEFAULT 30,
          created_at                INTEGER NOT NULL,
          updated_at                INTEGER NOT NULL
        );
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS automod_violations (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id         TEXT    NOT NULL,
          user_id          TEXT    NOT NULL,
          rule             TEXT    NOT NULL,
          action_taken     TEXT    NOT NULL,
          message_excerpt  TEXT,
          channel_id       TEXT,
          created_at       INTEGER NOT NULL
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_automod_violations_user ON automod_violations (guild_id, user_id, created_at);',
      );
    },
  },
];

/** Applies every migration that has not yet run against `db`. */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)),
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      record.run(migration.version, migration.name, Date.now());
      db.exec('COMMIT');
      log.info(`Applied migration ${migration.version} (${migration.name}).`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${error.message}`,
        { cause: error },
      );
    }
  }
}

module.exports = { runMigrations, MIGRATIONS };
