'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { useTempDatabase } = require('./helpers');

useTempDatabase('settings');
const { initDatabase } = require('../src/database/database');
initDatabase();

const settingsRepository = require('../src/database/settings');
const { validatePrefix } = require('../src/services/prefixService');
const registry = require('../src/core/commandRegistry');
const { DEFAULT_PREFIX } = require('../src/config');

test('prefix defaults to ? and is stored per guild', () => {
  assert.equal(settingsRepository.getPrefix('unknown-guild'), DEFAULT_PREFIX);
  settingsRepository.setPrefix('g1', '!');
  assert.equal(settingsRepository.getPrefix('g1'), '!');
  assert.equal(settingsRepository.getPrefix('g2'), DEFAULT_PREFIX);
});

test('validatePrefix rejects ambiguous or dangerous prefixes', () => {
  assert.equal(validatePrefix('!'), null);
  assert.equal(validatePrefix('?'), null);
  assert.equal(validatePrefix('>>'), null);
  assert.equal(validatePrefix('$'), null);
  for (const bad of ['', '   ', 'a', '1', '/', '/x', '<@123>', '@', '#', '!!!!!!!', '! ', '`', '*']) {
    assert.notEqual(validatePrefix(bad), null, `expected rejection for "${bad}"`);
  }
});

test('case counter is atomic and per guild', () => {
  assert.equal(settingsRepository.nextCaseNumber('g9'), 1);
  assert.equal(settingsRepository.nextCaseNumber('g9'), 2);
  assert.equal(settingsRepository.nextCaseNumber('g10'), 1);
});

test('every command module loads, validates, and produces a slash payload', () => {
  registry.reset();
  registry.loadCommands(path.join(__dirname, '..', 'src', 'commands'));
  assert.ok(registry.size >= 8, `expected commands, got ${registry.size}`);

  const names = new Set();
  for (const command of registry.all()) {
    const json = registry.toSlashJSON(command);
    assert.equal(json.name, command.name);
    assert.ok(json.description.length > 0 && json.description.length <= 100);
    assert.ok(!names.has(json.name), `duplicate ${json.name}`);
    names.add(json.name);
    assert.ok(['everyone', 'moderator', 'admin', 'owner'].includes(command.permission));
  }

  // Aliases resolve to the underlying command.
  assert.equal(registry.get('commands')?.name, 'help');
  assert.equal(registry.get('nope'), null);

  // Configuration commands are admin-only (never moderator/everyone).
  for (const name of ['setprefix', 'setrole', 'setwelcome', 'setmodlog', 'config', 'setup-suggestions']) {
    const command = registry.get(name);
    assert.ok(command, `${name} missing`);
    assert.equal(command.permission, 'admin', `${name} must be admin-only`);
  }
  assert.equal(registry.get('help').permission, 'everyone');
  assert.equal(registry.get('vote').permission, 'everyone');
  // The same registered command objects produce slash payloads and are used by
  // the prefix dispatcher, so both entry points share this role gate.
  assert.equal(registry.get('mute').permission, 'moderator');
  assert.equal(registry.get('unmute').permission, 'moderator');
});
