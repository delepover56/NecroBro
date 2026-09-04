'use strict';

const { prepare } = require('./database');

function parseAttachments(text) {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value.filter((url) => typeof url === 'string') : [];
  } catch {
    return [];
  }
}

function hydrate(row) {
  return row ? { ...row, attachment_urls: parseAttachments(row.attachment_urls) } : null;
}

function createTicket({ guildId, channelId, creatorId, type, platform, details, attachmentUrls = [] }) {
  const now = Date.now();
  const result = prepare(
    `INSERT INTO tickets (guild_id, channel_id, creator_id, type, platform, details, attachment_urls, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(guildId, channelId, creatorId, type, platform, details, JSON.stringify(attachmentUrls), now);
  return getTicketById(Number(result.lastInsertRowid));
}

function getTicketById(id) {
  return hydrate(prepare('SELECT * FROM tickets WHERE id = ?').get(id));
}

function getTicketByChannel(channelId) {
  return hydrate(prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId));
}

function getOpenTicketForCreator(guildId, creatorId) {
  return hydrate(prepare("SELECT * FROM tickets WHERE guild_id = ? AND creator_id = ? AND status = 'OPEN'").get(guildId, creatorId));
}

function closeTicket(channelId, closedBy) {
  prepare("UPDATE tickets SET status = 'CLOSED', closed_at = ?, closed_by = ? WHERE channel_id = ? AND status = 'OPEN'")
    .run(Date.now(), closedBy, channelId);
  return getTicketByChannel(channelId);
}

function deleteTicket(channelId) {
  prepare('DELETE FROM tickets WHERE channel_id = ?').run(channelId);
}

module.exports = { createTicket, getTicketById, getTicketByChannel, getOpenTicketForCreator, closeTicket, deleteTicket };
