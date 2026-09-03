'use strict';

/**
 * Test helpers: a throw-away SQLite database per test file and minimal fakes
 * for the discord.js objects the services touch (guild, member, role, channel).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionsBitField } = require('discord.js');

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

/** Points the app at a fresh temp database. Call BEFORE requiring src modules. */
function useTempDatabase(name = 'test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nekrobro-${name}-`));
  const file = path.join(dir, 'test.db');
  process.env.DATABASE_PATH = file;
  return file;
}

/** Copies a database file to a temp location so tests never touch the real one. */
function copyDatabase(source, name = 'copy') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nekrobro-${name}-`));
  const file = path.join(dir, 'copy.db');
  fs.copyFileSync(source, file);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, file + suffix);
  }
  process.env.DATABASE_PATH = file;
  return file;
}

let idCounter = 100000000000000000n;
function snowflake() {
  idCounter += 1n;
  return idCounter.toString();
}

function makeRole(guild, { id = snowflake(), name = 'role', position = 1, managed = false } = {}) {
  const role = {
    id,
    name,
    position,
    managed,
    guild,
    members: new Collection(),
    comparePositionTo(other) {
      return this.position - other.position;
    },
    toString() {
      return `<@&${id}>`;
    },
  };
  guild.roles.cache.set(id, role);
  return role;
}

function makeMember(guild, { id = snowflake(), username = `user${id.slice(-4)}`, roles = [], bot = false } = {}) {
  const roleCache = new Collection();
  const member = {
    id,
    guild,
    client: guild.client,
    user: { id, username, tag: `${username}#0`, bot, displayAvatarURL: () => 'https://cdn.example/avatar.png' },
    displayName: username,
    roles: {
      cache: roleCache,
      get highest() {
        let best = guild.roles.everyone;
        for (const role of roleCache.values()) if (role.position > best.position) best = role;
        return best;
      },
      async add(role) {
        roleCache.set(role.id, role);
        role.members.set(id, member);
      },
      async remove(role) {
        roleCache.delete(role.id);
        role.members.delete(id);
      },
    },
    permissions: new PermissionsBitField(0n),
    communicationDisabledUntilTimestamp: null,
    moderatable: true,
    kickable: true,
    bannable: true,
    async timeout(ms) {
      this.communicationDisabledUntilTimestamp = ms ? Date.now() + ms : null;
    },
    async kick() {
      guild.members.cache.delete(id);
    },
    toString() {
      return `<@${id}>`;
    },
  };
  for (const role of roles) {
    roleCache.set(role.id, role);
    role.members.set(id, member);
  }
  guild.members.cache.set(id, member);
  return member;
}

function makeChannel(guild, { id = snowflake(), name = 'general', type = 0 } = {}) {
  const sent = [];
  const channel = {
    id,
    name,
    type,
    guild,
    sent,
    isTextBased: () => true,
    async send(payload) {
      const message = { id: snowflake(), payload, channel, async edit(next) { this.payload = next; return this; }, async delete() {} };
      sent.push(message);
      return message;
    },
    messages: {
      async fetch(messageId) {
        const found = sent.find((m) => m.id === messageId);
        if (!found) {
          const error = new Error('Unknown Message');
          error.code = 10008;
          throw error;
        }
        return found;
      },
    },
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    toString() {
      return `<#${id}>`;
    },
  };
  guild.channels.cache.set(id, channel);
  return channel;
}

/** A fake guild with an owner, a bot member and an @everyone role. */
function makeGuild({ id = snowflake(), name = 'Test Guild' } = {}) {
  const client = { user: { id: snowflake(), tag: 'Bot#0000', username: 'Bot' }, users: { fetch: async () => null } };
  const guild = {
    id,
    name,
    client,
    ownerId: null,
    roles: { cache: new Collection() },
    members: {
      cache: new Collection(),
      me: null,
      async fetch(arg) {
        if (typeof arg === 'string') {
          const member = guild.members.cache.get(arg);
          if (!member) {
            const error = new Error('Unknown Member');
            error.code = 10007;
            throw error;
          }
          return member;
        }
        return guild.members.cache;
      },
      bans: new Collection(),
      async ban(userId) {
        this.bans.set(userId, true);
      },
      async unban(userId) {
        if (!this.bans.has(userId)) {
          const error = new Error('Unknown Ban');
          error.code = 10026;
          throw error;
        }
        this.bans.delete(userId);
      },
    },
    channels: {
      cache: new Collection(),
      async fetch(channelId) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
          const error = new Error('Unknown Channel');
          error.code = 10003;
          throw error;
        }
        return channel;
      },
    },
    iconURL: () => null,
    memberCount: 1,
  };
  guild.roles.everyone = makeRole(guild, { id, name: '@everyone', position: 0 });

  const botRole = makeRole(guild, { name: 'NekroBro', position: 50 });
  guild.members.me = makeMember(guild, { id: client.user.id, username: 'Bot', roles: [botRole], bot: true });
  guild.members.me.permissions = new PermissionsBitField(PermissionsBitField.All);

  const owner = makeMember(guild, { username: 'owner' });
  guild.ownerId = owner.id;
  guild.owner = owner;
  return guild;
}

module.exports = { useTempDatabase, copyDatabase, makeGuild, makeRole, makeMember, makeChannel, snowflake };
