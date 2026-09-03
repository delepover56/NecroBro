'use strict';

const path = require('node:path');
const { REST, Routes } = require('discord.js');

const { env } = require('./config');
const registry = require('./core/commandRegistry');
const { createLogger } = require('./utils/logger');

const log = createLogger('deploy');

/**
 * Slash command deployment, run on demand -- never on bot start-up.
 *
 *   npm run deploy            register to GUILD_ID (instant, for development)
 *   npm run deploy:global     register globally (can take up to an hour)
 *   npm run deploy:clear      remove the guild's commands
 *
 * Every command module under src/commands is discovered automatically; the
 * slash payload is derived from each command's argument schema.
 */

async function main() {
  const args = process.argv.slice(2);
  const global = args.includes('--global');
  const clear = args.includes('--clear');

  let body = [];
  if (!clear) {
    registry.loadCommands(path.join(__dirname, 'commands'));
    body = registry.all().map((command) => registry.toSlashJSON(command));
  }

  const rest = new REST({ version: '10' }).setToken(env.token);
  const route = global
    ? Routes.applicationCommands(env.clientId)
    : Routes.applicationGuildCommands(env.clientId, env.guildId);

  const scope = global ? 'globally' : `to guild ${env.guildId}`;
  log.info(clear ? `Clearing commands ${scope}…` : `Registering ${body.length} command(s) ${scope}…`);

  const result = await rest.put(route, { body });

  log.info(`Done. ${result.length} command(s) now registered ${scope}.`);
  for (const command of result) log.info(`  • /${command.name}`);
}

main().catch((error) => {
  if (error?.status === 401) {
    log.error('Discord rejected the token (401). Check DISCORD_TOKEN in your .env file.');
  } else if (error?.status === 403) {
    log.error('Discord returned 403. Make sure the bot was invited with the applications.commands scope.');
  } else if (error?.rawError?.errors) {
    log.error('Discord rejected the command payload:', JSON.stringify(error.rawError.errors, null, 2));
  } else {
    log.error('Command deployment failed:', error);
  }
  process.exitCode = 1;
});
