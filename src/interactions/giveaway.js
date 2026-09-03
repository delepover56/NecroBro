'use strict';

const { COMPONENT_NAMESPACES } = require('../config');
const giveawayService = require('../services/giveawayService');
const { createLogger } = require('../utils/logger');
const { deferEphemeral, failure, info, success } = require('../utils/respond');

const log = createLogger('giveaways:interaction');

const NS = COMPONENT_NAMESPACES.giveaway;

/**
 * `🎉 Join Giveaway` / `🚪 Leave Giveaway`.
 *
 * Custom ID shape: `gw:join:<giveawayId>` / `gw:leave:<giveawayId>`. The entry
 * is persisted first; the participant count on the message is then refreshed
 * through the service's per-giveaway edit queue so button mashing never races.
 */
async function handleParticipation(interaction, action, [rawId]) {
  const giveawayId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(giveawayId) || giveawayId <= 0) {
    log.warn(`Malformed giveaway custom ID: ${interaction.customId}`);
    return failure(interaction, 'That giveaway button is malformed. Please let staff know.');
  }

  if (!(await deferEphemeral(interaction))) return undefined;

  const handler = action === 'join' ? giveawayService.joinGiveaway : giveawayService.leaveGiveaway;
  const result = handler({ giveawayId, guildId: interaction.guildId, userId: interaction.user.id });

  if (result.changed) {
    // Fire-and-forget: the queue coalesces rapid clicks and never rejects.
    void giveawayService.refreshMessage(interaction.client, giveawayId, interaction.message ?? null);
  }

  const suffix = result.row?.status === giveawayService.STATUS.ACTIVE ? `\n-# 👥 ${result.count} participant${result.count === 1 ? '' : 's'}` : '';
  if (result.ok) return success(interaction, `${result.message}${suffix}`);
  if (result.row && result.row.status === giveawayService.STATUS.ACTIVE && !result.changed) {
    return info(interaction, `${result.message}${suffix}`);
  }
  return failure(interaction, result.message);
}

module.exports = {
  buttonPrefixes: {
    [`${NS}:join`]: (interaction, args) => handleParticipation(interaction, 'join', args),
    [`${NS}:leave`]: (interaction, args) => handleParticipation(interaction, 'leave', args),
  },
};
