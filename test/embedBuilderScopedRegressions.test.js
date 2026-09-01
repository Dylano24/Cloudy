import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeDynamicTemplateText,
  mergeTemplateFields,
} from '../src/services/embedManagerService.js';
import {
  applyRuntimeEmbedTemplateData,
  indexSystemEmbedCatalogMessage,
} from '../src/services/systemEmbedCatalogService.js';

function catalogMessage(guildId, data) {
  return {
    guildId,
    embeds: [{
      toJSON: () => structuredClone(data),
    }],
  };
}

function context(guildId) {
  return {
    guildId,
    commandName: 'shared-command',
  };
}

test('historical peer field labels stay static while values remain live', () => {
  const fields = mergeTemplateFields(
    [{ name: 'Your Hand 1', value: 'sample' }],
    [{ name: 'Bet 9', value: 'edited sample', inline: true }],
    [{ name: 'Your Hand 2', value: '$25 live', inline: false }],
  );

  assert.equal(fields[0].name, 'Bet 9');
  assert.equal(fields[0].value, '$25 live');
  assert.equal(fields[0].inline, true);
  assert.equal(mergeDynamicTemplateText('Your Hand 1', 'Seat {dynamic}', 'Your Hand 2'), 'Seat 2');
  assert.equal(mergeDynamicTemplateText('Your Hand {dynamic}', 'Seat {dynamic}', 'Your Hand 3'), 'Seat 3');
});

test('system catalog templates are isolated by guild', () => {
  const author = {
    name: 'Cloudy template key: shared response || Cloudy context: botlog/shared-command || Cloudy kind: embed',
  };
  indexSystemEmbedCatalogMessage(catalogMessage('guild-a', {
    title: 'Shared response',
    description: 'Guild A style',
    color: 0x111111,
    author,
  }));
  indexSystemEmbedCatalogMessage(catalogMessage('guild-b', {
    title: 'Shared response',
    description: 'Guild B style',
    color: 0x222222,
    author,
  }));

  const runtime = { title: 'Shared response', description: 'Runtime text', color: 0xFFFFFF };
  assert.equal(applyRuntimeEmbedTemplateData(runtime, context('guild-a')).color, 0x111111);
  assert.equal(applyRuntimeEmbedTemplateData(runtime, context('guild-b')).color, 0x222222);
  assert.equal(applyRuntimeEmbedTemplateData(runtime, context('guild-c')).color, 0xFFFFFF);
});

test('catalog omissions preserve runtime footer, thumbnail and image', () => {
  const guildId = 'guild-media';
  indexSystemEmbedCatalogMessage(catalogMessage(guildId, {
    title: 'Media response',
    description: 'Styled response',
    color: 0x123456,
    fields: [{ name: 'Bet 9', value: 'Catalog sample' }],
    author: {
      name: 'Cloudy template key: media response || Cloudy context: botlog/shared-command || Cloudy kind: embed',
    },
  }));

  const runtime = {
    title: 'Media response',
    description: 'Runtime text',
    footer: { text: 'Runtime footer' },
    thumbnail: { url: 'https://example.com/runtime-thumbnail.png' },
    image: { url: 'https://example.com/runtime-image.png' },
    fields: [{ name: 'Runtime field 2', value: 'Live field value' }],
  };
  const result = applyRuntimeEmbedTemplateData(runtime, context(guildId));

  assert.deepEqual(result.footer, runtime.footer);
  assert.deepEqual(result.thumbnail, runtime.thumbnail);
  assert.deepEqual(result.image, runtime.image);
  assert.equal(result.fields[0].name, 'Bet 9');
  assert.equal(result.fields[0].value, 'Live field value');
});