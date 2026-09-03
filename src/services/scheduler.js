'use strict';

const { SCHEDULER_INTERVAL_MS } = require('../config');
const { createLogger } = require('../utils/logger');

const log = createLogger('scheduler');

/**
 * Tiny background job runner.
 *
 * Time-based state (mute expiry, temporary bans, giveaway endings) lives in
 * SQLite; each registered job simply asks "what is due now?" on every tick.
 * That is what makes those features survive restarts -- a `setTimeout` alone
 * would evaporate with the process.
 */

const jobs = new Map();
let timer = null;
let client = null;

/** Registers a job. `run(client)` is awaited; overlapping runs are skipped. */
function register(name, run) {
  if (jobs.has(name)) throw new Error(`Scheduler job "${name}" already registered.`);
  jobs.set(name, { name, run, running: false, failures: 0 });
  log.debug(`Registered job ${name}.`);
}

async function tick() {
  for (const job of jobs.values()) {
    if (job.running) continue;
    job.running = true;
    try {
      await job.run(client);
      job.failures = 0;
    } catch (error) {
      job.failures += 1;
      log.error(`Job ${job.name} failed (${job.failures} in a row):`, error);
    } finally {
      job.running = false;
    }
  }
}

/** Starts ticking. Runs one tick immediately so overdue work is handled at boot. */
function start(discordClient, intervalMs = SCHEDULER_INTERVAL_MS) {
  if (timer) return;
  client = discordClient;
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  log.info(`Scheduler started with ${jobs.size} job(s) every ${Math.round(intervalMs / 1000)}s.`);
  void tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Runs every job once, right now (used by tests and after config changes). */
function runNow() {
  return tick();
}

module.exports = { register, start, stop, runNow };
