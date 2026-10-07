import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudyTicketEmbed, CLOUDY_TICKET_CLOSED_COLOR, forceCloudyTicketFooter } from '../src/utils/ticket/ticketBranding.js';
import { CLOUDY_GREEN_COLOR, CLOUDY_RED_COLOR, installDefaultEmbedColorPolicy } from '../src/utils/embedColorPolicy.js';

test('ticket lifecycle status colors are final before Discord receives the status', () => {
  installDefaultEmbedColorPolicy();
  assert.equal(buildCloudyTicketEmbed({ title: 'Ticket claimed', color: '#FFFFFF' }).color, CLOUDY_GREEN_COLOR);
  assert.equal(buildCloudyTicketEmbed({ title: 'Ticket reopened', color: '#FFFFFF' }).color, CLOUDY_GREEN_COLOR);
  assert.equal(buildCloudyTicketEmbed({ title: 'Ticket closed', color: '#FFFFFF' }).color, CLOUDY_TICKET_CLOSED_COLOR);
  assert.equal(buildCloudyTicketEmbed({ title: 'Ticket unclaimed', color: '#FFFFFF' }).color, 0);
  assert.equal(buildCloudyTicketEmbed({ title: 'Ticket deleted' }).color, CLOUDY_RED_COLOR);
});

test('status colors do not overwrite permanent ticket-log colors', () => {
  const claimLog = { title: 'Ticket claimed', color: 0x57F287,
    fields: [{ name: 'Ticket', value: '#42' }, { name: 'Claimed by', value: '<@42>' }] };
  const deleteLog = { title: 'Ticket deleted', color: 0xED4245,
    fields: [{ name: 'Ticket', value: '#42' }, { name: 'Deleted by', value: '<@42>' }] };
  assert.equal(forceCloudyTicketFooter(claimLog).color, claimLog.color);
  assert.equal(forceCloudyTicketFooter(deleteLog).color, deleteLog.color);
});
