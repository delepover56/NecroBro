'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { copyDatabase, useTempDatabase } = require('./helpers');
const { MIGRATIONS, runMigrations } = require('../src/database/migrations');

const LIVE_DB = path.join(__dirname, '..', 'data', 'nekrobro.db');

test('migrations are forward-only, apply once, and are idempotent', () => {
  const file = useTempDatabase('migrations');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  runMigrations(db);
  const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version));
  assert.deepEqual(applied, MIGRATIONS.map((m) => m.version));

  // Second run is a no-op.
  runMigrations(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, MIGRATIONS.length);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  for (const expected of [
    'guild_config', 'suggestions', 'votes', 'temp_channels',
    'guild_settings', 'guild_roles', 'economy_users', 'economy_cooldowns', 'economy_transactions',
    'giveaways', 'giveaway_entries', 'moderation_cases', 'warnings', 'mutes', 'temp_bans',
    'automod_settings', 'automod_violations',
  ]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('a v1 database (suggestions only) upgrades without losing rows', () => {
  const file = useTempDatabase('upgrade');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');

  // Apply only migration 1 and insert legacy data.
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  MIGRATIONS[0].up(db);
  db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(MIGRATIONS[0].name, Date.now());
  db.prepare('INSERT INTO guild_config (guild_id, suggestion_counter, created_at, updated_at) VALUES (?, 7, ?, ?)').run('g1', 1, 1);
  db.prepare(
    `INSERT INTO suggestions (guild_id, suggestion_number, author_id, title, category, description, status, created_at, updated_at)
     VALUES ('g1', 7, 'u1', 'Old idea', 'OTHER', 'desc', 'ACCEPTED', 1, 1)`,
  ).run();
  db.prepare("INSERT INTO votes (suggestion_id, user_id, vote_type, created_at, updated_at) VALUES (1, 'u2', 'UP', 1, 1)").run();

  runMigrations(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1);
  assert.equal(db.prepare('SELECT suggestion_counter FROM guild_config').get().suggestion_counter, 7);
  assert.equal(db.prepare('SELECT status FROM suggestions').get().status, 'ACCEPTED');
  // New nullable columns exist on the legacy row.
  const row = db.prepare('SELECT author_username, author_avatar_url FROM suggestions').get();
  assert.equal(row.author_username, null);
  db.close();
});

test('the real data/nekrobro.db (copied) migrates with every suggestion and vote intact', { skip: !fs.existsSync(LIVE_DB) }, () => {
  const before = new DatabaseSync(LIVE_DB, { readOnly: true });
  const suggestions = before.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n;
  const votes = before.prepare('SELECT COUNT(*) AS n FROM votes').get().n;
  const counter = before.prepare('SELECT COALESCE(MAX(suggestion_counter), 0) AS c FROM guild_config').get().c;
  before.close();

  const file = copyDatabase(LIVE_DB, 'live');
  const db = new DatabaseSync(file);
  runMigrations(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suggestions').get().n, suggestions);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM votes').get().n, votes);
  assert.equal(db.prepare('SELECT COALESCE(MAX(suggestion_counter), 0) AS c FROM guild_config').get().c, counter);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, MIGRATIONS.at(-1).version);
  db.close();
});
