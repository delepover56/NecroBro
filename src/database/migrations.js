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
