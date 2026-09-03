'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempDatabase } = require('./helpers');

useTempDatabase('giveaway');
const { initDatabase } = require('../src/database/database');
initDatabase();

const giveawayService = require('../src/services/giveawayService');

test('giveaway winner DMs are best effort and identify the prize', async () => {
  const delivered = [];
  const client = {
    guilds: { cache: new Map([['guild-1', { name: 'Nekro Land' }]]) },
    users: {
      cache: new Map(),
      async fetch(id) {
        if (id === 'closed-dms') throw new Error('Cannot send messages to this user');
        return {
          id,
          async send(payload) {
            delivered.push({ id, payload });
          },
        };
      },
    },
  };
  const row = { id: 42, guild_id: 'guild-1', type: 'DISCORD', prize: 'Nitro' };

  const result = await giveawayService.notifyWinners(client, row, ['winner', 'closed-dms']);

  assert.deepEqual(result, { delivered: 1, failed: 1 });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].payload.embeds[0].data.title, /won a giveaway/i);
  assert.match(delivered[0].payload.embeds[0].data.description, /Nitro/);
});

test('a reroll notifies the prior winner only when they are displaced', async () => {
  const sent = [];
  const client = {
    guilds: { cache: new Map([['guild-1', { name: 'Nekro Land' }]]) },
    users: { cache: new Map(), async fetch(id) { return { id, async send(payload) { sent.push({ id, payload }); } }; } },
  };
  const row = { id: 42, guild_id: 'guild-1', type: 'DISCORD', prize: 'Nitro' };

  const result = await giveawayService.notifyRerolledOut(client, row, ['old-winner', 'still-winner'], ['still-winner', 'new-winner']);

  assert.deepEqual(result, { delivered: 1, failed: 0 });
  assert.deepEqual(sent.map((entry) => entry.id), ['old-winner']);
  assert.match(sent[0].payload.embeds[0].data.title, /rerolled/i);
});
