'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeGuild, useTempDatabase } = require('./helpers');

useTempDatabase('automod');
const { initDatabase } = require('../src/database/database');
initDatabase();

const automod = require('../src/services/automodService');

test('automod persists raid, image-spam and nuke settings', () => {
  const saved = automod.updateSettings('guild-automod', {
    enabled: true,
    image_spam_enabled: true,
    image_spam_max_messages: 3,
    image_spam_interval_seconds: 8,
    raid_enabled: true,
    raid_max_joins: 7,
    raid_interval_seconds: 25,
    raid_action: 'KICK',
    nuke_enabled: true,
    nuke_max_events: 4,
    nuke_interval_seconds: 12,
  });
  assert.equal(saved.image_spam_max_messages, 3);
  assert.equal(saved.raid_action, 'KICK');
  assert.equal(automod.getSettings('guild-automod').nuke_interval_seconds, 12);
});

test('image spam detects only image attachments inside its configured window', () => {
  const settings = {
    image_spam_enabled: true,
    image_spam_max_messages: 2,
    image_spam_interval_seconds: 10,
  };
  const entries = [
    { at: 1_000, hasImage: true },
    { at: 2_000, hasImage: false },
    { at: 3_000, hasImage: true },
    { at: 4_000, hasImage: true },
  ];
  const violation = automod.checks.imageSpam(entries, settings, 5_000);
  assert.equal(violation.rule, 'SPAM');
  assert.match(violation.detail, /3 image messages/);
  assert.equal(violation.burst.length, 3);
});

test('join raid detection is alert-only by default and writes to mod-log', async () => {
  const guild = makeGuild();
  const modlog = require('./helpers').makeChannel(guild, { name: 'mod-log' });
  const settings = require('../src/database/settings');
  settings.updateSettings(guild.id, { modlog_channel_id: modlog.id });
  automod.updateSettings(guild.id, {
    enabled: true,
    raid_enabled: true,
    raid_max_joins: 2,
    raid_interval_seconds: 30,
    raid_action: 'ALERT',
  });
  const { makeMember } = require('./helpers');
  await automod.handleMemberJoin(makeMember(guild), 1_000);
  await automod.handleMemberJoin(makeMember(guild), 2_000);
  const member = makeMember(guild);
  assert.equal(await automod.handleMemberJoin(member, 3_000), true);
  assert.equal(guild.members.cache.has(member.id), true);
  assert.equal(modlog.sent.length, 1);
});
