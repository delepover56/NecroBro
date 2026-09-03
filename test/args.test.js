'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, resolvePrefixArgs, ArgumentError, usageFor } = require('../src/core/args');
const { makeGuild, makeMember, makeRole, makeChannel } = require('./helpers');

test('tokenize keeps quoted text as one argument and handles escapes', () => {
  assert.deepEqual(tokenize('giveaway create Discord 24h 1 "Discord Nitro"'), [
    'giveaway',
    'create',
    'Discord',
    '24h',
    '1',
    'Discord Nitro',
  ]);
  assert.deepEqual(tokenize("say 'hello there' friend"), ['say', 'hello there', 'friend']);
  assert.deepEqual(tokenize('a   b\tc'), ['a', 'b', 'c']);
  assert.deepEqual(tokenize('escaped \\"quote'), ['escaped', '"quote']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('""'), ['']);
});

test('resolvePrefixArgs resolves mentions, durations and greedy reasons', async () => {
  const guild = makeGuild();
  const target = makeMember(guild, { username: 'Taha' });
  const schema = [
    { name: 'user', type: 'member', required: true },
    { name: 'duration', type: 'duration', required: true },
    { name: 'reason', type: 'text', required: false },
  ];

  const { values } = await resolvePrefixArgs(
    schema,
    tokenize(`<@${target.id}> 10h cheated in the arena`),
    { guild, client: guild.client },
  );
  assert.equal(values.user.id, target.id);
  assert.equal(values.duration, 10 * 3_600_000);
  assert.equal(values.reason, 'cheated in the arena');

  const byName = await resolvePrefixArgs(schema, tokenize('taha 1d'), { guild, client: guild.client });
  assert.equal(byName.values.user.id, target.id);
  assert.equal(byName.values.reason, null);
});

test('resolvePrefixArgs handles literal filler words and choices', async () => {
  const guild = makeGuild();
  const admin = makeRole(guild, { name: 'Admin', position: 10 });
  const schema = [
    { name: 'role', type: 'role', required: true },
    { name: 'as', type: 'literal', value: 'as' },
    { name: 'type', type: 'string', required: true, choices: [{ name: 'Admin', value: 'ADMIN' }, { name: 'Mute', value: 'MUTE' }] },
  ];

  const withAs = await resolvePrefixArgs(schema, tokenize(`<@&${admin.id}> as admin`), { guild, client: guild.client });
  assert.equal(withAs.values.role.id, admin.id);
  assert.equal(withAs.values.as, true);
  assert.equal(withAs.values.type, 'ADMIN');

  const withoutAs = await resolvePrefixArgs(schema, tokenize('Admin Mute'), { guild, client: guild.client });
  assert.equal(withoutAs.values.role.id, admin.id);
  assert.equal(withoutAs.values.as, false);
  assert.equal(withoutAs.values.type, 'MUTE');

  await assert.rejects(
    () => resolvePrefixArgs(schema, tokenize('Admin as Wizard'), { guild, client: guild.client }),
    ArgumentError,
  );
});

test('optional arguments that do not match fall through to the next argument', async () => {
  const guild = makeGuild();
  const target = makeMember(guild, { username: 'bob' });
  const schema = [
    { name: 'user', type: 'user', required: true },
    { name: 'duration', type: 'duration', required: false },
    { name: 'reason', type: 'text', required: false },
  ];

  const noDuration = await resolvePrefixArgs(schema, tokenize(`${target.id} being rude`), { guild, client: guild.client });
  assert.equal(noDuration.values.user.id, target.id);
  assert.equal(noDuration.values.duration, null);
  assert.equal(noDuration.values.reason, 'being rude');

  const withDuration = await resolvePrefixArgs(schema, tokenize(`${target.id} 7d being rude`), { guild, client: guild.client });
  assert.equal(withDuration.values.duration, 7 * 86_400_000);
  assert.equal(withDuration.values.reason, 'being rude');
});

test('channels, integers with ranges and booleans resolve', async () => {
  const guild = makeGuild();
  const channel = makeChannel(guild, { name: 'general' });
  const schema = [
    { name: 'amount', type: 'integer', required: true, min: 1, max: 100 },
    { name: 'channel', type: 'channel', required: false },
    { name: 'flag', type: 'boolean', required: false },
  ];
  const ok = await resolvePrefixArgs(schema, tokenize(`50 <#${channel.id}> on`), { guild, client: guild.client });
  assert.equal(ok.values.amount, 50);
  assert.equal(ok.values.channel.id, channel.id);
  assert.equal(ok.values.flag, true);

  const byName = await resolvePrefixArgs(schema, tokenize('5 #general off'), { guild, client: guild.client });
  assert.equal(byName.values.channel.id, channel.id);
  assert.equal(byName.values.flag, false);

  await assert.rejects(() => resolvePrefixArgs(schema, tokenize('500'), { guild, client: guild.client }), /at most 100/);
  await assert.rejects(() => resolvePrefixArgs(schema, tokenize('lots'), { guild, client: guild.client }), ArgumentError);
  await assert.rejects(() => resolvePrefixArgs(schema, [], { guild, client: guild.client }), /Missing/);
});

test('usageFor renders required/optional markers', () => {
  assert.equal(
    usageFor([
      { name: 'user', type: 'member', required: true },
      { name: 'as', type: 'literal', value: 'as' },
      { name: 'reason', type: 'text' },
    ]),
    '<user> as [reason]',
  );
});
