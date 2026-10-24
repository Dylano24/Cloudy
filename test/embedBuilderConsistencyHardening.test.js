import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import { rememberBuilderRuntimePreview, hydrateBuilderPreviewRecord } from '../src/services/builderRuntimePreviewService.js';
import { collapseDisplayRecords } from '../src/services/embedManagerService.js';

test('Discord gateway bot messages and updates do not automatically persist command replies as Builder records', () => {
  for (const filename of ['src/events/messageCreate.js', 'src/events/messageUpdate.js']) {
    const source = fs.readFileSync(filename, 'utf8');
    assert.doesNotMatch(source, /registerCloudyEmbedMessage\(/,
      `${filename} must not persist bot replies just because Discord emitted a gateway message event`);
  }
});

test('runtime command previews stay in memory and never write or read automatic Builder storage', async t => {
  t.mock.method(db, 'set', async () => assert.fail('command preview may not write to durable storage'));
  t.mock.method(db, 'get', async () => assert.fail('preview must not reload an unrelated automatically stored response'));
  const source = { guildId: 'unpersisted-preview', channelId: 'preview-channel' };
  await rememberBuilderRuntimePreview({
    embeds: [{ title: 'Automatic preview example', description: 'Dynamic content, never a saved template' }],
  }, source);
  const record = {
    guildId: source.guildId, channelId: source.channelId, messageId: 'catalog-entry',
    source: 'system-catalog', snapshot: { title: 'Automatic preview example', description: 'Source definition' },
  };
  const preview = await hydrateBuilderPreviewRecord(
    { id: source.guildId, client: {} }, record, null, 'owner',
  );
  assert.equal(preview.source, 'runtime-preview');
  assert.equal(preview.snapshot.description, 'Dynamic content, never a saved template');
});

test('saved manual Search selections avoid expensive catalog-wide peer matching', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const begin = source.indexOf('function completeSelectedSearchRecord(');
  const end = source.indexOf('\nexport function buildMatches', begin);
  const body = source.slice(begin, end);
  assert.match(body, /selectedRecord\?\.source[^\n]*embed-builder[^\n]*return selectedRecord/,
    'manual embeds are authoritative and cannot be merged with unrelated source templates');
});

test('source catalog option labels use clean sentence case, without repeating emoji, while the stored embed stays intact', () => {
  const snapshot = { title: '✅ Daily Claimed!', description: 'Original embed wording', color: 0x55ff00 };
  const record = {
    guildId: 'menu-formatting', channelId: 'gambling', backingChannelId: 'botlog',
    messageId: '0123456789', source: 'system-catalog',
    snapshot: { ...snapshot, author: { name: 'Cloudy template key: embed-type:daily-claimed || Cloudy context: gambling/daily' } },
    name: snapshot.title, title: snapshot.title,
  };
  const [option] = collapseDisplayRecords([record], record.channelId);
  assert.equal(option.name, 'Daily claimed!');
  assert.equal(record.snapshot.title, '✅ Daily Claimed!', 'never silently rewrite the actual saved content');
});
