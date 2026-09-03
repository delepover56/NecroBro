'use strict';

const { EmbedBuilder } = require('discord.js');

const { BRAND, ROLE_TYPES } = require('../../config');
const configRepository = require('../../database/config');
const settingsRepository = require('../../database/settings');
const { getDatabase } = require('../../database/database');
const roleService = require('../../services/roleService');

function describeRole(state) {
  switch (state.state) {
    case 'unset':
      return '❌ not set';
    case 'missing':
      return `⚠️ deleted (\`${state.roleId}\`)`;
    case 'unassigned':
      return `⚠️ <@&${state.roleId}> — nobody holds it (owner-only mode)`;
    default:
      return `✅ <@&${state.roleId}>`;
  }
}

function describeChannel(guild, id) {
  if (!id) return '❌ not set';
  return guild.channels.cache.has(id) ? `✅ <#${id}>` : `⚠️ deleted (\`${id}\`)`;
}

/** Reads automod status without importing the automod feature (it may be absent). */
function automodSummary(guildId) {
  try {
    const row = getDatabase()
      .prepare('SELECT enabled FROM automod_settings WHERE guild_id = ?')
      .get(guildId);
    if (!row) return '⚪ not configured';
    return Number(row.enabled) ? '🟢 enabled' : '🔴 disabled';
  } catch {
    return '⚪ unavailable';
  }
}

module.exports = {
  name: 'config',
  aliases: ['settings'],
  category: 'admin',
  description: 'Show the current bot configuration for this server.',
  permission: 'admin',
  args: [],
  examples: ['config'],
  async execute(ctx) {
    const { guild } = ctx;
    const settings = settingsRepository.ensureSettings(guild.id);
    const suggestions = configRepository.getGuildConfig(guild.id);
    const roles = roleService.getConfiguredRoles(guild);

    const roleLines = Object.values(ROLE_TYPES).map(
      (type) => `${type.emoji} **${type.label}:** ${describeRole(roles[type.key])}`,
    );

    const embed = new EmbedBuilder()
      .setColor(BRAND.accentColor)
      .setTitle(`⚙️ ${guild.name} — Bot Configuration`)
      .addFields(
        {
          name: 'General',
          value:
            `**Prefix:** \`${settings.prefix}\`\n` +
            `**Welcome channel:** ${describeChannel(guild, settings.welcome_channel_id)}\n` +
            `**Mod-log channel:** ${describeChannel(guild, settings.modlog_channel_id)}\n` +
            `**Server owner:** <@${guild.ownerId}>`,
        },
        { name: 'Logical roles', value: roleLines.join('\n') },
        {
          name: 'Suggestions',
          value: suggestions
            ? `**Panel channel:** ${describeChannel(guild, suggestions.suggestions_channel_id)}\n` +
              `**Voting channel:** ${describeChannel(guild, suggestions.voting_channel_id)}\n` +
              `**Submission category:** ${describeChannel(guild, suggestions.submission_category_id)}\n` +
              `**Staff log:** ${describeChannel(guild, suggestions.staff_log_channel_id)}\n` +
              `**Extra staff roles:** ${
                suggestions.staffRoleIds.length
                  ? suggestions.staffRoleIds.map((id) => (guild.roles.cache.has(id) ? `<@&${id}>` : `⚠️ \`${id}\``)).join(', ')
                  : '_none_'
              }\n` +
              `**Suggestions submitted:** ${suggestions.suggestion_counter}`
            : '❌ not set up — run `/setup-suggestions`',
        },
        {
          name: 'Economy',
          value:
            `**Status:** ${Number(settings.economy_enabled) ? '🟢 enabled' : '🔴 disabled'}\n` +
            `**Currency:** ${settings.currency_symbol} ${settings.currency_name}\n` +
            `**Chat rewards:** ${Number(settings.chat_rewards_enabled) ? '🟢 on' : '🔴 off'} ` +
            `(${settings.chat_xp_min}-${settings.chat_xp_max} XP, ` +
            `${settings.chat_cash_min}-${settings.chat_cash_max} cash at ${Math.round(settings.chat_cash_chance * 100)}%, ` +
            `every ${settings.chat_cooldown_seconds}s)`,
        },
        { name: 'Automod', value: automodSummary(guild.id) },
      )
      .setFooter({ text: 'Fix roles with setrole • channels with setwelcome / setmodlog / setup-suggestions' });

    return ctx.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  },
};
