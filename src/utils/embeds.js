'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const { BRAND, CATEGORIES, IDS, LIMITS, STATUSES, getCategory, getStatus } = require('../config');

/** Every embed and component the suggestion system renders. */

/** `1` -> `#001` */
function formatNumber(number) {
  return `#${String(number).padStart(3, '0')}`;
}

/** Discord relative/absolute timestamp markup from epoch milliseconds. */
function timestamp(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/* ------------------------------------------------------------------ *
 * Permanent panel (#suggestions)
 * ------------------------------------------------------------------ */

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(BRAND.accentColor)
    .setTitle(BRAND.panelTitle)
    .setDescription(BRAND.panelDescription)
    .addFields(
      {
        name: 'How it works',
        value: [
          '**1.** Press the button below.',
          '**2.** A private channel opens just for you.',
          '**3.** Fill in the short form.',
          '**4.** Your suggestion is posted for the community to vote on.',
        ].join('\n'),
      },
      {
        name: 'Before you post',
        value: [
          '• Search the voting channel first — duplicates get closed.',
          '• One idea per suggestion, please.',
          '• Be specific: *what* should change and *why*.',
        ].join('\n'),
      },
    )
    .setFooter({ text: `${BRAND.name} • Suggestions` });
}

function buildPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.PANEL_CREATE)
        .setLabel('Create Suggestion')
        .setEmoji('💡')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * Temporary submission channel
 * ------------------------------------------------------------------ */

function buildTempChannelEmbed(user) {
  return new EmbedBuilder()
    .setColor(BRAND.accentColor)
    .setTitle('📝 Your Suggestion Draft')
    .setDescription(
      `Hey <@${user.id}>, this private channel is just for you and the staff team.\n\n` +
        'Press **📝 Submit Suggestion** to open the form. Nothing is posted publicly ' +
        'until you submit, and this channel is deleted automatically afterwards.',
    )
    .addFields(
      {
        name: 'What the form asks for',
        value: [
          `• **Title** — ${LIMITS.titleMin}-${LIMITS.titleMax} characters, short and descriptive.`,
          '• **Category** — pick the closest match.',
          `• **Description** — ${LIMITS.descriptionMin}-${LIMITS.descriptionMax} characters explaining the idea.`,
        ].join('\n'),
      },
      {
        name: 'Changed your mind?',
        value: 'Press **❌ Cancel** and this channel disappears. Nothing is saved.',
      },
    )
    .setFooter({ text: `${BRAND.name} • Suggestion draft` });
}

function buildTempChannelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.TEMP_SUBMIT)
        .setLabel('Submit Suggestion')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(IDS.TEMP_CANCEL)
        .setLabel('Cancel')
        .setEmoji('❌')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * Published suggestion
 * ------------------------------------------------------------------ */

/** Thin horizontal rule used to separate blocks inside an embed description. */
const DIVIDER = '─────────────────────────────';

/**
 * Renders a suggestion embed straight from its database row plus vote counts,
 * so the message can always be rebuilt after a restart.
 *
 * Everything lives in the description rather than in embed fields: fields wrap
 * into columns and force the vote totals into a block of their own, whereas a
 * single description keeps the header compact and leaves the right-hand side
 * free for the author's avatar.
 */
function buildSuggestionEmbed(suggestion, counts) {
  const status = getStatus(suggestion.status);
  const category = getCategory(suggestion.category);
  const header = [
    `Category: **${category.emoji} ${category.label}**`,
    `Status: **${status.emoji} ${status.label}**`,
    // Rows created before the identity snapshot existed fall back to a mention.
    suggestion.author_username
      ? `Username: \`${suggestion.author_username}\``
      : `Author: <@${suggestion.author_id}>`,
    `User ID: \`${suggestion.author_id}\``,
  ].join('\n');

  const body = ['**Description**', '', suggestion.description];

  if (suggestion.staff_response) {
    const responder = suggestion.staff_responder_id
      ? ` — <@${suggestion.staff_responder_id}>`
      : '';
    body.push(
      '',
      DIVIDER,
      '',
      `**${status.emoji} Staff Response**`,
      '',
      `${suggestion.staff_response}${responder}`,
    );
  }

  const subtext =
    `-# Submitted: ${timestamp(suggestion.created_at, 'F')} | ` +
    `Upvote: ${counts.up} · Downvote: ${counts.down}`;

  const embed = new EmbedBuilder()
    .setColor(status.color)
    .setTitle(`${formatNumber(suggestion.suggestion_number)} • ${suggestion.title}`)
    .setDescription(
      [header, '', DIVIDER, '', ...body, '', DIVIDER, subtext].join('\n').slice(0, 4096),
    );

  // The author's avatar, snapshotted at submission time, sits on the right.
  if (suggestion.author_avatar_url) embed.setThumbnail(suggestion.author_avatar_url);

  return embed;
}

/** Vote + staff control row for a published suggestion. */
function buildSuggestionComponents(suggestion, counts) {
  const locked = suggestion.status === STATUSES.DUPLICATE.key;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.VOTE}:UP:${suggestion.id}`)
        .setLabel(String(counts.up))
        .setEmoji('👍')
        .setStyle(ButtonStyle.Success)
        .setDisabled(locked),
      new ButtonBuilder()
        .setCustomId(`${IDS.VOTE}:DOWN:${suggestion.id}`)
        .setLabel(String(counts.down))
        .setEmoji('👎')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(locked),
      new ButtonBuilder()
        .setCustomId(`${IDS.STAFF_MANAGE}:${suggestion.id}`)
        .setLabel('Staff Controls')
        .setEmoji('🛠️')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** The ephemeral status picker shown to staff. */
function buildStaffStatusComponents(suggestion) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${IDS.STAFF_SELECT}:${suggestion.id}`)
    .setPlaceholder('Choose a new status…')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      Object.values(STATUSES).map((status) =>
        new StringSelectMenuOptionBuilder()
          .setValue(status.key)
          .setLabel(status.staffAction)
          .setDescription(`Set status to ${status.label}.`)
          .setEmoji(status.emoji)
          .setDefault(status.key === suggestion.status),
      ),
    );

  return [new ActionRowBuilder().addComponents(menu)];
}

/* ------------------------------------------------------------------ *
 * Staff log + notices
 * ------------------------------------------------------------------ */

function buildLogEmbed({ title, description, color = BRAND.neutralColor, fields = [] }) {
  const embed = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp(new Date());
  if (description) embed.setDescription(description);
  if (fields.length > 0) embed.addFields(fields);
  return embed;
}

/** Simple coloured notice used for ephemeral confirmations and errors. */
function buildNoticeEmbed(kind, message) {
  const color =
    kind === 'success'
      ? BRAND.successColor
      : kind === 'error'
        ? BRAND.dangerColor
        : BRAND.accentColor;
  const prefix = kind === 'success' ? '✅' : kind === 'error' ? '⚠️' : 'ℹ️';
  return new EmbedBuilder().setColor(color).setDescription(`${prefix} ${message}`);
}

module.exports = {
  formatNumber,
  timestamp,
  buildPanelEmbed,
  buildPanelComponents,
  buildTempChannelEmbed,
  buildTempChannelComponents,
  buildSuggestionEmbed,
  buildSuggestionComponents,
  buildStaffStatusComponents,
  buildLogEmbed,
  buildNoticeEmbed,
  CATEGORY_CHOICES: CATEGORIES,
};
