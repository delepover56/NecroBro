'use strict';

/**
 * Minimal levelled console logger with secret redaction.
 *
 * Every message (and every serialised error) is scrubbed for the bot token and
 * any other value that looks like a credential before it reaches stdout, so a
 * stack trace can never leak `DISCORD_TOKEN`.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const SENSITIVE_ENV_KEYS = ['DISCORD_TOKEN', 'CLIENT_SECRET', 'DATABASE_URL', 'DATABASE_PASSWORD'];

/** Values that must never appear in output, collected lazily from the env. */
function secrets() {
  const values = [];
  for (const key of SENSITIVE_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length >= 8) values.push(value.trim());
  }
  return values;
}

// Matches a bare Discord bot token even if it never went through process.env.
const TOKEN_PATTERN = /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g;

function redact(input) {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const secret of secrets()) {
    text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(TOKEN_PATTERN, '[REDACTED_TOKEN]');
}

function safeStringify(value) {
  if (value instanceof Error) {
    return value.stack ? `${value.stack}` : `${value.name}: ${value.message}`;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const PREFIX = {
  error: '\x1b[31m[ERROR]\x1b[0m',
  warn: '\x1b[33m[WARN ]\x1b[0m',
  info: '\x1b[36m[INFO ]\x1b[0m',
  debug: '\x1b[90m[DEBUG]\x1b[0m',
};

function currentLevel() {
  const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[configured] ?? LEVELS.info;
}

function write(level, scope, parts) {
  if (LEVELS[level] > currentLevel()) return;
  const body = parts.map((part) => redact(part)).join(' ');
  const line = `${timestamp()} ${PREFIX[level]} ${scope ? `(${scope}) ` : ''}${body}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Creates a logger bound to a scope name, e.g. `logger('voting')`. */
function createLogger(scope) {
  return {
    error: (...parts) => write('error', scope, parts),
    warn: (...parts) => write('warn', scope, parts),
    info: (...parts) => write('info', scope, parts),
    debug: (...parts) => write('debug', scope, parts),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

module.exports = { createLogger, redact };
