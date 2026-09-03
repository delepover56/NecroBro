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
  ],
  examples: ['config prefix !', 'config welcome #welcome', 'config goodbye #goodbye', 'config welcome-image https://example.com/welcome.gif', 'config modlog #mod-log', 'config giveaway-channel #giveaways', 'config role @Muted Mute'],
  async execute(ctx) {
    const subcommand = module.exports.subcommands.find((item) => item.name === ctx.subcommand);
    return subcommand.execute(ctx);
  },
};
