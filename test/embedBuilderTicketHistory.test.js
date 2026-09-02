import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEmbedPayload,
  templateIdentity,
} from '../src/services/embedManagerService.js';

const guildId = '100000000000000111';
const channelId = '200000000000000111';

function record(messageId, createdAt, title, fields) {
  return {
    guildId,
    channelId,
    messageId,
    embedIndex: 0,
    source: 'embed-builder',
    title,
    name: title,
    createdAt,
    snapshot: {
      title,
      description: 'Runtime content',
      fields,
      color: 0xffffff,
    },
  };
}

function field(name, value = 'runtime') {
  return { name, value, inline: true };
}

function guild() {
  const channel = {
    id: channelId,
    name: 'ticket-logs',
    type: 0,
    rawPosition: 1,
    position: 1,
    parent: null,
    messages: { fetch: async () => null },
    toString: () => `<#${channelId}>`,
  };
  return {
    id: guildId,
    channels: {
      cache: new Map([[channelId, channel]]),
    },
  };
}

const current = [
  ['ticket-log:open', 'Ticket created', [field('Ticket'), field('Creator'), field('Channel')]],
  ['ticket-log:close', 'Ticket closed', [field('Ticket'), field('Closed by')]],
  ['ticket-log:delete', 'Ticket deleted', [field('Ticket'), field('Deleted by')]],
  ['ticket-log:claim', 'Ticket claimed', [field('Ticket'), field('Claimed by')]],
  ['ticket-log:unclaim', 'Ticket unclaimed', [field('Ticket'), field('Unclaimed by')]],
  ['ticket-log:priority', 'Priority updated', [field('Ticket'), field('Priority'), field('Updated by')]],
  ['ticket-log:pin', 'Ticket pinned', [field('Ticket'), field('Pinned by')]],
  ['ticket-log:unpin', 'Ticket unpinned', [field('Ticket'), field('Unpinned by')]],
  ['ticket-log:transcript', 'Transcript generated', [field('Ticket'), field('Creator'), field('Messages')]],
  ['ticket-log:feedback', 'Feedback received', [field('Ticket'), field('Rating')]],
];

test('all ten current ticket log events have stable Builder identities', () => {
  for (const [identity, title, fields] of current) {
    assert.equal(templateIdentity(channelId, { title, fields }), identity, title);
  }
});

test('legacy ticket log titles collapse into the current ten Builder entries', () => {
  const records = [];
  let index = 0;

  for (const [, currentTitle, fields] of current) {
    const legacyTitle = currentTitle
      .replace('Ticket created', 'Ticket opened')
      .replace('Ticket closed', 'Ticket close log')
      .replace('Ticket deleted', 'Ticket delete log')
      .replace('Ticket claimed', 'Ticket claim log')
      .replace('Ticket unclaimed', 'Ticket unclaim log')
      .replace('Priority updated', 'Ticket priority log')
      .replace('Ticket pinned', 'Ticket pin log')
      .replace('Ticket unpinned', 'Ticket unpin log')
      .replace('Transcript generated', 'Ticket transcript')
      .replace('Feedback received', 'Ticket feedback');

    records.push(record(`300000000000001${index}`, `2026-09-01T10:${String(index).padStart(2, '0')}:00.000Z`, legacyTitle, fields));
    records.push(record(`400000000000001${index}`, `2026-09-02T10:${String(index).padStart(2, '0')}:00.000Z`, currentTitle, fields));
    index += 1;
  }

  // This models an obsolete ticket-log variant that no longer maps to a
  // current event. It must not appear as an eleventh ticket entry.
  records.push(record(
    '500000000000000001',
    '2026-09-01T08:00:00.000Z',
    'Ticket status changed',
    [field('Ticket'), field('Staff member')],
  ));

  // A normal non-ticket embed in the same channel must remain visible.
  records.push(record(
    '500000000000000002',
    '2026-09-02T11:00:00.000Z',
    'Maintenance notice',
    [field('Status')],
  ));

  const payload = buildEmbedPayload(guild(), records, channelId, 0);
  const options = payload.components[0].toJSON().components[0].options;
  const labels = options.map(option => option.label).sort();
  const expected = [...current.map(([, title]) => title), 'Maintenance notice'].sort();

  assert.deepEqual(labels, expected);
  assert.equal(labels.includes('Ticket status changed'), false);
});
