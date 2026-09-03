'use strict';

/**
 * Rank (level) mathematics and the Top-board score. Pure functions, no I/O,
 * so every formula here can be unit-tested and reasoned about in isolation.
 *
 * ── Levels ────────────────────────────────────────────────────────────────
 * `xp` stored on a member is their TOTAL lifetime XP. Levels are derived from
 * it (and cached in `economy_users.level` so the rank board can be indexed).
 *
 *   xpForLevel(L)  = 5·L² + 50·L + 100      XP needed to go from level L to L+1
 *
 *   L=0 → 100, L=1 → 155, L=2 → 220, L=5 → 475, L=10 → 1,100, L=20 → 3,100 …
 *   There is no maximum level.
 *
 *   totalXpForLevel(L) = Σ_{l=0}^{L-1} xpForLevel(l)
 *                      = 5·(L−1)·L·(2L−1)/6 + 25·L·(L−1) + 100·L
 *
 * ── Top score ─────────────────────────────────────────────────────────────
 * Combines wealth and activity on a log scale so a whale cannot buy the top
 * spot and a chatterbox cannot talk their way there either. Both halves are
 * normalised against the guild's current maximum, so the score is relative to
 * the server (best possible = 100,000):
 *
 *   score = round(100000 · ( 0.5 · log1p(cash) / log1p(maxCash)
 *                          + 0.5 · log1p(xp)   / log1p(maxXp) ))
 *
 * When a guild maximum is 0 that half contributes 0 (guards against 0/0).
 * Ties are broken by cash, then XP, then user ID — fully deterministic.
 */

const SCORE_SCALE = 100_000;

/** XP required to advance from `level` to `level + 1`. */
function xpForLevel(level) {
  const L = Math.max(0, Math.trunc(Number(level) || 0));
  return 5 * L * L + 50 * L + 100;
}

/** Total XP a member must have accumulated to *be* `level`. */
function totalXpForLevel(level) {
  const L = Math.max(0, Math.trunc(Number(level) || 0));
  if (L === 0) return 0;
  const sumSquares = ((L - 1) * L * (2 * L - 1)) / 6; // Σ l²  for l = 0..L-1
  const sumLinear = (L * (L - 1)) / 2; //                Σ l   for l = 0..L-1
  return 5 * sumSquares + 50 * sumLinear + 100 * L;
}

/** Level reached with `totalXp` (iterative: subtract each level's cost). */
function levelFromTotalXp(totalXp) {
  return progress(totalXp).level;
}

/** `{ level, current, needed }` — XP inside the current level and the cost of the next. */
function progress(totalXp) {
  let remaining = Math.max(0, Math.trunc(Number(totalXp) || 0));
  let level = 0;
  for (;;) {
    const needed = xpForLevel(level);
    if (remaining < needed) return { level, current: remaining, needed };
    remaining -= needed;
    level += 1;
  }
}

/** `▰▰▰▱▱▱▱▱▱▱` style bar, `width` characters wide. */
function progressBar(current, needed, width = 10) {
  const ratio = needed > 0 ? Math.min(1, Math.max(0, current / needed)) : 1;
  const filled = Math.round(ratio * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
}

/* ------------------------------------------------------------------ *
 * Top score
 * ------------------------------------------------------------------ */

function half(value, max) {
  if (!(max > 0)) return 0;
  const v = Math.max(0, Number(value) || 0);
  return 0.5 * (Math.log1p(v) / Math.log1p(max));
}

/** Score for one member given the guild maxima. Integer in [0, 100000]. */
function topScore({ cash, xp }, { maxCash, maxXp }) {
  return Math.round(SCORE_SCALE * (half(cash, maxCash) + half(xp, maxXp)));
}

/** Guild maxima from a list of `{ cash, xp }` rows. */
function scoreMaxima(rows) {
  let maxCash = 0;
  let maxXp = 0;
  for (const row of rows) {
    maxCash = Math.max(maxCash, Number(row.cash) || 0);
    maxXp = Math.max(maxXp, Number(row.xp) || 0);
  }
  return { maxCash, maxXp };
}

function compareTop(a, b) {
  return (
    b.score - a.score ||
    Number(b.cash) - Number(a.cash) ||
    Number(b.xp) - Number(a.xp) ||
    (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0)
  );
}

/**
 * Scores and sorts every row (`{ user_id, cash, xp, ... }`) for the Top board.
 * Returns a new array of `{ ...row, score }`, best first.
 */
function rankTopBoard(rows) {
  const maxima = scoreMaxima(rows);
  return rows
    .map((row) => ({ ...row, score: topScore(row, maxima) }))
    .sort(compareTop);
}

/** 1-based Top-board position for `userId`, or `null` when absent. */
function topPosition(rows, userId) {
  const index = rankTopBoard(rows).findIndex((row) => row.user_id === userId);
  return index === -1 ? null : index + 1;
}

module.exports = {
  SCORE_SCALE,
  xpForLevel,
  totalXpForLevel,
  levelFromTotalXp,
  progress,
  progressBar,
  topScore,
  scoreMaxima,
  rankTopBoard,
  topPosition,
};
