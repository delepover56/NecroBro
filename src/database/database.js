'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { env } = require('../config');
const { createLogger } = require('../utils/logger');
const { runMigrations } = require('./migrations');

const log = createLogger('database');

/**
 * SQLite access layer built on Node 24's built-in `node:sqlite`.
 *
 * `DatabaseSync` is synchronous, which is exactly what we want here: every
 * statement is a single-row lookup or write, and synchronous execution removes
 * a whole class of interleaving bugs in vote counting. Multi-statement units of
 * work are wrapped in `transaction()` so they are atomic.
 */

let db = null;

/** Opens (and migrates) the database. Safe to call more than once. */
function initDatabase() {
  if (db) return db;

  const file = env.databasePath;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  db = new DatabaseSync(file);

  // WAL keeps readers from blocking the writer; the busy timeout means a
  // momentarily locked database retries instead of throwing.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  runMigrations(db);

  log.info(`Connected to SQLite at ${path.relative(process.cwd(), file) || file}`);
  return db;
}

/** Returns the open database handle, opening it on first use. */
function getDatabase() {
  return db ?? initDatabase();
}

/** Prepares a statement (node:sqlite caches nothing, so callers should reuse). */
function prepare(sql) {
  return getDatabase().prepare(sql);
}

/**
 * Runs `fn` inside an IMMEDIATE transaction and returns its result.
 * Rolls back on any thrown error. Nested calls reuse the outer transaction.
 */
let transactionDepth = 0;
function transaction(fn) {
  const handle = getDatabase();
  if (transactionDepth > 0) return fn(handle);

  handle.exec('BEGIN IMMEDIATE');
  transactionDepth += 1;
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch (rollbackError) {
      log.error('Failed to roll back transaction:', rollbackError);
    }
    throw error;
  } finally {
    transactionDepth -= 1;
  }
}

/** Closes the database. Called on graceful shutdown. */
function closeDatabase() {
  if (!db) return;
  try {
    db.close();
    log.info('SQLite connection closed.');
  } catch (error) {
    log.error('Error while closing SQLite:', error);
  } finally {
    db = null;
  }
}

module.exports = { initDatabase, getDatabase, prepare, transaction, closeDatabase };
