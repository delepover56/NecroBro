'use strict';

const path = require('node:path');
const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');

const { env } = require('./config');
const registry = require('./core/commandRegistry');
const { closeDatabase, initDatabase } = require('./database/database');
const configRepository = require('./database/config');
const settingsRepository = require('./database/settings');
const suggestionRepository = require('./database/suggestions');
const channelService = require('./services/channelService');
const moderationService = require('./services/moderationService');
const prefixService = require('./services/prefixService');
const roleService = require('./services/roleService');
const scheduler = require('./services/scheduler');
const welcomeService = require('./services/welcomeService');
const { handleInteraction } = require('./interactions');
const { createLogger } = require('./utils/logger');

const log = createLogger('bot');

/**
 * NekroBro -- process entry point.
 *
 * Responsibilities kept here and nowhere else: creating the client, loading
 * commands, wiring gateway events to services, restart recovery, the
 * background scheduler, and shutting down cleanly. Feature logic lives in
 * services/, commands/ and interactions/.
 */

const client = new Client({
  intents: [
    // Guilds: channels, roles and interactions.
    GatewayIntentBits.Guilds,
    // GuildMembers (privileged): join events for welcome / auto-roles / mute restore.
    GatewayIntentBits.GuildMembers,
    // GuildMessages + MessageContent (privileged): prefix commands, chat rewards, automod.
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // GuildModeration: ban/unban events for temp-ban bookkeeping.
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.GuildMember, Partials.Message],
});

/* ------------------------------------------------------------------ *
 * Optional feature hooks (present once those modules are implemented)
 * ------------------------------------------------------------------ */

function optional(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && String(error.message).includes(path.basename(modulePath))) {
      log.debug(`Optional module ${modulePath} not present.`);
      return null;
    }
    throw error;
  }
}

const automodService = optional('./services/automodService');
const economyService = optional('./services/economyService');
const giveawayService = optional('./services/giveawayService');

/* ------------------------------------------------------------------ *
 * Restart recovery
 * ------------------------------------------------------------------ */

async function recoverGuild(guild) {
  settingsRepository.ensureSettings(guild.id);
  roleService.seedHomeGuild(guild);

  const config = configRepository.getGuildConfig(guild.id);
  if (config) {
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
      log.warn(`Suggestion configuration repaired for ${guild.name}. Run /setup-suggestions to restore it fully.`);
    }
    await channelService.recoverTempChannels(guild);
  } else {
    log.info(`Guild ${guild.name} (${guild.id}) has not run /setup-suggestions yet.`);
  }

  const settings = settingsRepository.getSettings(guild.id);
  for (const [column, label] of [
    ['welcome_channel_id', 'welcome channel'],
    ['modlog_channel_id', 'mod-log channel'],
  ]) {
    if (settings?.[column] && !(await channelService.fetchChannel(guild, settings[column]))) {
      log.warn(`The configured ${label} (${settings[column]}) is gone in ${guild.name}; clearing it.`);
      settingsRepository.updateSettings(guild.id, { [column]: null });
    }
  }

  const roles = roleService.getConfiguredRoles(guild);
  for (const [type, state] of Object.entries(roles)) {
    if (state.state === 'missing') {
      log.warn(`Configured ${type} role ${state.roleId} no longer exists in ${guild.name}. Use setrole to replace it.`);
    } else if (state.state === 'unassigned') {
      log.warn(`Nobody holds the ${type} role in ${guild.name}; Admin commands are owner-only until someone does.`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

client.once(Events.ClientReady, async (readyClient) => {
  log.info(`Logged in as ${readyClient.user.tag} (${readyClient.user.id}).`);

  for (const guild of readyClient.guilds.cache.values()) {
    try {
      // Populate the member cache so role.members and hierarchy checks are accurate.
      await guild.members.fetch().catch((error) => log.warn(`Could not fetch members for ${guild.name}:`, error));
      await recoverGuild(guild);
    } catch (error) {
      log.error(`Recovery failed for guild ${guild.id}:`, error);
    }
  }

  scheduler.register('expire-mutes', (c) => moderationService.expireMutes(c));
  scheduler.register('expire-temp-bans', (c) => moderationService.expireTempBans(c));
  if (giveawayService?.processDueGiveaways) {
    scheduler.register('end-giveaways', (c) => giveawayService.processDueGiveaways(c));
  }
  if (economyService?.sweepCooldowns) {
    scheduler.register('economy-cooldowns', () => economyService.sweepCooldowns());
  }
  scheduler.start(readyClient);

  log.info(`NekroBro online with ${registry.size} command(s).`);
});

client.on(Events.GuildCreate, async (guild) => {
  log.info(`Joined guild ${guild.name} (${guild.id}).`);
  await guild.members.fetch().catch(() => undefined);
  await recoverGuild(guild).catch((error) => log.error(`Recovery failed for new guild ${guild.id}:`, error));
});

client.on(Events.InteractionCreate, handleInteraction);

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.partial) await message.fetch().catch(() => undefined);
    if (message.author?.bot || !message.inGuild()) return;

    const handledAsCommand = await prefixService.handleMessage(message);
    if (handledAsCommand) return;

    if (automodService?.handleMessage) {
      const acted = await automodService.handleMessage(message);
      if (acted) return;
    }

    if (economyService?.handleChatMessage) {
      await economyService.handleChatMessage(message);
    }
  } catch (error) {
    log.error('Unhandled error in messageCreate:', error);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const restored = await moderationService.restoreMuteOnJoin(member);
    const roles = await roleService.assignJoinRoles(member);
    if (roles.skipped.length > 0) {
      log.debug(`Join roles skipped for ${member.id}: ${roles.skipped.map((s) => `${s.type} (${s.reason})`).join('; ')}`);
    }
    if (!restored.restored) await welcomeService.sendWelcome(member);
  } catch (error) {
    log.error(`guildMemberAdd handling failed for ${member.id}:`, error);
  }
});

client.on(Events.GuildMemberRemove, (member) => {
  const mute = moderationService.getActiveMute(member.guild.id, member.id);
  if (mute) {
    log.info(`${member.id} left ${member.guild.id} while muted; mute stays active until ${mute.mute_until ? new Date(mute.mute_until).toISOString() : 'unmuted'}.`);
  }
});

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
    if (config) {
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
        log.warn(`Configured suggestion channel ${channel.id} was deleted; cleared it. Run /setup-suggestions to restore.`);
      }
    }

    const settings = settingsRepository.getSettings(channel.guild.id);
    if (settings) {
      const patch = {};
      if (settings.welcome_channel_id === channel.id) patch.welcome_channel_id = null;
      if (settings.modlog_channel_id === channel.id) patch.modlog_channel_id = null;
      if (Object.keys(patch).length > 0) {
        settingsRepository.updateSettings(channel.guild.id, patch);
        log.warn(`Configured channel ${channel.id} was deleted; cleared ${Object.keys(patch).join(', ')}.`);
      }
    }

    if (giveawayService?.handleChannelDelete) giveawayService.handleChannelDelete(channel);
  } catch (error) {
    log.error('Failed to handle a channel deletion:', error);
  }
});

/** Deleted roles are reported, never silently ignored. */
client.on(Events.GuildRoleDelete, (role) => {
  try {
    const roles = roleService.getConfiguredRoles(role.guild);
    for (const [type, state] of Object.entries(roles)) {
      if (state.roleId === role.id) {
        log.warn(
          `The ${type} role "${role.name}" (${role.id}) was deleted in ${role.guild.name}. ` +
            `An Admin or the owner must run setrole to map a replacement.`,
        );
      }
    }
  } catch (error) {
    log.error('Failed to handle a role deletion:', error);
  }
});

/** Keep suggestion/panel/giveaway pointers honest when a message is deleted. */
client.on(Events.MessageDelete, (message) => {
  if (!message.guildId) return;
  try {
    const suggestion = suggestionRepository.getSuggestionByMessageId(message.id);
    if (suggestion) {
      suggestionRepository.detachMessage(suggestion.id);
      log.warn(`Suggestion #${suggestion.suggestion_number} lost its message; votes are preserved.`);
      return;
    }

    const config = configRepository.getGuildConfig(message.guildId);
    if (config?.panel_message_id === message.id) {
      configRepository.updateGuildConfig(message.guildId, { panel_message_id: null });
      log.warn('The suggestion panel message was deleted. Run /setup-suggestions to repost it.');
      return;
    }

    if (giveawayService?.handleMessageDelete) giveawayService.handleMessageDelete(message);
  } catch (error) {
    log.error('Failed to handle a message deletion:', error);
  }
});

client.on(Events.Error, (error) => log.error('Discord client error:', error));
client.on(Events.Warn, (message) => log.warn('Discord client warning:', message));
client.rest.on('rateLimited', (info) => log.warn(`Rate limited for ${info.timeToReset}ms on ${info.route}`));

/* ------------------------------------------------------------------ *
 * Process lifecycle
 * ------------------------------------------------------------------ */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}; shutting down…`);
  scheduler.stop();
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
  registry.loadCommands(path.join(__dirname, 'commands'));
  log.info(`Loaded ${registry.size} command(s).`);
  await client.login(env.token);
}

main().catch((error) => {
  if (error?.code === 'TokenInvalid' || error?.status === 401) {
    log.error('Discord rejected the bot token. Check DISCORD_TOKEN in your .env file.');
  } else if (error?.code === 'DisallowedIntents') {
    log.error(
      'Discord refused the connection: privileged intents are not enabled. ' +
        'Open the Developer Portal → your application → Bot → Privileged Gateway Intents and enable ' +
        '"Server Members Intent" and "Message Content Intent", then restart.',
    );
  } else if (error instanceof Error && error.message.includes('Missing required environment')) {
    log.error(error.message);
  } else {
    log.error('The bot failed to start:', error);
  }
  closeDatabase();
  process.exitCode = 1;
});

module.exports = { client };
