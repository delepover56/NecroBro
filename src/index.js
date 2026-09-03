'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');

const { env } = require('./config');
const { closeDatabase, initDatabase } = require('./database/database');
const configRepository = require('./database/config');
const suggestionRepository = require('./database/suggestions');
const channelService = require('./services/channelService');
const { handleInteraction } = require('./interactions');
const { createLogger } = require('./utils/logger');

const log = createLogger('bot');

/**
 * Nekro Land suggestion bot -- process entry point.
 *
 * Responsibilities kept here and nowhere else: creating the client, loading
 * commands, wiring events, restart recovery, and shutting down cleanly.
 */

const client = new Client({
  intents: [
    // Guilds: channels, roles and interactions.
    GatewayIntentBits.Guilds,
    // GuildMessages: only so deleted panel/suggestion messages can be detected.
    GatewayIntentBits.GuildMessages,
  ],
});

client.commands = new Collection();

/** Loads every command module into `client.commands`. */
function loadCommands() {
  const directory = path.join(__dirname, 'commands');
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.js'))) {
    const command = require(path.join(directory, file));
    if (!command?.data || typeof command.execute !== 'function') {
      log.warn(`Skipping command file ${file}: expected exports { data, execute }.`);
      continue;
    }
    client.commands.set(command.data.name, command);
    log.debug(`Loaded command /${command.data.name}`);
  }
  log.info(`Loaded ${client.commands.size} command(s).`);
}

/**
 * Restart recovery.
 *
 * Nothing is held in memory between runs, so recovery just reconciles the
 * database with Discord: drop draft channels that no longer exist and clear
 * configuration pointing at deleted channels.
 */
async function recoverGuild(guild) {
  const config = configRepository.getGuildConfig(guild.id);
  if (!config) {
    log.info(`Guild ${guild.name} (${guild.id}) has not run /setup-suggestions yet.`);
    return;
  }

  const patch = {};
  const checks = [
    ['submission_category_id', 'submission category'],
    ['suggestions_channel_id', 'suggestions channel'],
    ['voting_channel_id', 'voting channel'],
    ['staff_log_channel_id', 'staff log channel'],
  ];

  for (const [column, label] of checks) {
    const id = config[column];
    if (!id) continue;
    const channel = await channelService.fetchChannel(guild, id);
    if (!channel) {
      log.warn(`The configured ${label} (${id}) is gone in ${guild.name}; clearing it.`);
      patch[column] = null;
    }
  }

  if (Object.keys(patch).length > 0) {
    if (patch.suggestions_channel_id === null) patch.panel_message_id = null;
    configRepository.updateGuildConfig(guild.id, patch);
    log.warn(
      `Configuration repaired for ${guild.name}. Run /setup-suggestions again to restore it fully.`,
    );
  }

  await channelService.recoverTempChannels(guild);
}

client.once(Events.ClientReady, async (readyClient) => {
  log.info(`Logged in as ${readyClient.user.tag} (${readyClient.user.id}).`);

  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await recoverGuild(guild);
    } catch (error) {
      log.error(`Recovery failed for guild ${guild.id}:`, error);
    }
  }

  log.info('Suggestion system online.');
});

client.on(Events.InteractionCreate, handleInteraction);

/** A deleted channel must never leave a dangling pointer in the database. */
client.on(Events.ChannelDelete, (channel) => {
  if (!channel.guild) return;

  try {
    if (configRepository.getTempChannel(channel.id)) {
      configRepository.deleteTempChannel(channel.id);
      log.info(`Draft channel ${channel.id} was deleted manually; record removed.`);
      return;
    }

    const config = configRepository.getGuildConfig(channel.guild.id);
    if (!config) return;

    const patch = {};
    if (config.submission_category_id === channel.id) patch.submission_category_id = null;
    if (config.voting_channel_id === channel.id) patch.voting_channel_id = null;
    if (config.staff_log_channel_id === channel.id) patch.staff_log_channel_id = null;
    if (config.suggestions_channel_id === channel.id) {
      patch.suggestions_channel_id = null;
      patch.panel_message_id = null;
    }

    if (Object.keys(patch).length > 0) {
      configRepository.updateGuildConfig(channel.guild.id, patch);
      log.warn(
        `Configured channel ${channel.id} was deleted in guild ${channel.guild.id}; ` +
          'cleared it. Run /setup-suggestions to restore the system.',
      );
    }
  } catch (error) {
    log.error('Failed to handle a channel deletion:', error);
  }
});

/** Keep suggestion/panel pointers honest when a message is deleted. */
client.on(Events.MessageDelete, (message) => {
  if (!message.guildId) return;

  try {
    const suggestion = suggestionRepository.getSuggestionByMessageId(message.id);
    if (suggestion) {
      suggestionRepository.detachMessage(suggestion.id);
      log.warn(
        `Suggestion #${suggestion.suggestion_number} lost its message; ` +
          'votes are preserved in the database.',
      );
      return;
    }

    const config = configRepository.getGuildConfig(message.guildId);
    if (config?.panel_message_id === message.id) {
      configRepository.updateGuildConfig(message.guildId, { panel_message_id: null });
      log.warn('The suggestion panel message was deleted. Run /setup-suggestions to repost it.');
    }
  } catch (error) {
    log.error('Failed to handle a message deletion:', error);
  }
});

/**
 * Members who leave keep their votes: removing them would silently rewrite
 * historical totals. Their name simply renders as an unresolved mention.
 */
client.on(Events.GuildMemberRemove, (member) => {
  log.debug(`${member.id} left guild ${member.guild.id}; their votes are retained.`);
});

client.on(Events.Error, (error) => log.error('Discord client error:', error));
client.on(Events.Warn, (message) => log.warn('Discord client warning:', message));
client.rest.on('rateLimited', (info) =>
  log.warn(`Rate limited for ${info.timeToReset}ms on ${info.route}`),
);

/* ------------------------------------------------------------------ *
 * Process lifecycle
 * ------------------------------------------------------------------ */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}; shutting down…`);

  try {
    await client.destroy();
  } catch (error) {
    log.error('Error while destroying the Discord client:', error);
  }

  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
  void shutdown('uncaughtException');
});

async function main() {
  initDatabase();
  loadCommands();
  await client.login(env.token);
}

main().catch((error) => {
  if (error?.code === 'TokenInvalid' || error?.status === 401) {
    log.error('Discord rejected the bot token. Check DISCORD_TOKEN in your .env file.');
  } else if (error instanceof Error && error.message.includes('Missing required environment')) {
    log.error(error.message);
  } else {
    log.error('The bot failed to start:', error);
  }
  closeDatabase();
  process.exitCode = 1;
});
