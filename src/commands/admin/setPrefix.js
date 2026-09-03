'use strict';

const { PREFIX_MAX_LENGTH } = require('../../config');
const settingsRepository = require('../../database/settings');
const { validatePrefix } = require('../../services/prefixService');
const { createLogger } = require('../../utils/logger');

const log = createLogger('setprefix');

module.exports = {
  name: 'setprefix',
  category: 'admin',
  description: 'Change the text-command prefix for this server (slash commands always work).',
  permission: 'admin',
  args: [
    {
      name: 'prefix',
      type: 'string',
      description: `The new prefix, up to ${PREFIX_MAX_LENGTH} characters (e.g. ! or ?).`,
      required: true,
      max: 32,
    },
  ],
  examples: ['setprefix !'],
  async execute(ctx) {
    const requested = ctx.get('prefix');
    const problem = validatePrefix(requested);
    if (problem) return ctx.failure(problem);

    const previous = ctx.prefix;
    settingsRepository.setPrefix(ctx.guildId, requested);
    log.info(`Prefix for guild ${ctx.guildId} changed from "${previous}" to "${requested}" by ${ctx.user.id}.`);

    return ctx.success(
      `Prefix updated to \`${requested}\`. Try \`${requested}help\`.\n` +
        `Slash commands like \`/help\` keep working regardless of the prefix.`,
    );
  },
};
