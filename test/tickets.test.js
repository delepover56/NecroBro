'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTempDatabase } = require('./helpers');

useTempDatabase('tickets');
const { initDatabase } = require('../src/database/database');
initDatabase();

const ticketRepository = require('../src/database/tickets');
const { ticketModal } = require('../src/interactions/tickets');

test('ticket records persist attachments and close without deleting the record', () => {
  const ticket = ticketRepository.createTicket({
    guildId: 'guild', channelId: 'channel', creatorId: 'member', type: 'REPORT',
    platform: 'DISCORD', details: 'A clear report with enough detail.', attachmentUrls: ['https://cdn.example/proof.png'],
  });
  assert.deepEqual(ticket.attachment_urls, ['https://cdn.example/proof.png']);
  const closed = ticketRepository.closeTicket('channel', 'staff');
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.closed_by, 'staff');
  assert.equal(ticketRepository.getTicketByChannel('channel').id, ticket.id);
});

test('ticket modal offers platform selection, details, and optional file uploads', () => {
  const json = ticketModal('SUPPORT').toJSON();
  assert.equal(json.components.length, 3);
  assert.equal(json.components[0].component.type, 3);
  assert.equal(json.components[1].component.type, 4);
  assert.equal(json.components[2].component.type, 19);
});
