'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTempDatabase, makeGuild, makeMember, makeChannel } = require('./helpers');

useTempDatabase('welcome');
const { initDatabase } = require('../src/database/database');
initDatabase();

const settingsRepository = require('../src/database/settings');
const welcomeService = require('../src/services/welcomeService');

test('welcome is sent to the configured channel and includes the configured image', async () => {
  const guild = makeGuild();
  const channel = makeChannel(guild, { name: 'welcome' });
  const member = makeMember(guild, { username: 'newcomer' });
  settingsRepository.updateSettings(guild.id, {
    welcome_channel_id: channel.id,
    welcome_image_url: 'https://cdn.example/welcome.gif',
  });

  assert.equal(await welcomeService.sendWelcome(member), true);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].payload.content, `${member}`);
  assert.equal(channel.sent[0].payload.embeds[0].data.image.url, 'https://cdn.example/welcome.gif');
});

test('welcome is skipped only when no welcome channel is configured', async () => {
  const guild = makeGuild();
  const member = makeMember(guild, { username: 'newcomer' });
  assert.equal(await welcomeService.sendWelcome(member), false);
});
