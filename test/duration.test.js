'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDuration, formatDuration } = require('../src/utils/duration');
const { formatExpiry } = require('../src/utils/format');

test('parseDuration understands common units and combinations', () => {
  assert.equal(parseDuration('10h'), 10 * 3_600_000);
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('45s'), 45_000);
  assert.equal(parseDuration('2d'), 2 * 86_400_000);
  assert.equal(parseDuration('1w'), 7 * 86_400_000);
  assert.equal(parseDuration('1y'), 365 * 86_400_000);
  assert.equal(parseDuration('2 years 3d'), 2 * 365 * 86_400_000 + 3 * 86_400_000);
  assert.equal(parseDuration('1d12h'), 36 * 3_600_000);
  assert.equal(parseDuration('1d 12h 30m'), 36 * 3_600_000 + 30 * 60_000);
  assert.equal(parseDuration('10 hours'), 10 * 3_600_000);
  assert.equal(parseDuration('1.5h'), 90 * 60_000);
});

test('parseDuration rejects garbage and bare numbers', () => {
  for (const bad of ['', '10', 'abc', '10hx', 'h', '-5m', '0m', null, undefined, 42]) {
    assert.equal(parseDuration(bad), null, `expected null for ${String(bad)}`);
  }
});

test('formatDuration renders the two largest units', () => {
  assert.equal(formatDuration(10 * 3_600_000), '10 hours');
  assert.equal(formatDuration(36 * 3_600_000), '1 day 12 hours');
  assert.equal(formatDuration(365 * 86_400_000), '1 year');
  assert.equal(formatDuration(61_000), '1 minute 1 second');
  assert.equal(formatDuration(1_000), '1 second');
  assert.equal(formatDuration(0), '0 seconds');
});

test('formatExpiry uses a global calendar date until the final seven days', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(formatExpiry(Date.UTC(11985, 0, 28, 14, 38), { now }), 'Monday, 28 January 11985');
  assert.equal(formatExpiry(now + 2 * 86_400_000, { now }), `<t:${Math.floor((now + 2 * 86_400_000) / 1000)}:R>`);
  assert.equal(formatExpiry(now + 2 * 60_000, { now }), `<t:${Math.floor((now + 2 * 60_000) / 1000)}:R>`);
});
