'use strict';

/**
 * Human duration parsing/formatting: "10h", "1d12h", "30m", "2w", "1y", "45s".
 */

const UNITS = {
  // A year is intentionally a fixed 365-day moderation duration, so the
  // persisted expiry stays a simple timestamp and does not depend on leap years.
  y: 31_536_000_000,
  yr: 31_536_000_000,
  yrs: 31_536_000_000,
  year: 31_536_000_000,
  years: 31_536_000_000,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  wk: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

const TOKEN = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

/**
 * Parses a duration string into milliseconds.
 * Returns `null` for anything that is not a well-formed duration.
 */
function parseDuration(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase().replace(/\s+/g, '');
  if (text === '') return null;

  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, amount, unit] = match;
    const multiplier = UNITS[unit];
    if (!multiplier) return null;
    total += Number.parseFloat(amount) * multiplier;
    consumed += whole.length;
  }

  // Reject strings with leftovers ("10hx", "abc") and bare numbers ("10").
  if (consumed === 0 || consumed !== text.length) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round(total);
}

/** Formats milliseconds as "10 hours", "1 day 2 hours", "45 seconds". */
function formatDuration(ms, { maxParts = 2 } = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 seconds';

  const parts = [];
  let remaining = Math.round(ms / 1000);
  const table = [
    ['year', 31_536_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];

  for (const [label, seconds] of table) {
    if (parts.length >= maxParts) break;
    const count = Math.floor(remaining / seconds);
    if (count > 0) {
      parts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
      remaining -= count * seconds;
    }
  }

  return parts.length > 0 ? parts.join(' ') : 'less than a second';
}

module.exports = { parseDuration, formatDuration };
