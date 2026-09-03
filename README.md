# NekroBro — Nekro Land Suggestion System

A production-ready Discord suggestion system for the **Nekro Land** Minecraft survival server.
Members open a private draft channel, fill in a modal, and their idea is published as a clean
embed the community votes on — with all suggestions and votes stored in SQLite so nothing is lost
across restarts.

Built on **discord.js 14.27** and **Node.js 24** (using Node's built-in `node:sqlite`, so there is
no native module to compile).

---

## 1. Project structure

```text
NekroBro/
├── .env                    # secrets (git-ignored)
├── .env.example            # template to copy
├── package.json
├── data/
│   └── nekrobro.db         # SQLite database (git-ignored, auto-created)
└── src/
    ├── index.js            # client, event wiring, restart recovery, shutdown
    ├── deploy-commands.js  # standalone slash-command deployment
    ├── config.js           # env + statuses, categories, limits, custom IDs
    │
    ├── commands/
    │   └── setupSuggestions.js   # /setup-suggestions (idempotent installer)
    │
    ├── interactions/
    │   ├── index.js              # central router (exact + prefix custom IDs)
    │   ├── suggestionPanel.js    # 💡 Create Suggestion, ❌ Cancel
    │   ├── suggestionModal.js    # 📝 Submit Suggestion + modal handling
    │   ├── suggestionVoting.js   # 👍 / 👎 buttons
    │   └── suggestionStaff.js    # 🛠️ Staff Controls → status + response
    │
    ├── database/
    │   ├── database.js     # connection, pragmas, transactions
    │   ├── migrations.js   # versioned, forward-only schema
    │   ├── suggestions.js  # suggestion repository
    │   ├── votes.js        # vote repository (one vote per user, enforced)
    │   └── config.js       # guild config + temp-channel bookkeeping
    │
    ├── services/
    │   ├── suggestionService.js  # validation, publishing, status changes, locking
    │   ├── votingService.js      # vote rules + message sync
    │   └── channelService.js     # setup, permissions, temp channels, staff log
    │
    └── utils/
        ├── permissions.js  # least-privilege checks, staff resolution
        ├── embeds.js       # every embed + component
        ├── respond.js      # safe ephemeral reply helpers
        └── logger.js       # levelled logging with secret redaction
```

### How a suggestion flows

```text
#suggestions panel  ─ 💡 Create Suggestion ─▶  private #suggestion-<user>
                                                       │
                                              📝 Submit Suggestion
                                                       │
                                                    modal  ──▶ validation
                                                       │
                              #suggestion-voting  ◀── embed  +  👍 👎 🛠️
                                                       │
                                            draft channel deleted
```

---

## 2. Setup instructions

**Requirements:** Node.js 24+ (`node -v`), a Discord application with a bot user.

```bash
npm install          # install discord.js + dotenv
cp .env.example .env # then fill in the three values
npm run deploy       # register /setup-suggestions to your GUILD_ID
npm start            # run the bot
```

The database and the `data/` folder are created automatically on first run, and migrations apply
themselves. No manual schema step is needed.

### Discord Developer Portal

1. **Bot → Privileged Gateway Intents** — leave **all three OFF**. This bot needs none of them.
2. **Installation / OAuth2 → URL Generator** — scopes `bot` + `applications.commands`, then the
   permissions listed below.
3. Invite the bot, and in **Server Settings → Roles** drag its role **above** any role you want it
   to grant channel access to (Discord will not let it manage overwrites for higher roles).

---

## 3. Required Discord permissions

Administrator is **not** required and must not be granted.

| Permission | Why it is needed |
| --- | --- |
| View Channels | See the channels it manages |
| Send Messages | Post the panel, drafts and suggestions |
| Embed Links | Render suggestion embeds |
| Read Message History | Fetch and edit the panel / suggestion messages |
| Manage Channels | Create the category, system channels and per-member draft channels |
| Manage Roles | Apply channel permission overwrites (private drafts, read-only channels) |
| Manage Messages *(optional)* | Tidy stray messages in the system channels |

Invite-URL permission integer: **`268732496`** (the six required permissions above).

`/setup-suggestions` checks these up front and tells you exactly which are missing rather than
failing halfway through.

---

## 4. Environment variables

`.env` is git-ignored; `.env.example` is the template.

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | ✅ | Bot token from the Developer Portal. Never commit or paste it anywhere. |
| `CLIENT_ID` | ✅ | Application ID, used for command registration. |
| `GUILD_ID` | ✅ | Your server ID — commands register here instantly during development. |
| `DATABASE_PATH` | — | Custom SQLite file path (default `./data/nekrobro.db`). |
| `LOG_LEVEL` | — | `error` \| `warn` \| `info` \| `debug` (default `info`). |

The logger scrubs the token (and anything matching a Discord token pattern) from every line it
prints, including stack traces.

---

## 5. Deploying slash commands

Commands are **never** registered on start-up — deployment is an explicit, separate step.

```bash
npm run deploy          # register to GUILD_ID — instant, use during development
npm run deploy:global   # register globally — propagation can take up to an hour
npm run deploy:clear    # remove this guild's commands
```

Re-run `npm run deploy` only when a command's name, description or options change.

---

## 6. Running the bot

```bash
npm start     # production
npm run dev   # auto-restart on file changes (node --watch)
npm run lint  # syntax-check every file in src/
```

Expected startup output:

```text
[INFO ] (database) Connected to SQLite at data\nekrobro.db
[INFO ] (bot) Loaded 1 command(s).
[INFO ] (bot) Logged in as NecroBro#1729 (…)
[INFO ] (bot) Suggestion system online.
```

`Ctrl+C` shuts down cleanly and closes the database.

---

## 7. Configuring `/setup-suggestions`

Run it in your server as anyone with **Manage Server**:

```text
/setup-suggestions
    staff_role:          @Moderator        (optional, recommended)
    staff_role_2:        @Admin            (optional)
    staff_role_3:        @Helper           (optional)
    suggestions_channel: #suggestions      (optional — created if omitted)
    voting_channel:      #suggestion-voting(optional — created if omitted)
    staff_log_channel:   #staff-logs       (optional)
```

It will:

1. Create the hidden **SUGGESTION SUBMISSIONS** category (staff + bot only).
2. Create or reconfigure `#suggestions` — read-only for members, panel posted there.
3. Create or reconfigure `#suggestion-voting` — read-only for members, suggestions posted there.
4. Post the permanent panel, **or edit the existing panel in place**.
5. Save every ID to the database.

**It is safe to run repeatedly.** Existing channels are reused and their permissions repaired; the
panel is edited rather than duplicated. Run it again any time you add a staff role, move a channel,
or accidentally delete something.

If no staff role is configured, anyone with **Manage Server** or **Manage Channels** counts as
staff, so a deleted staff role can never lock you out.

### Statuses

| Status | Staff action |
| --- | --- |
| 🟡 Under Review | Return to Under Review *(default on submission)* |
| 🟢 Accepted | Accept |
| 🔵 Implemented | Implement |
| 🔴 Rejected | Reject |
| ⚪ Duplicate | Mark as Duplicate *(also closes voting)* |

Staff press **🛠️ Staff Controls** on any suggestion → pick a status → optionally write a response.
The **original embed is edited in place**; no duplicate message is ever posted, and the change is
mirrored to the staff log channel if one is configured.

### Voting rules

- The SQLite `votes` table is the only source of truth — no reactions are used.
- `UNIQUE (suggestion_id, user_id)` makes a double vote impossible at the schema level.
- Pressing the opposite button switches the vote; pressing the same button again removes it.
- Authors may vote on their own suggestions.
- Each press runs read → write → recount inside one `BEGIN IMMEDIATE` transaction, and a
  per-suggestion async lock serialises the follow-up message edit, so counts cannot be corrupted by
  simultaneous presses.

---

## 8. Manual testing checklist

### Setup

- [ ] `npm run deploy` then `npm start`; `/setup-suggestions` appears in the server.
- [ ] Run `/setup-suggestions` → category, both channels and the panel are created.
- [ ] Run it a **second** time → nothing is duplicated; the summary says `♻️ reused` / `updated in place`.
- [ ] A normal member cannot type in `#suggestions` or `#suggestion-voting`.
- [ ] A normal member cannot see the **SUGGESTION SUBMISSIONS** category.
- [ ] Remove a bot permission (e.g. Manage Channels) → the command reports exactly what is missing.

### Draft channels

- [ ] Press **💡 Create Suggestion** → `suggestion-<username>` appears; only you, staff and the bot see it.
- [ ] Press it again → you are pointed at the existing draft, no second channel is created.
- [ ] Double-click the button quickly → still only one channel.
- [ ] Press **❌ Cancel** → the channel is deleted and you can open a fresh one.
- [ ] Another member (non-staff) cannot see your draft channel.
- [ ] Two members with the same display name both get a working channel (the second is suffixed).

### Modal + validation

- [ ] **📝 Submit Suggestion** opens the modal with Title, Category select and Description.
- [ ] A 2-character title is rejected with an ephemeral message and nothing is posted.
- [ ] A 10-character description is rejected the same way.
- [ ] Submitting again after a rejection works.
- [ ] A valid submission posts `#001` in `#suggestion-voting` and deletes the draft a few seconds later.
- [ ] The next suggestion is `#002` — numbering is sequential and gap-free.

### Voting

- [ ] 👍 → count becomes 1; the embed updates in place.
- [ ] 👍 again → the vote is removed, count returns to 0.
- [ ] 👍 then 👎 → the upvote disappears and the downvote appears (never both).
- [ ] A second member's vote adds to the totals independently.
- [ ] The suggestion's author can vote on their own suggestion.
- [ ] Two people voting at the same instant produce correct totals.

### Staff controls

- [ ] A non-staff member pressing **🛠️ Staff Controls** gets an ephemeral refusal.
- [ ] Staff pick **Accept** → the embed turns green, status shows 🟢 Accepted, no new message is posted.
- [ ] Adding a response shows it in a **Staff Response** field with the responder's mention.
- [ ] **Mark as Duplicate** greys out and disables both vote buttons.
- [ ] **Return to Under Review** restores the yellow 🟡 state and re-enables voting.
- [ ] Each change appears in the staff log channel, if configured.

### Persistence and failure handling

- [ ] Restart the bot (`Ctrl+C`, `npm start`) → voting on an old suggestion still works and counts are intact.
- [ ] Leave a draft channel open, restart the bot → the draft still works (`Recovered N open suggestion draft(s)`).
- [ ] Delete a draft channel manually, restart → the stale record is pruned and you can open a new draft.
- [ ] Delete a published suggestion message → voting replies that totals cannot be refreshed, votes are still stored.
- [ ] Delete `#suggestion-voting` → new submissions ask you to re-run `/setup-suggestions`; the log shows the config being cleared.
- [ ] Delete the panel message → the log warns; `/setup-suggestions` reposts it.
- [ ] Delete a configured staff role → staff with Manage Server still have access.
- [ ] A member who votes then leaves the server → their vote is retained and the embed shows an unresolved mention (totals are never silently rewritten).
- [ ] Grep the console output for the token → it never appears.
