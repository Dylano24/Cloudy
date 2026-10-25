import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelPayload } from '../src/services/embedManagerService.js';

function channel(id, name) {
  return { id, name, type: 0, rawPosition: 1,
    messages: { fetch: async () => new Map() },
    toString: () => '#' + name,
  };
}
test('Modify channel list immediately says Open embeds or No embeds, never Checking', () => {
  const populated = channel('1611111111111111111', 'report-logs');
  const empty = channel('1622222222222222222', 'brand-new-channel');
  const guild = { id: 'instant-channel-list-test', channels: { cache: new Map([
    [populated.id, populated], [empty.id, empty],
  ]) } };
  const record = { guildId: guild.id, channelId: populated.id,
    messageId: '1700000000000000000', embedIndex: 0, source: 'bot-history',
    snapshot: { title: 'Report case created', description: 'Full original report body' },
    title: 'Report case created', name: 'Report case created',
  };
  const payload = buildChannelPayload(guild, [record], 0,
    new Set([populated.id, empty.id]));
  const options = payload.components[0].toJSON().components[0].options;
  const map = new Map(options.map(option => [option.value, option.description]));
  assert.equal(map.get(populated.id), 'Open embeds');
  assert.equal(map.get(empty.id), 'No embeds');
  assert.equal(options.length, 2, 'new Discord channels should appear automatically');
  assert.doesNotMatch(JSON.stringify(payload), /Checking|scan older embeds/);
});
