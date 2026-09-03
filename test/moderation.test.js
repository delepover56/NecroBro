'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempDatabase, makeGuild, makeMember, makeRole, makeChannel } = require('./helpers');

useTempDatabase('moderation');
const { initDatabase } = require('../src/database/database');
initDatabase();

const rolesRepository = require('../src/database/roles');
const moderationRepository = require('../src/database/moderation');
const settingsRepository = require('../src/database/settings');
const moderationService = require('../src/services/moderationService');
const roleService = require('../src/services/roleService');
const presenters = require('../src/services/moderationPresenters');

function setup() {
  const guild = makeGuild();
  const muteRole = makeRole(guild, { name: 'Muted', position: 2 });
  rolesRepository.setRole(guild.id, 'MUTE', muteRole.id, 'test');
  const modRole = makeRole(guild, { name: 'Moderator', position: 30 });
  rolesRepository.setRole(guild.id, 'MODERATOR', modRole.id, 'test');
  const moderator = makeMember(guild, { username: 'mod', roles: [modRole] });
  const target = makeMember(guild, { username: 'target' });
  const client = { guilds: { cache: new Map([[guild.id, guild]]) }, user: guild.client.user };
  return { guild, muteRole, moderator, target, client };
}

test('cases get sequential per-guild numbers and an optional mod-log post', async () => {
  const { guild, moderator, target } = setup();
  const modlog = makeChannel(guild, { name: 'mod-log' });
  settingsRepository.updateSettings(guild.id, { modlog_channel_id: modlog.id });

  const first = await moderationService.createCase({ guild, action: 'WARN', target, moderator, reason: 'one' });
  const second = await moderationService.createCase({ guild, action: 'KICK', target, moderator, reason: 'two' });
  assert.equal(first.case_number, 1);
  assert.equal(second.case_number, 2);
  assert.equal(modlog.sent.length, 2);
  assert.equal(moderationRepository.getCaseById(first.id).log_message_id, modlog.sent[0].id);

  const other = makeGuild();
  const third = await moderationService.createCase({ guild: other, action: 'WARN', target, moderator, reason: 'x' });
  assert.equal(third.case_number, 1, 'case numbers are per guild');
});

test('warnings accumulate, list and clear', async () => {
  const { guild, moderator, target } = setup();
  await moderationService.warn({ guild, target, moderator, reason: 'spam' });
  const second = await moderationService.warn({ guild, target, moderator, reason: 'caps' });
  assert.equal(second.count, 2);
  assert.equal(moderationService.listWarnings(guild.id, target.id).length, 2);

  const cleared = await moderationService.clearWarnings({ guild, target, moderator });
  assert.equal(cleared.cleared, 2);
  assert.equal(moderationService.countWarnings(guild.id, target.id), 0);
});

test('mute applies the configured role and persists with its expiry', async () => {
  const { guild, muteRole, moderator, target } = setup();
  const result = await moderationService.mute({ guild, target, moderator, durationMs: 10 * 3_600_000, reason: 'cheating' });
  assert.equal(target.roles.cache.has(muteRole.id), true);
  const record = moderationService.getActiveMute(guild.id, target.id);
  assert.ok(record);
  assert.ok(Math.abs(record.mute_until - (Date.now() + 10 * 3_600_000)) < 2_000);
  assert.equal(record.reason, 'cheating');
  assert.equal(result.case.action, 'MUTE');

  // Muting again replaces the record rather than violating the unique index.
  await moderationService.mute({ guild, target, moderator, durationMs: 60_000, reason: 'again' });
  const rows = moderationRepository.listActiveMutes(guild.id);
  assert.equal(rows.length, 1);

  await moderationService.unmute({ guild, target, moderator, reason: 'done' });
  assert.equal(target.roles.cache.has(muteRole.id), false);
  assert.equal(moderationService.getActiveMute(guild.id, target.id), null);
  await assert.rejects(() => moderationService.unmute({ guild, target, moderator }), /not muted/);
});

test('moderation action embeds show the global expiry date for long mutes', () => {
  const { guild, moderator, target } = setup();
  const until = Date.UTC(2027, 0, 2, 3, 4, 5);
  const embed = presenters.buildActionEmbed({ action: 'MUTE', target, moderator, until });
  const expires = embed.data.fields.find((field) => field.name === 'Expires');
  assert.equal(expires.value, 'Saturday, 2 January 2027');
});

test('mute evasion: rejoin restores the role and keeps the ORIGINAL expiry', async () => {
  const { guild, muteRole, moderator, target } = setup();
  await moderationService.mute({ guild, target, moderator, durationMs: 10 * 3_600_000, reason: 'cheating' });
  const original = moderationService.getActiveMute(guild.id, target.id).mute_until;

  // Simulate leaving: the role is gone, the record stays.
  target.roles.cache.delete(muteRole.id);
  guild.members.cache.delete(target.id);

  // Rejoin as a fresh member object.
  const rejoined = makeMember(guild, { id: target.id, username: 'target' });
  const outcome = await moderationService.restoreMuteOnJoin(rejoined);
  assert.equal(outcome.restored, true);
  assert.equal(rejoined.roles.cache.has(muteRole.id), true);
  assert.equal(moderationService.getActiveMute(guild.id, target.id).mute_until, original, 'expiry not restarted');
});

test('rejoin auto-roles preserve Member and Survival, then restore the active Mute role', async () => {
  const { guild, muteRole, moderator, target } = setup();
  const memberRole = makeRole(guild, { name: 'Member', position: 5 });
  const survivalRole = makeRole(guild, { name: 'Survival', position: 6 });
  rolesRepository.setRole(guild.id, 'MEMBER', memberRole.id, 'test');
  rolesRepository.setRole(guild.id, 'SURVIVAL', survivalRole.id, 'test');
  await moderationService.mute({ guild, target, moderator, durationMs: 10 * 3_600_000, reason: 'cheating' });

  target.roles.cache.clear();
  guild.members.cache.delete(target.id);
  const rejoined = makeMember(guild, { id: target.id, username: 'target' });

  const joinRoles = await roleService.assignJoinRoles(rejoined);
  const restored = await moderationService.restoreMuteOnJoin(rejoined);

  assert.deepEqual(joinRoles.assigned, ['MEMBER', 'SURVIVAL']);
  assert.equal(restored.restored, true);
  assert.equal(rejoined.roles.cache.has(memberRole.id), true, 'normal Member role is preserved');
  assert.equal(rejoined.roles.cache.has(survivalRole.id), true, 'normal Survival role is preserved');
  assert.equal(rejoined.roles.cache.has(muteRole.id), true, 'active persisted mute is restored last');
});

test('a mute that expired while the member was away is not re-applied', async () => {
  const { guild, muteRole, moderator, target } = setup();
  await moderationService.mute({ guild, target, moderator, durationMs: 60_000 });
  // Force the record into the past.
  const { prepare } = require('../src/database/database');
  prepare('UPDATE mutes SET mute_until = ? WHERE guild_id = ? AND user_id = ? AND active = 1').run(Date.now() - 1, guild.id, target.id);

  const rejoined = makeMember(guild, { id: target.id, username: 'target' });
  const outcome = await moderationService.restoreMuteOnJoin(rejoined);
  assert.equal(outcome.expired, true);
  assert.equal(outcome.restored, false);
  assert.equal(rejoined.roles.cache.has(muteRole.id), false);
  assert.equal(moderationService.getActiveMute(guild.id, target.id), null);
});

test('the expiry job removes the role and closes the record once time is up', async () => {
  const { guild, muteRole, moderator, target, client } = setup();
  await moderationService.mute({ guild, target, moderator, durationMs: 60_000 });
  assert.equal(await moderationService.expireMutes(client), 0, 'not yet due');

  const { prepare } = require('../src/database/database');
  prepare('UPDATE mutes SET mute_until = ? WHERE guild_id = ? AND user_id = ? AND active = 1').run(Date.now() - 1, guild.id, target.id);

  assert.equal(await moderationService.expireMutes(client), 1);
  assert.equal(target.roles.cache.has(muteRole.id), false);
  assert.equal(moderationService.getActiveMute(guild.id, target.id), null);
});

test('mute fails cleanly when the Mute role is missing or deleted', async () => {
  const { guild, muteRole, moderator, target } = setup();
  guild.roles.cache.delete(muteRole.id);
  await assert.rejects(() => moderationService.mute({ guild, target, moderator, durationMs: 1000 }), /deleted/);

  rolesRepository.clearRole(guild.id, 'MUTE');
  await assert.rejects(() => moderationService.mute({ guild, target, moderator, durationMs: 1000 }), /No Mute role/);
});

test('temporary bans are recorded and lifted by the scheduler job', async () => {
  const { guild, moderator, target, client } = setup();
  await moderationService.ban({ guild, target, moderator, durationMs: 60_000, reason: 'temp' });
  assert.equal(guild.members.bans.has(target.id), true);
  assert.equal(await moderationService.expireTempBans(client), 0);

  const { prepare } = require('../src/database/database');
  prepare('UPDATE temp_bans SET unban_at = ? WHERE guild_id = ? AND user_id = ? AND active = 1').run(Date.now() - 1, guild.id, target.id);
  assert.equal(await moderationService.expireTempBans(client), 1);
  assert.equal(guild.members.bans.has(target.id), false);
});

test('timeouts use the native API and refuse impossible durations', async () => {
  const { guild, moderator, target } = setup();
  await moderationService.timeout({ guild, target, moderator, durationMs: 5 * 60_000, reason: 'calm down' });
  assert.ok(target.communicationDisabledUntilTimestamp > Date.now());
  await moderationService.untimeout({ guild, target, moderator });
  assert.equal(target.communicationDisabledUntilTimestamp, null);
  await assert.rejects(() => moderationService.timeout({ guild, target, moderator, durationMs: 40 * 86_400_000 }), /28 days/);
});
