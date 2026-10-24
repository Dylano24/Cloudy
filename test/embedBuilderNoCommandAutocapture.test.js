import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { discoverRecentChannelEmbeds } from '../src/services/embedMissingChannelService.js';

test('previewing command responses must not add slash/prefix replies to a feature channel browser', async () => {
  const channelId = 'feature-channel', guildId = 'command-not-builder-2026';
  function message(id, title, extra = {}) {
    return {
      id, guildId, channelId, author: { id: 'cloudy-bot' },
      createdTimestamp: 1792800000000, embeds: [{ title, description: 'Example body' }],
      components: [], ...extra,
    };
  }
  const entries = [
    message('slash-ping', 'Ping!', { interactionMetadata: { id: 'actual-interaction' } }),
    message('prefix-ping', 'Ping!', { reference: { messageId: 'user-command' } }),
    message('manual', 'House rules'),
    message('panel', 'Gambling & Games'),
  ];
  const page = new Map(entries.map(item => [item.id, item]));
  const channel = { id: channelId, name: 'gambling', messages: { fetch: async () => page } };
  const guild = { id: guildId, channels: { cache: new Map([[channelId, channel]]) } };
  const records = await discoverRecentChannelEmbeds(guild, channelId, 'cloudy-bot');
  assert.deepEqual(records.map(item => item.messageId).sort(), ['manual', 'panel'],
    'command executions are neither permanent Builder saves nor independent live channel templates');
  assert.ok(records.every(item => item.source === 'embed-builder' && !item.manualSaved),
    'visible manual posts remain temporary until explicit Save');
});

test('rendering a previously unseen runtime response never creates a new source-catalog template', () => {
  const source = fs.readFileSync('src/services/systemEmbedCatalogService.js', 'utf8');
  const begin = source.indexOf('export function applyRuntimeEmbedTemplateData(');
  const end = source.indexOf('\nexport function ', begin + 1);
  const block = source.slice(begin, end < 0 ? undefined : end);
  assert.doesNotMatch(block, /captureSystemEmbedData\(/,
    'the complete source catalog is built from bot code and deliberate saves, not every command invocation');
});
