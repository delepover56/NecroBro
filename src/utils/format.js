'use strict';

/** Small presentation helpers shared by every feature. */

/** 12500 -> "12,500" */
function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(Math.trunc(Number(value) || 0));
}

/** Truncates text to `max` characters with an ellipsis. */
function truncate(text, max = 100) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Discord timestamp markup from epoch milliseconds. */
function discordTime(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Wraps text in inline code, escaping backticks. */
function code(text) {
  return `\`${String(text ?? '').replace(/`/g, 'ˋ')}\``;
}

/** Strips markdown/mention characters from user-provided text used in embeds. */
function sanitize(text, max = 1000) {
  return truncate(String(text ?? '').replace(/@(everyone|here)/g, '@​$1'), max);
}

module.exports = { formatNumber, truncate, discordTime, code, sanitize };
