'use strict';

const { ChannelType, EmbedBuilder } = require('discord.js');

const { BRAND } = require('../../config');
const automodService = require('../../services/automodService');
const { createLogger } = require('../../utils/logger');

const log = createLogger('automod');

/**
 * `/automod` -- configure the automatic moderation rules for this server.
 * Admin-only. Every subcommand writes to `automod_settings` and answers with a
 * compact confirmation embed; `status` shows the whole configuration.
 */

const LIMITS = {
  maxWords: 200,
  wordLength: 60,
  maxDomains: 100,
  maxIgnored: 50,
};

const TEXT_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildCategory,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.GuildStageVoice,
];

const ON_OFF = [
  { name: 'on', value: 'on' },
  { name: 'off', value: 'off' },
];

function onOff(flag) {
  return flag ? '🟢 on' : '🔴 off';
}

function confirm(ctx, title, lines, { color = BRAND.successColor } = {}) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(Array.isArray(lines) ? lines.join('\n') : String(lines));
  return ctx.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

function audit(ctx, detail) {
  log.info(`[${ctx.guild.id}] automod ${ctx.subcommand} by ${ctx.user.tag} (${ctx.user.id}): ${detail}`);
}

function userError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

function normalizeWord(input) {
  return String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

function buildStatusEmbed(guild, s) {
  const domains = s.allowed_domains.length ? s.allowed_domains.map((d) => `\`${d}\``).join(', ') : '_none_';
  const liveChannels = s.ignored_channels.filter((id) => guild.channels.cache.has(id));
  const liveRoles = s.ignored_roles.filter((id) => guild.roles.cache.has(id));

  return new EmbedBuilder()
    .setColor(s.enabled ? BRAND.successColor : BRAND.dangerColor)
    .setTitle(`🤖 Automod — ${s.enabled ? 'Enabled' : 'Disabled'}`)
    .setDescription(
      s.enabled
        ? 'Messages from Moderators, Admins, ignored roles and ignored channels are never checked.'
        : 'No rules are enforced until an Admin runs `automod enable`.',
    )
    .addFields(
      {
        name: 'Rules',
        value: [
          `🤬 **Bad words:** ${onOff(s.bad_words_enabled)} — ${s.bad_words.length}/${LIMITS.maxWords} word(s)`,
          `🔗 **Links:** ${onOff(s.links_enabled)} — ${s.allowed_domains.length} allowed domain(s)`,
          `🌊 **Spam:** ${onOff(s.spam_enabled)} — more than ${s.spam_max_messages} msgs in ${s.spam_interval_seconds}s`,
          `🔁 **Repeats:** ${onOff(s.repeat_enabled)} — same message ${s.repeat_threshold}× in a row`,
          `🔠 **Caps:** ${onOff(s.caps_enabled)} — ≥ ${s.caps_percent}% uppercase, ${s.caps_min_length}+ letters`,
          `📣 **Mentions:** ${onOff(s.mentions_enabled)} — more than ${s.mentions_max} unique mention(s)`,
        ].join('\n'),
      },
      {
        name: 'Escalation',
        value:
          `Violations are counted per member over **${s.violation_window_minutes} min**.\n` +
          `**1 – ${Math.max(1, s.warn_threshold - 1)}:** delete + notice\n` +
          `**${s.warn_threshold}+:** delete + warning (mod-log case)\n` +
          `**${s.timeout_threshold}+:** delete + warning + **${s.timeout_minutes} min** timeout`,
      },
      {
        name: 'Server protection',
        value: [
          `**Image spam:** ${onOff(s.image_spam_enabled)} — > ${s.image_spam_max_messages} images / ${s.image_spam_interval_seconds}s`,
          `**Join raids:** ${onOff(s.raid_enabled)} — > ${s.raid_max_joins} joins / ${s.raid_interval_seconds}s (${s.raid_action.toLowerCase()})`,
          `**Nuke detection:** ${onOff(s.nuke_enabled)} — > ${s.nuke_max_events} channel/role events / ${s.nuke_interval_seconds}s`,
        ].join('\n'),
      },
      {
        name: 'Allowed domains',
        value: domains.slice(0, 1024),
        inline: false,
      },
      {
        name: 'Ignored',
        value:
          `**Channels (${liveChannels.length}):** ${liveChannels.length ? liveChannels.map((id) => `<#${id}>`).join(' ') : '_none_'}\n` +
          `**Roles (${liveRoles.length}):** ${liveRoles.length ? liveRoles.map((id) => `<@&${id}>`).join(' ') : '_none_'}`,
      },
    )
    .setFooter({ text: `${BRAND.name} • Automod` });
}

/* ------------------------------------------------------------------ *
 * Subcommand handlers
 * ------------------------------------------------------------------ */

async function handleStatus(ctx) {
  const settings = automodService.ensureSettings(ctx.guild.id);
  return ctx.reply({ embeds: [buildStatusEmbed(ctx.guild, settings)], allowedMentions: { parse: [] } });
}

async function handleToggle(ctx, enabled) {
  const before = automodService.ensureSettings(ctx.guild.id);
  automodService.updateSettings(ctx.guild.id, { enabled });
  audit(ctx, `enabled=${enabled}`);
  if (before.enabled === enabled) {
    return confirm(ctx, `🤖 Automod is already ${enabled ? 'enabled' : 'disabled'}`, 'Nothing changed.', {
      color: BRAND.accentColor,
    });
  }
  return confirm(
    ctx,
    `🤖 Automod ${enabled ? 'enabled' : 'disabled'}`,
    enabled
      ? [
          'Messages are now checked against the configured rules.',
          `Run \`${ctx.prefix}automod status\` to review them.`,
        ]
      : ['No messages will be removed until it is enabled again.'],
  );
}

async function handleWords(ctx) {
  const action = ctx.get('action');
  const settings = automodService.ensureSettings(ctx.guild.id);
  const word = normalizeWord(ctx.get('word'));

  switch (action) {
    case 'list': {
      if (settings.bad_words.length === 0) {
        return confirm(ctx, '🤬 Prohibited words', 'The list is empty. Add one with `automod words add <word>`.', {
          color: BRAND.accentColor,
        });
      }
      const listing = settings.bad_words.map((w) => `||${w}||`).join(', ');
      return ctx.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(BRAND.accentColor)
            .setTitle(`🤬 Prohibited words (${settings.bad_words.length}/${LIMITS.maxWords})`)
            .setDescription(listing.slice(0, 4000))
            .setFooter({ text: 'Matching is case-insensitive, whole-word, and ignores light leetspeak' }),
        ],
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
    }
    case 'clear': {
      const removed = settings.bad_words.length;
      automodService.updateSettings(ctx.guild.id, { bad_words: [] });
      audit(ctx, `cleared ${removed} word(s)`);
      return confirm(ctx, '🤬 Word list cleared', `Removed **${removed}** word(s).`);
    }
    case 'add': {
      if (!word) throw userError('Tell me which word or phrase to add: `automod words add <word>`.');
      if (word.length > LIMITS.wordLength) throw userError(`Words are limited to ${LIMITS.wordLength} characters.`);
      if (!/[\p{L}\p{N}]/u.test(word)) throw userError('A word needs at least one letter or digit.');
      if (settings.bad_words.includes(word)) {
        return confirm(ctx, '🤬 Already listed', `||${word}|| is already on the list.`, { color: BRAND.accentColor });
      }
      if (settings.bad_words.length >= LIMITS.maxWords) {
        throw userError(`The list is full (${LIMITS.maxWords} words). Remove some first.`);
      }
      const updated = automodService.updateSettings(ctx.guild.id, { bad_words: [...settings.bad_words, word] });
      audit(ctx, `added word "${word}" (${updated.bad_words.length} total)`);
      return confirm(ctx, '🤬 Word added', [
        `||${word}|| is now prohibited (**${updated.bad_words.length}**/${LIMITS.maxWords}).`,
        settings.bad_words_enabled ? '' : '⚠️ The bad-words rule is currently **off**.',
      ].filter(Boolean));
    }
    case 'remove': {
      if (!word) throw userError('Tell me which word to remove: `automod words remove <word>`.');
      if (!settings.bad_words.includes(word)) {
        return ctx.failure(`||${word}|| is not on the list.`);
      }
      const updated = automodService.updateSettings(ctx.guild.id, {
        bad_words: settings.bad_words.filter((w) => w !== word),
      });
      audit(ctx, `removed word "${word}" (${updated.bad_words.length} total)`);
      return confirm(ctx, '🤬 Word removed', `||${word}|| is no longer prohibited (**${updated.bad_words.length}** left).`);
    }
    default:
      throw userError('Unknown action. Use `add`, `remove`, `list` or `clear`.');
  }
}

async function handleLinks(ctx) {
  const state = ctx.get('state');
  const settings = automodService.ensureSettings(ctx.guild.id);

  if (state === 'on' || state === 'off') {
    const enabled = state === 'on';
    automodService.updateSettings(ctx.guild.id, { links_enabled: enabled });
    audit(ctx, `links_enabled=${enabled}`);
    return confirm(ctx, `🔗 Link filter ${enabled ? 'on' : 'off'}`, [
      enabled
        ? 'Links and Discord invites are removed unless their domain is allowed.'
        : 'Links are no longer filtered.',
      `Allowed domains: ${settings.allowed_domains.length ? settings.allowed_domains.map((d) => `\`${d}\``).join(', ') : '_none_'}`,
    ]);
  }

  const domain = automodService.normalizeDomain(ctx.get('domain'));
  if (!domain) {
    throw userError(
      state === 'allow'
        ? 'Give me a domain to allow, e.g. `automod links allow youtube.com`.'
        : 'Give me a domain to remove, e.g. `automod links unallow youtube.com`.',
    );
  }

  if (state === 'allow') {
    if (settings.allowed_domains.includes(domain)) {
      return confirm(ctx, '🔗 Already allowed', `\`${domain}\` is already on the allow-list.`, { color: BRAND.accentColor });
    }
    if (settings.allowed_domains.length >= LIMITS.maxDomains) {
      throw userError(`The allow-list is full (${LIMITS.maxDomains} domains).`);
    }
    const updated = automodService.updateSettings(ctx.guild.id, {
      allowed_domains: [...settings.allowed_domains, domain],
    });
    audit(ctx, `allowed domain ${domain} (${updated.allowed_domains.length} total)`);
    return confirm(ctx, '🔗 Domain allowed', [
      `Links to \`${domain}\` (and its subdomains) are permitted.`,
      settings.links_enabled ? '' : '⚠️ The link filter is currently **off**.',
    ].filter(Boolean));
  }

  if (!settings.allowed_domains.includes(domain)) return ctx.failure(`\`${domain}\` is not on the allow-list.`);
  const updated = automodService.updateSettings(ctx.guild.id, {
    allowed_domains: settings.allowed_domains.filter((d) => d !== domain),
  });
  audit(ctx, `unallowed domain ${domain} (${updated.allowed_domains.length} total)`);
  return confirm(ctx, '🔗 Domain removed', `Links to \`${domain}\` will be filtered again.`);
}

async function handleSpam(ctx) {
  const enabled = ctx.get('state') === 'on';
  const patch = { spam_enabled: enabled };
  if (ctx.get('messages') !== null) patch.spam_max_messages = ctx.get('messages');
  if (ctx.get('seconds') !== null) patch.spam_interval_seconds = ctx.get('seconds');
  const s = automodService.updateSettings(ctx.guild.id, patch);
  audit(ctx, `spam_enabled=${enabled} max=${s.spam_max_messages} interval=${s.spam_interval_seconds}s`);
  return confirm(ctx, `🌊 Spam filter ${enabled ? 'on' : 'off'}`, [
    `Trigger: more than **${s.spam_max_messages}** messages within **${s.spam_interval_seconds}s**.`,
    '🔁 Repeated-message detection follows the same switch.',
  ]);
}

async function handleCaps(ctx) {
  const enabled = ctx.get('state') === 'on';
  const patch = { caps_enabled: enabled };
  if (ctx.get('percent') !== null) patch.caps_percent = ctx.get('percent');
  if (ctx.get('minlength') !== null) patch.caps_min_length = ctx.get('minlength');
  const s = automodService.updateSettings(ctx.guild.id, patch);
  audit(ctx, `caps_enabled=${enabled} percent=${s.caps_percent} min_length=${s.caps_min_length}`);
  return confirm(ctx, `🔠 Caps filter ${enabled ? 'on' : 'off'}`, [
    `Trigger: **${s.caps_percent}%** or more uppercase in messages with **${s.caps_min_length}+** letters.`,
    'Links, emoji and mentions are ignored when measuring.',
  ]);
}

async function handleMentions(ctx) {
  const enabled = ctx.get('state') === 'on';
  const patch = { mentions_enabled: enabled };
  if (ctx.get('max') !== null) patch.mentions_max = ctx.get('max');
  const s = automodService.updateSettings(ctx.guild.id, patch);
  audit(ctx, `mentions_enabled=${enabled} max=${s.mentions_max}`);
  return confirm(ctx, `📣 Mention filter ${enabled ? 'on' : 'off'}`, [
    `Trigger: more than **${s.mentions_max}** unique user/role mentions in one message.`,
  ]);
}

async function handleImageSpam(ctx) {
  const enabled = ctx.get('state') === 'on';
  const patch = { image_spam_enabled: enabled };
  if (ctx.get('images') !== null) patch.image_spam_max_messages = ctx.get('images');
  if (ctx.get('seconds') !== null) patch.image_spam_interval_seconds = ctx.get('seconds');
  const s = automodService.updateSettings(ctx.guild.id, patch);
  audit(ctx, `image_spam_enabled=${enabled} max=${s.image_spam_max_messages} interval=${s.image_spam_interval_seconds}s`);
  return confirm(ctx, `Image-spam filter ${enabled ? 'on' : 'off'}`, `Trigger: more than **${s.image_spam_max_messages}** image messages within **${s.image_spam_interval_seconds}s**.`);
}

async function handleRaid(ctx) {
  const enabled = ctx.get('state') === 'on';
  const action = ctx.get('action')?.toUpperCase();
  const patch = { raid_enabled: enabled };
  if (ctx.get('joins') !== null) patch.raid_max_joins = ctx.get('joins');
  if (ctx.get('seconds') !== null) patch.raid_interval_seconds = ctx.get('seconds');
  if (action) patch.raid_action = action;
  const s = automodService.updateSettings(ctx.guild.id, patch);
  audit(ctx, `raid_enabled=${enabled} max=${s.raid_max_joins} interval=${s.raid_interval_seconds}s action=${s.raid_action}`);
  return confirm(ctx, `Raid protection ${enabled ? 'on' : 'off'}`, [
    `Trigger: more than **${s.raid_max_joins}** joins within **${s.raid_interval_seconds}s**.`,
    `Response: **${s.raid_action.toLowerCase()}**${s.raid_action === 'KICK' ? ' the latest joining member.' : ' staff in the mod-log channel.'}`,
  ]);
}

async function handleNuke(ctx) {
  const enabled = ctx.get('state') === 'on';
  const patch = { nuke_enabled: enabled };
  if (ctx.get('events') !== null) patch.nuke_max_events = ctx.get('events');
  if (ctx.get('seconds') !== null) patch.nuke_interval_seconds = ctx.get('seconds');
  const s = automodService.updateSettings(ctx.guild.id, patch);
  audit(ctx, `nuke_enabled=${enabled} max=${s.nuke_max_events} interval=${s.nuke_interval_seconds}s`);
  return confirm(ctx, `Nuke detection ${enabled ? 'on' : 'off'}`, [
    `Alert after more than **${s.nuke_max_events}** channel/role changes in **${s.nuke_interval_seconds}s**.`,
    'A bot cannot stop members with equal or higher permissions; check the Discord Audit Log immediately.',
  ]);
}

async function handleIgnoreChannel(ctx) {
  const action = ctx.get('action');
  const channel = ctx.get('channel');
  const settings = automodService.ensureSettings(ctx.guild.id);
  const listed = settings.ignored_channels.includes(channel.id);

  if (action === 'add') {
    if (listed) return confirm(ctx, '🔕 Already ignored', `${channel} is already ignored.`, { color: BRAND.accentColor });
    if (settings.ignored_channels.length >= LIMITS.maxIgnored) {
      throw userError(`You can ignore at most ${LIMITS.maxIgnored} channels.`);
    }
    automodService.updateSettings(ctx.guild.id, { ignored_channels: [...settings.ignored_channels, channel.id] });
    audit(ctx, `ignore channel ${channel.id} (#${channel.name})`);
    return confirm(ctx, '🔕 Channel ignored', [
      `Automod will skip messages in ${channel}.`,
      channel.type === ChannelType.GuildCategory ? 'Every channel inside this category is covered.' : '',
    ].filter(Boolean));
  }

  if (!listed) return ctx.failure(`${channel} is not on the ignore list.`);
  automodService.updateSettings(ctx.guild.id, {
    ignored_channels: settings.ignored_channels.filter((id) => id !== channel.id),
  });
  audit(ctx, `unignore channel ${channel.id} (#${channel.name})`);
  return confirm(ctx, '🔔 Channel watched again', `Automod checks ${channel} again.`);
}

async function handleIgnoreRole(ctx) {
  const action = ctx.get('action');
  const role = ctx.get('role');
  const settings = automodService.ensureSettings(ctx.guild.id);
  const listed = settings.ignored_roles.includes(role.id);

  if (action === 'add') {
    if (role.id === ctx.guild.roles.everyone.id) throw userError('Ignoring @everyone would switch automod off for everybody — use `automod disable` instead.');
    if (listed) return confirm(ctx, '🔕 Already ignored', `${role} is already ignored.`, { color: BRAND.accentColor });
    if (settings.ignored_roles.length >= LIMITS.maxIgnored) {
      throw userError(`You can ignore at most ${LIMITS.maxIgnored} roles.`);
    }
    automodService.updateSettings(ctx.guild.id, { ignored_roles: [...settings.ignored_roles, role.id] });
    audit(ctx, `ignore role ${role.id} (${role.name})`);
    return confirm(ctx, '🔕 Role ignored', `Members with ${role} are exempt from automod.`);
  }

  if (!listed) return ctx.failure(`${role} is not on the ignore list.`);
  automodService.updateSettings(ctx.guild.id, {
    ignored_roles: settings.ignored_roles.filter((id) => id !== role.id),
  });
  audit(ctx, `unignore role ${role.id} (${role.name})`);
  return confirm(ctx, '🔔 Role watched again', `Members with ${role} are checked again.`);
}

async function handleEscalation(ctx) {
  const warnAfter = ctx.get('warn_after');
  const timeoutAfter = ctx.get('timeout_after');
  const timeoutMinutes = ctx.get('timeout_minutes');
  const windowMinutes = ctx.get('window');

  if (timeoutAfter < warnAfter) {
    throw userError('`timeout_after` must be greater than or equal to `warn_after`.');
  }

  const patch = {
    warn_threshold: warnAfter,
    timeout_threshold: timeoutAfter,
    timeout_minutes: timeoutMinutes,
  };
  if (windowMinutes !== null) patch.violation_window_minutes = windowMinutes;
  const s = automodService.updateSettings(ctx.guild.id, patch);
  audit(
    ctx,
    `warn=${s.warn_threshold} timeout=${s.timeout_threshold} timeout_minutes=${s.timeout_minutes} window=${s.violation_window_minutes}m`,
  );
  return confirm(ctx, '⚖️ Escalation updated', [
    `Violations are counted over **${s.violation_window_minutes} min** per member.`,
    `• **${s.warn_threshold}** violations → warning (mod-log case)`,
    `• **${s.timeout_threshold}** violations → **${s.timeout_minutes} min** timeout`,
    'Every violation always removes the message and posts a short notice.',
  ]);
}

/* ------------------------------------------------------------------ *
 * Command definition
 * ------------------------------------------------------------------ */

module.exports = {
  name: 'automod',
  aliases: ['am'],
  category: 'automod',
  description: 'Configure automatic moderation: bad words, links, spam, caps and mass mentions.',
  permission: 'admin',
  defaultSubcommand: 'status',
  subcommands: [
    { name: 'status', description: 'Show every automod setting.', aliases: ['show', 'settings'], args: [] },
    { name: 'enable', description: 'Turn automod on.', aliases: ['on'], args: [] },
    { name: 'disable', description: 'Turn automod off.', aliases: ['off'], args: [] },
    {
      name: 'words',
      description: 'Manage the prohibited word list.',
      aliases: ['word', 'badwords'],
      args: [
        {
          name: 'action',
          type: 'string',
          description: 'What to do with the list.',
          required: true,
          choices: [
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
            { name: 'list', value: 'list' },
            { name: 'clear', value: 'clear' },
          ],
        },
        { name: 'word', type: 'text', description: 'The word or phrase (for add/remove).', required: false, max: LIMITS.wordLength },
      ],
    },
    {
      name: 'links',
      description: 'Toggle the link filter or manage allowed domains.',
      aliases: ['link', 'invites'],
      args: [
        {
          name: 'state',
          type: 'string',
          description: 'on/off, or allow/unallow a domain.',
          required: true,
          choices: [
            ...ON_OFF,
            { name: 'allow', value: 'allow' },
            { name: 'unallow', value: 'unallow' },
          ],
        },
        { name: 'domain', type: 'string', description: 'Domain to allow/unallow, e.g. youtube.com.', required: false, max: 253 },
      ],
    },
    {
      name: 'spam',
      description: 'Toggle spam detection and set its thresholds.',
      args: [
        { name: 'state', type: 'string', description: 'on or off.', required: true, choices: ON_OFF },
        { name: 'messages', type: 'integer', description: 'Max messages allowed in the interval (2-30).', required: false, min: 2, max: 30 },
        { name: 'seconds', type: 'integer', description: 'Interval length in seconds (2-60).', required: false, min: 2, max: 60 },
      ],
    },
    {
      name: 'caps',
      description: 'Toggle the caps filter and set its thresholds.',
      args: [
        { name: 'state', type: 'string', description: 'on or off.', required: true, choices: ON_OFF },
        { name: 'percent', type: 'integer', description: 'Uppercase percentage that triggers (30-100).', required: false, min: 30, max: 100 },
        { name: 'minlength', type: 'integer', description: 'Minimum letters before the rule applies (4-200).', required: false, min: 4, max: 200 },
      ],
    },
    {
      name: 'mentions',
      description: 'Toggle the mass-mention filter and set its limit.',
      aliases: ['mention'],
      args: [
        { name: 'state', type: 'string', description: 'on or off.', required: true, choices: ON_OFF },
        { name: 'max', type: 'integer', description: 'Unique mentions allowed per message (1-50).', required: false, min: 1, max: 50 },
      ],
    },
    {
      name: 'imagespam',
      description: 'Toggle image/GIF spam detection and set thresholds.',
      aliases: ['image-spam', 'images'],
      args: [
        { name: 'state', type: 'string', description: 'on or off.', required: true, choices: ON_OFF },
        { name: 'images', type: 'integer', description: 'Max image messages allowed (1-30).', required: false, min: 1, max: 30 },
        { name: 'seconds', type: 'integer', description: 'Interval length (2-120 seconds).', required: false, min: 2, max: 120 },
      ],
    },
    {
      name: 'raid',
      description: 'Toggle join-raid detection and set its response.',
      args: [
        { name: 'state', type: 'string', description: 'on or off.', required: true, choices: ON_OFF },
        { name: 'joins', type: 'integer', description: 'Max joins allowed (2-100).', required: false, min: 2, max: 100 },
        { name: 'seconds', type: 'integer', description: 'Interval length (5-300 seconds).', required: false, min: 5, max: 300 },
        { name: 'action', type: 'string', description: 'alert staff or kick latest join.', required: false, choices: [{ name: 'alert', value: 'alert' }, { name: 'kick', value: 'kick' }] },
      ],
    },
    {
      name: 'nuke',
      description: 'Toggle channel/role destruction burst detection.',
      args: [
        { name: 'state', type: 'string', description: 'on or off.', required: true, choices: ON_OFF },
        { name: 'events', type: 'integer', description: 'Max changes allowed (2-100).', required: false, min: 2, max: 100 },
        { name: 'seconds', type: 'integer', description: 'Interval length (5-300 seconds).', required: false, min: 5, max: 300 },
      ],
    },
    {
      name: 'ignorechannel',
      description: 'Add or remove a channel (or category) automod should skip.',
      aliases: ['ignore-channel', 'channel'],
      args: [
        {
          name: 'action',
          type: 'string',
          description: 'add or remove.',
          required: true,
          choices: [
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
          ],
        },
        { name: 'channel', type: 'channel', description: 'The channel or category.', required: true, channelTypes: TEXT_CHANNEL_TYPES },
      ],
    },
    {
      name: 'ignorerole',
      description: 'Add or remove a role whose members automod should skip.',
      aliases: ['ignore-role', 'role'],
      args: [
        {
          name: 'action',
          type: 'string',
          description: 'add or remove.',
          required: true,
          choices: [
            { name: 'add', value: 'add' },
            { name: 'remove', value: 'remove' },
          ],
        },
        { name: 'role', type: 'role', description: 'The role to ignore.', required: true },
      ],
    },
    {
      name: 'escalation',
      description: 'Set when repeat offenders get warned and timed out.',
      aliases: ['thresholds'],
      args: [
        { name: 'warn_after', type: 'integer', description: 'Violations before a warning is issued (1-50).', required: true, min: 1, max: 50 },
        { name: 'timeout_after', type: 'integer', description: 'Violations before a timeout (1-100).', required: true, min: 1, max: 100 },
        { name: 'timeout_minutes', type: 'integer', description: 'Timeout length in minutes (1-40320).', required: true, min: 1, max: 40_320 },
        { name: 'window', type: 'integer', description: 'Minutes violations are remembered for (5-1440).', required: false, min: 5, max: 1_440 },
      ],
    },
  ],
  examples: [
    'automod status',
    'automod enable',
    'automod words add free nitro',
    'automod words list',
    'automod links on',
    'automod links allow youtube.com',
    'automod spam on 5 5',
    'automod caps on 70 12',
    'automod mentions on 5',
    'automod ignorechannel add #bot-spam',
    'automod ignorerole add @Trusted',
    'automod escalation 3 5 10',
  ],
  async execute(ctx) {
    switch (ctx.subcommand) {
      case 'status':
        return handleStatus(ctx);
      case 'enable':
        return handleToggle(ctx, true);
      case 'disable':
        return handleToggle(ctx, false);
      case 'words':
        return handleWords(ctx);
      case 'links':
        return handleLinks(ctx);
      case 'spam':
        return handleSpam(ctx);
      case 'caps':
        return handleCaps(ctx);
      case 'mentions':
        return handleMentions(ctx);
      case 'imagespam':
        return handleImageSpam(ctx);
      case 'raid':
        return handleRaid(ctx);
      case 'nuke':
        return handleNuke(ctx);
      case 'ignorechannel':
        return handleIgnoreChannel(ctx);
      case 'ignorerole':
        return handleIgnoreRole(ctx);
      case 'escalation':
        return handleEscalation(ctx);
      default:
        return handleStatus(ctx);
    }
  },
};
