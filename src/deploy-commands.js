'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

const { env } = require('./config');
const { createLogger } = require('./utils/logger');

const log = createLogger('deploy');

/**
 * Slash command deployment, run on demand -- never on bot start-up.
 *
 *   npm run deploy          register to GUILD_ID (instant, for development)
 *   npm run deploy:global   register globally (can take up to an hour)
 *   npm run deploy -- --clear   remove the guild's commands
 */

/** Loads every `{ data, execute }` module from `src/commands`. */
function loadCommands() {
  const directory = path.join(__dirname, 'commands');
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.js'));

  const commands = [];
  for (const file of files) {
    const command = require(path.join(directory, file));
    if (!command?.data || typeof command.execute !== 'function') {
      log.warn(`Skipping ${file}: it does not export { data, execute }.`);
      continue;
    }
    commands.push(command.data.toJSON());
  }
  return commands;
}

async function main() {
  const args = process.argv.slice(2);
  const global = args.includes('--global');
  const clear = args.includes('--clear');

  const commands = clear ? [] : loadCommands();
  const rest = new REST({ version: '10' }).setToken(env.token);

  const route = global
    ? Routes.applicationCommands(env.clientId)
    : Routes.applicationGuildCommands(env.clientId, env.guildId);

  const scope = global ? 'globally' : `to guild ${env.guildId}`;
  log.info(clear ? `Clearing commands ${scope}…` : `Registering ${commands.length} command(s) ${scope}…`);

  const result = await rest.put(route, { body: commands });

  log.info(`Done. ${result.length} command(s) now registered ${scope}.`);
  for (const command of result) log.info(`  • /${command.name}`);
}

main().catch((error) => {
  if (error?.status === 401) {
    log.error('Discord rejected the token (401). Check DISCORD_TOKEN in your .env file.');
  } else if (error?.status === 403) {
    log.error(
      'Discord returned 403. Make sure the bot was invited with the applications.commands scope.',
    );
  } else {
    log.error('Command deployment failed:', error);
  }
  process.exitCode = 1;
});
