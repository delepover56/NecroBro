'use strict';

const { PERMISSION_LEVELS } = require('../config');
const { createLogger } = require('../utils/logger');
const {
  canUseCommand,
  describeAdminDenial,
  getPermissionLevel,
  missingBotPermissions,
} = require('../utils/permissions');
const { ArgumentError } = require('./args');
const registry = require('./commandRegistry');

const log = createLogger('dispatch');

/**
 * Runs a command through the same gates regardless of front-end:
 * guild-only → permission level → bot permissions → cooldown → execute,
 * with every failure turned into a clean reply and never a crash.
 */

/** In-memory per-user cooldowns. Losing these on restart is harmless. */
const cooldowns = new Map();

function cooldownKey(ctx) {
  return `${ctx.command.name}:${ctx.guildId}:${ctx.user.id}`;
}

function checkCooldown(ctx) {
  const seconds = ctx.command.cooldown;
  if (!seconds) return 0;
  const key = cooldownKey(ctx);
  const until = cooldowns.get(key) ?? 0;
  const now = Date.now();
  if (until > now) return Math.ceil((until - now) / 1000);
  cooldowns.set(key, now + seconds * 1000);
  return 0;
}

// Sweep expired cooldowns occasionally so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
}, 5 * 60 * 1000).unref();

function permissionDenial(ctx) {
  const required = ctx.command.permission;
  if (required === PERMISSION_LEVELS.admin.key) return describeAdminDenial(ctx.guild);
  if (required === PERMISSION_LEVELS.owner.key) return 'Only the **server owner** can use this.';
  if (required === PERMISSION_LEVELS.moderator.key) {
    return 'This requires the **Moderator** role or higher.';
  }
  return 'You do not have permission to use this command.';
}

/** Executes `ctx.command` with all gates applied. */
async function dispatch(ctx) {
  const { command } = ctx;

  if (!ctx.guild || !ctx.member) {
    return ctx.failure('Commands only work inside a server.');
  }

  if (!canUseCommand(ctx.member, command)) {
    log.debug(
      `${ctx.user.id} (${getPermissionLevel(ctx.member)}) denied ${command.name} ` +
        `(needs ${command.permission}) in guild ${ctx.guildId}`,
    );
    return ctx.failure(permissionDenial(ctx));
  }

  if (command.botPermissions.length > 0) {
    const missing = missingBotPermissions(ctx.guild, command.botPermissions);
    if (missing.length > 0) {
      return ctx.failure(
        `I am missing the **${missing.join('**, **')}** permission(s) needed for this command.`,
      );
    }
  }

  const wait = checkCooldown(ctx);
  if (wait > 0) {
    return ctx.failure(`Slow down — you can use \`${command.name}\` again in **${wait}s**.`);
  }

  try {
    return await command.execute(ctx);
  } catch (error) {
    return handleError(ctx, error);
  }
}

/** Turns any thrown error into a user-safe reply. */
async function handleError(ctx, error) {
  if (error instanceof ArgumentError || error?.userFacing) {
    const hint =
      error instanceof ArgumentError
        ? `\nUsage: \`${ctx.isSlash ? '/' : ctx.prefix}${registry.usage(
            ctx.command,
            ctx.subcommand ? registry.findSubcommand(ctx.command, ctx.subcommand) : null,
          )}\``
        : '';
    return ctx.failure(`${error.message}${hint}`);
  }

  if (error?.code === 50013) {
    log.warn(`Missing permissions while running ${ctx.command.name} in ${ctx.guildId}:`, error);
    return ctx.failure(
      'Discord refused that action because I lack permission. ' +
        'Check my role position and channel permissions.',
    );
  }

  log.error(`Command ${ctx.command.name} failed in guild ${ctx.guildId}:`, error);
  return ctx.failure('Something went wrong running that command. The error has been logged.');
}

module.exports = { dispatch, handleError };
