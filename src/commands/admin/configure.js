'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { PREFIX_MAX_LENGTH, ROLE_TYPES, getRoleType } = require('../../config');
const settingsRepository = require('../../database/settings');
const { validatePrefix } = require('../../services/prefixService');
const roleService = require('../../services/roleService');
const { missingChannelPermissions } = require('../../utils/permissions');
const { validImageUrl } = require('./setWelcomeImage');

const ROLE_CHOICES = Object.values(ROLE_TYPES).map((type) => ({ name: type.label, value: type.key }));
const CHANNEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function userError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

function channelSubcommand(name, description, setting, channelTypes) {
  return {
    name,
    description,
    args: [{ name: 'channel', type: 'channel', description: 'Channel to use. Omit to disable.', required: false, channelTypes }],
    async execute(ctx) {
      const channel = ctx.get('channel');
      if (!channel) {
        settingsRepository.updateSettings(ctx.guildId, { [setting]: null });
        return ctx.success(`${description.replace(/^Choose the channel (?:for|where|used for) /, '')} is now **disabled**.`);
      }
      const missing = missingChannelPermissions(channel, CHANNEL_PERMISSIONS);
      if (missing.length) return ctx.failure(`I cannot use ${channel}: missing **${missing.join('**, **')}**.`);
      settingsRepository.updateSettings(ctx.guildId, { [setting]: channel.id });
      return ctx.success(`${description.replace(/^Choose the channel (?:for|where|used for) /, '')} is now ${channel}.`);
    },
  };
}

const prefix = {
  name: 'prefix',
  description: 'Change the text-command prefix.',
  args: [{ name: 'prefix', type: 'string', description: `New prefix, up to ${PREFIX_MAX_LENGTH} characters.`, required: true, max: 32 }],
  async execute(ctx) {
    const value = ctx.get('prefix');
    const problem = validatePrefix(value);
    if (problem) return ctx.failure(problem);
    settingsRepository.setPrefix(ctx.guildId, value);
    return ctx.success(`Prefix updated to \`${value}\`. Slash commands always use \`/\`.`);
  },
};

const role = {
  name: 'role',
  description: 'Map a Discord role to a logical bot role.',
  args: [
    { name: 'role', type: 'role', description: 'Discord role to map.', required: true },
    { name: 'type', type: 'string', description: 'Logical role type.', required: true, choices: ROLE_CHOICES },
  ],
  async execute(ctx) {
    const discordRole = ctx.get('role');
    const type = getRoleType(ctx.get('type'));
    if (discordRole.id === ctx.guild.roles.everyone.id) return ctx.failure('The @everyone role cannot be used as a logical role.');
    if (discordRole.managed) return ctx.failure(`${discordRole} is managed by an integration and cannot be used.`);
    const previous = roleService.setRoleMapping(ctx.guild, type.key, discordRole, ctx.user.id);
    const prior = previous && previous !== discordRole.id ? ` (previously <@&${previous}>)` : '';
    return ctx.success(`${type.emoji} **${type.label}** role is now ${discordRole}${prior}.`);
  },
};

const welcomeImage = {
  name: 'welcome-image',
  description: 'Set or clear the bottom welcome image or GIF.',
  args: [{ name: 'url', type: 'text', description: 'Direct HTTPS/HTTP image or GIF URL. Omit to clear.', required: false, max: 2000 }],
  async execute(ctx) {
    const raw = ctx.get('url')?.trim();
    if (!raw) {
      settingsRepository.updateSettings(ctx.guildId, { welcome_image_url: null });
      return ctx.success('The welcome embed image/GIF is now **disabled**.');
    }
    const url = validImageUrl(raw);
    if (!url) return ctx.failure('Provide a valid direct `https://` or `http://` image/GIF URL.');
    settingsRepository.updateSettings(ctx.guildId, { welcome_image_url: url });
    return ctx.success('The welcome embed image/GIF has been updated.');
  },
};

function economySettingsSubcommand(name, description, args, update, confirmation) {
  return {
    name,
    description,
    args,
    async execute(ctx) {
      const patch = update(ctx);
      settingsRepository.updateSettings(ctx.guildId, patch);
      return ctx.success(confirmation(ctx));
    },
  };
}

const economyEnabled = economySettingsSubcommand(
  'economy-enabled',
  'Enable or disable the server economy.',
  [{ name: 'enabled', type: 'boolean', description: 'Whether the economy is enabled.', required: true }],
  (ctx) => ({ economy_enabled: ctx.get('enabled') ? 1 : 0 }),
  (ctx) => `The economy is now **${ctx.get('enabled') ? 'enabled' : 'disabled'}**.`,
);

const currency = economySettingsSubcommand(
  'currency',
  'Set the economy currency name and symbol.',
  [
    { name: 'name', type: 'string', description: 'Currency name, for example Nekro Coins.', required: true, max: 40 },
    { name: 'symbol', type: 'string', description: 'Currency symbol, for example 💰.', required: true, max: 12 },
  ],
  (ctx) => {
    if (!ctx.get('name').trim() || !ctx.get('symbol').trim()) throw userError('Currency name and symbol cannot be blank.');
    return { currency_name: ctx.get('name').trim(), currency_symbol: ctx.get('symbol').trim() };
  },
  (ctx) => `Currency updated to **${ctx.get('symbol').trim()} ${ctx.get('name').trim()}**.`,
);

const chatRewards = economySettingsSubcommand(
  'chat-rewards',
  'Enable or disable chat XP and cash rewards.',
  [{ name: 'enabled', type: 'boolean', description: 'Whether chat rewards are enabled.', required: true }],
  (ctx) => ({ chat_rewards_enabled: ctx.get('enabled') ? 1 : 0 }),
  (ctx) => `Chat rewards are now **${ctx.get('enabled') ? 'enabled' : 'disabled'}**.`,
);

const chatXp = economySettingsSubcommand(
  'chat-xp',
  'Set the minimum and maximum XP awarded per eligible chat message.',
  [
    { name: 'minimum', type: 'integer', description: 'Minimum XP.', required: true, min: 0, max: 10000 },
    { name: 'maximum', type: 'integer', description: 'Maximum XP.', required: true, min: 0, max: 10000 },
  ],
  (ctx) => {
    if (ctx.get('minimum') > ctx.get('maximum')) throw userError('Minimum XP cannot be greater than maximum XP.');
    return { chat_xp_min: ctx.get('minimum'), chat_xp_max: ctx.get('maximum') };
  },
  (ctx) => `Eligible messages now earn **${ctx.get('minimum')}-${ctx.get('maximum')} XP**.`,
);

const chatCash = economySettingsSubcommand(
  'chat-cash',
  'Set the minimum and maximum cash awarded by chat rewards.',
  [
    { name: 'minimum', type: 'integer', description: 'Minimum cash.', required: true, min: 0, max: 1000000 },
    { name: 'maximum', type: 'integer', description: 'Maximum cash.', required: true, min: 0, max: 1000000 },
  ],
  (ctx) => {
    if (ctx.get('minimum') > ctx.get('maximum')) throw userError('Minimum cash cannot be greater than maximum cash.');
    return { chat_cash_min: ctx.get('minimum'), chat_cash_max: ctx.get('maximum') };
  },
  (ctx) => `Chat cash rewards now range from **${ctx.get('minimum')}-${ctx.get('maximum')}**.`,
);

const chatCashChance = economySettingsSubcommand(
  'chat-cash-chance',
  'Set the percentage chance of a chat cash reward.',
  [{ name: 'percent', type: 'number', description: 'Chance from 0 to 100.', required: true, min: 0, max: 100 }],
  (ctx) => ({ chat_cash_chance: ctx.get('percent') / 100 }),
  (ctx) => `Chat cash reward chance is now **${ctx.get('percent')}%**.`,
);

const chatCooldown = economySettingsSubcommand(
  'chat-cooldown',
  'Set seconds a member waits between eligible chat rewards.',
  [{ name: 'seconds', type: 'integer', description: 'Cooldown from 0 to 86400 seconds.', required: true, min: 0, max: 86400 }],
  (ctx) => ({ chat_cooldown_seconds: ctx.get('seconds') }),
  (ctx) => `Chat reward cooldown is now **${ctx.get('seconds')} seconds**.`,
);

const chatMinLength = economySettingsSubcommand(
  'chat-min-length',
  'Set the minimum message length eligible for chat rewards.',
  [{ name: 'characters', type: 'integer', description: 'Length from 0 to 4000 characters.', required: true, min: 0, max: 4000 }],
  (ctx) => ({ chat_min_length: ctx.get('characters') }),
  (ctx) => `Messages need **${ctx.get('characters')} characters** for chat rewards.`,
);

module.exports = {
  name: 'config',
  category: 'admin',
  description: 'Edit the bot configuration for this server.',
  permission: 'admin',
  subcommands: [
    prefix,
    channelSubcommand('welcome', 'Choose the channel for welcome messages', 'welcome_channel_id', [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    channelSubcommand('goodbye', 'Choose the channel for goodbye messages', 'goodbye_channel_id', [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    channelSubcommand('modlog', 'Choose the channel for moderation logs', 'modlog_channel_id', [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    channelSubcommand('giveaway-channel', 'Choose the channel used for giveaways', 'giveaway_channel_id', [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
    welcomeImage,
    role,
    economyEnabled,
    currency,
    chatRewards,
    chatXp,
    chatCash,
    chatCashChance,
    chatCooldown,
    chatMinLength,
  ],
  examples: ['config economy-enabled on', 'config currency "Nekro Coins" 💰', 'config chat-xp 15 25', 'config chat-cash-chance 35', 'config chat-cooldown 60', 'config prefix !', 'config welcome #welcome'],
  async execute(ctx) {
    const subcommand = module.exports.subcommands.find((item) => item.name === ctx.subcommand);
    return subcommand.execute(ctx);
  },
};
