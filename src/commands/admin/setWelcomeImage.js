'use strict';

const settingsRepository = require('../../database/settings');

function validImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

module.exports = {
  name: 'setwelcomeimage',
  aliases: ['setwelcomegif'],
  category: 'admin',
  description: 'Set the bottom image or GIF on welcome embeds, or clear it.',
  permission: 'admin',
  args: [{ name: 'url', type: 'text', description: 'Direct HTTPS/HTTP image or GIF URL. Omit to clear it.', required: false, max: 2000 }],
  examples: ['setwelcomeimage https://example.com/welcome.gif', 'setwelcomeimage'],
  async execute(ctx) {
    const raw = ctx.get('url')?.trim();
    if (!raw) {
      settingsRepository.updateSettings(ctx.guildId, { welcome_image_url: null });
      return ctx.success('The welcome embed image/GIF is now **disabled**.');
    }
    const url = validImageUrl(raw);
    if (!url) return ctx.failure('Provide a valid direct `https://` or `http://` image/GIF URL.');
    settingsRepository.updateSettings(ctx.guildId, { welcome_image_url: url });
    return ctx.success('The welcome embed image/GIF has been updated.');
  },
};

module.exports.validImageUrl = validImageUrl;
