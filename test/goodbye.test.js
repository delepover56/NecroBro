'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDatabase, makeGuild, makeMember, makeChannel } = require('./helpers');

useTempDatabase('goodbye');
const { initDatabase } = require('../src/database/database');
initDatabase();

const settingsRepository = require('../src/database/settings');
const goodbyeService = require('../src/services/goodbyeService');

test('goodbye is sent to the configured channel as an embed without pinging the member', async () => {
  const guild = makeGuild();
  const channel = makeChannel(guild, { name: 'goodbye' });
  const member = makeMember(guild, { username: 'leaver' });
  settingsRepository.updateSettings(guild.id, { goodbye_channel_id: channel.id });

  assert.equal(await goodbyeService.sendGoodbye(member), true);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].payload.allowedMentions.parse.length, 0);
  assert.match(channel.sent[0].payload.embeds[0].data.description, /Goodbye/);
});

test('goodbye is skipped when no goodbye channel is configured', async () => {
  const guild = makeGuild();
  assert.equal(await goodbyeService.sendGoodbye(makeMember(guild)), false);
});
