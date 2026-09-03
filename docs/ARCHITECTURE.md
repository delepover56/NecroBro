# NekroBro — Developer Guide

This document is the contract every feature module is built against. Read it before adding a
command, a service or a component handler.

## Layout

```text
src/
  index.js                 client, gateway events → services, scheduler, recovery, shutdown
  deploy-commands.js       registers slash commands derived from the command registry
  config.js                constants: statuses, categories, role types, permission levels, defaults
  core/
    args.js                ONE argument schema → slash options + prefix parser (tokenizer, resolvers)
    commandContext.js      CommandContext: the single API a command uses to read args and reply
    commandRegistry.js     loads src/commands/**, validates, derives slash JSON, help metadata
    dispatcher.js          guild-only → permission → bot perms → cooldown → execute → error reply
  commands/                one command object (or array) per file, any depth of sub-folders
  interactions/            component/modal handlers, routed by custom-ID namespace
  services/                feature logic; the only layer that talks to Discord *and* the database
  database/                repositories over node:sqlite (prepared statements, transactions)
  utils/                   permissions, embeds, respond (component replies), format, duration, logger
```

## Commands (slash + prefix from ONE definition)

```js
module.exports = {
  name: 'mute',                       // slash name and prefix word (lowercase)
  aliases: ['m'],                     // prefix-only aliases, optional
  category: 'moderation',             // key of COMMAND_CATEGORIES in config.js
  description: 'Mute a member with the configured Mute role.',
  permission: 'moderator',            // everyone | moderator | admin | owner
  cooldown: 3,                        // seconds per user, optional
  botPermissions: [PermissionFlagsBits.ManageRoles],   // checked before execute, optional
  args: [
    { name: 'user',     type: 'member',   description: 'Who to mute',      required: true },
    { name: 'duration', type: 'duration', description: 'e.g. 10h, 1d12h',  required: true },
    { name: 'reason',   type: 'text',     description: 'Why',              required: false, max: 500 },
  ],
  examples: ['mute @user 10h spamming'], // prefix-form examples without the prefix
  async execute(ctx) { ... },
};
```

Grouped commands use `subcommands` instead of `args`:

```js
subcommands: [
  { name: 'create', description: '...', args: [...] },
  { name: 'end',    description: '...', aliases: ['stop'], args: [...] },
],
defaultSubcommand: 'status',   // used when the prefix form omits the subcommand
```

Argument types: `member`, `user`, `role`, `channel` (`channelTypes`), `string` (`choices`, `max`),
`text` (greedy, must be last), `integer`/`number` (`min`, `max`), `boolean`, `duration` (ms;
`min`/`max` in ms), `literal` (prefix-only filler word, e.g. `as`). Required args must precede
optional ones (Discord rule). The parser handles quotes (`"Discord Nitro"`), mentions and IDs.

### `ctx` — CommandContext

| Member | Meaning |
| --- | --- |
| `ctx.get('name')` | resolved argument (GuildMember, Role, number, ms, string…) or `null` |
| `ctx.guild`, `ctx.member`, `ctx.user`, `ctx.channel`, `ctx.client` | as expected |
| `ctx.subcommand` | subcommand name or `null` |
| `ctx.isSlash` / `ctx.isPrefix`, `ctx.prefix` | front-end info; `ctx.invocation` for usage hints |
| `await ctx.defer({ ephemeral })` | acknowledge slow work (slash: deferReply, prefix: typing) |
| `await ctx.reply({ content, embeds, components, ephemeral })` | main answer; returns the Message |
| `await ctx.edit(payload)` | edit that answer |
| `ctx.success(text)` / `ctx.info(text)` / `ctx.failure(text)` | coloured notice embeds; failure is ephemeral on slash |

Throw an `Error` with `error.userFacing = true` (or `ArgumentError` / `ModerationError`) to have the
dispatcher show `error.message` to the user; anything else is logged and replaced by a generic
message. Never let SQL or stack traces reach Discord.

## Permissions (`utils/permissions.js`)

`isOwner`, `isAdmin`, `isModerator`, `canModerate`, `canConfigure`, `getPermissionLevel`,
`canUseCommand(member, command)`, `roleState(guild, 'ADMIN')`. Admin = server owner or a holder of a
configured **and existing and assigned** Admin role; otherwise only the owner. Never use
`PermissionFlagsBits.Administrator` / `ManageGuild` as a substitute. `isStaff` (suggestion status
management) = moderator+ or a suggestion staff role.

Hierarchy (`services/roleService.js`): `canActorTarget(actor, target)`, `botCanManageMember(member)`,
`botCanManageRole(guild, role)` — call these before any moderation action.

## Component handlers (`interactions/*.js`)

Export any of `buttons`, `selects`, `modals` (exact custom-ID → handler) and `buttonPrefixes`,
`selectPrefixes`, `modalPrefixes` (`prefix:arg:arg` → `handler(interaction, args)`). Custom IDs
**must** begin with a namespace from `COMPONENT_NAMESPACES` (`help:`, `lb:`, `gw:`, `mod:`,
`sg:`) and stay under 100 characters. Use `utils/respond.js` (`deferEphemeral`, `failure`,
`success`, `deferComponentUpdate`) for replies. Register new modules in `interactions/index.js`
(`loadOptional('./giveaway')` etc. already reference the planned files).

## Services available to features

- `services/moderationService.js` — `createCase`, `warn`, `clearWarnings`, `listWarnings`, `mute`,
  `unmute`, `timeout`, `untimeout`, `kick`, `ban`, `unban`, `buildCaseEmbed`, `ACTIONS`,
  `ModerationError`. Records cases, posts to the mod-log, persists mutes/temp-bans.
- `services/roleService.js` — role resolution/hierarchy, `assignJoinRoles`, `setRoleMapping`.
- `services/channelService.js` — `fetchChannel(guild, id)` (null when gone), `isGone(error)`.
- `services/scheduler.js` — `register(name, async (client) => {})`; ticks every 15 s. `index.js`
  registers `giveawayService.processDueGiveaways` and `economyService.sweepCooldowns` when present.
- `services/prefixService.js` — `validatePrefix`.
- `database/settings.js` — `getSettings`, `ensureSettings`, `updateSettings`, `getPrefix`.
- `database/roles.js`, `database/moderation.js`, `database/config.js` (suggestions).

Hooks `index.js` calls if the module exists: `automodService.handleMessage(message) → boolean`
(true = message was actioned, skip rewards), `economyService.handleChatMessage(message)`,
`giveawayService.processDueGiveaways(client)`, `giveawayService.handleMessageDelete(message)`,
`giveawayService.handleChannelDelete(channel)`, `economyService.sweepCooldowns()`.

## Database rules

- `node:sqlite` via `database/database.js`: `prepare(sql)`, `transaction(fn)` (BEGIN IMMEDIATE,
  nested-safe). Always prepared statements; wrap multi-step writes in `transaction`.
- Schema changes are **forward-only** migrations in `database/migrations.js`. Never drop, recreate or
  truncate. Tables for economy, giveaways, moderation and automod already exist (migration 3).
- Everything per guild is keyed by `guild_id`.

## Logging

`const log = require('../utils/logger').createLogger('scope')` → `log.info/warn/error/debug`. The
logger redacts the token. Log every moderation action, giveaway lifecycle event, role change,
configuration change and failure.
