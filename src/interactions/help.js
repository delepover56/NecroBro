'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const { BRAND, COMMAND_CATEGORIES, COMPONENT_NAMESPACES, PERMISSION_LEVELS } = require('../config');
const registry = require('../core/commandRegistry');
const settingsRepository = require('../database/settings');
const { getPermissionLevel, levelRank } = require('../utils/permissions');
const { deferComponentUpdate, failure } = require('../utils/respond');

/**
 * Help pages: an overview of categories, and one page per category listing
 * every command with its usage and required permission. Navigation uses
 * buttons that edit the same message. Category buttons are hidden for the
 * viewer when they hold no command they could use.
 */

const NS = COMPONENT_NAMESPACES.help; // help:<category|home>:<ownerId>

function permissionBadge(command) {
  const level = PERMISSION_LEVELS[command.permission];
  return level.rank === 0 ? '' : ` · **${level.label}**`;
}

function visibleCategories(member) {
  const viewerRank = levelRank(getPermissionLevel(member));
  const groups = registry.byCategory();
  const visible = [];
  for (const group of groups.values()) {
    const usable = group.commands.filter((c) => levelRank(c.permission) <= viewerRank);
    if (usable.length > 0) visible.push({ ...group, commands: usable });
  }
  return visible;
}

function buildHomeEmbed(member, prefix) {
  const groups = visibleCategories(member);
  const lines = groups.map(
    ({ category, commands }) =>
      `${category.emoji} **${category.label}** — ${commands.length} command${commands.length === 1 ? '' : 's'}`,
  );

  return new EmbedBuilder()
    .setColor(BRAND.accentColor)
    .setTitle(`📖 ${BRAND.name} Bot Guide`)
    .setDescription(
      `Every command works two ways: as a slash command (\`/help\`) and with the prefix ` +
        `\`${prefix}\` (\`${prefix}help\`).\n\nPick a category below to see its commands.\n\n${lines.join('\n')}`,
    )
    .setFooter({ text: 'Buttons navigate this message • Only commands you can use are shown' });
}

function buildCategoryEmbed(member, prefix, categoryKey) {
  const category = COMMAND_CATEGORIES[categoryKey];
  const group = visibleCategories(member).find((g) => g.category.key === categoryKey);
  const embed = new EmbedBuilder()
    .setColor(BRAND.accentColor)
    .setTitle(`${category.emoji} ${category.label}`)
    .setFooter({ text: `Prefix: ${prefix}  •  Slash: /  •  <required> [optional]` });

  if (!group || group.commands.length === 0) {
    embed.setDescription('No commands you can use in this category.');
    return embed;
  }

  const blocks = [];
  for (const command of group.commands) {
    const aliases = command.aliases.length ? ` (alias: ${command.aliases.map((a) => `\`${prefix}${a}\``).join(', ')})` : '';
    if (command.subcommands) {
      const subs = command.subcommands
        .map((sub) => `  ‣ \`${prefix}${registry.usage(command, sub)}\` — ${sub.description}`)
        .join('\n');
      blocks.push(`**${prefix}${command.name}**${permissionBadge(command)}${aliases}\n${command.description}\n${subs}`);
    } else {
      blocks.push(
        `\`${prefix}${registry.usage(command)}\`${permissionBadge(command)}${aliases}\n${command.description}` +
          (command.examples.length ? `\n  ‣ e.g. \`${prefix}${command.examples[0]}\`` : ''),
      );
    }
  }

  // Keep inside the 4096-character description limit by spilling into fields.
  let description = '';
  const overflow = [];
  for (const block of blocks) {
    if (description.length + block.length + 2 < 3900) description += `${block}\n\n`;
    else overflow.push(block);
  }
  embed.setDescription(description.trim());
  for (const block of overflow.slice(0, 20)) {
    embed.addFields({ name: '​', value: block.slice(0, 1024) });
  }
  return embed;
}

function buildComponents(member, ownerId, activeKey) {
  const groups = visibleCategories(member);
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`${NS}:home:${ownerId}`)
      .setLabel('Overview')
      .setEmoji('📖')
      .setStyle(activeKey === 'home' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(activeKey === 'home'),
    ...groups.map(({ category }) =>
      new ButtonBuilder()
        .setCustomId(`${NS}:${category.key}:${ownerId}`)
        .setLabel(category.label)
        .setEmoji(category.emoji)
        .setStyle(activeKey === category.key ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(activeKey === category.key),
    ),
  ];

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows.slice(0, 5);
}

/** Full payload for a help page. */
function buildHelpPage(member, ownerId, key = 'home') {
  const prefix = settingsRepository.getPrefix(member.guild.id);
  const embed =
    key === 'home' ? buildHomeEmbed(member, prefix) : buildCategoryEmbed(member, prefix, key);
  return { embeds: [embed], components: buildComponents(member, ownerId, key) };
}

async function handleNavigate(interaction, [key, ownerId]) {
  if (ownerId && ownerId !== interaction.user.id) {
    const prefix = settingsRepository.getPrefix(interaction.guildId);
    return failure(interaction, `This help menu belongs to someone else — run \`${prefix}help\` for your own.`);
  }
  if (key !== 'home' && !COMMAND_CATEGORIES[key]) return failure(interaction, 'Unknown help page.');

  if (!(await deferComponentUpdate(interaction))) return undefined;
  await interaction.editReply(buildHelpPage(interaction.member, ownerId, key));
  return undefined;
}

module.exports = {
  buildHelpPage,
  buttonPrefixes: { [NS]: handleNavigate },
};
