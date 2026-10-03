import test from 'node:test';
import assert from 'node:assert/strict';

import { isOrphanedEmbedBuilderMessage } from '../src/events/embedBuilderOrphanCleanupReady.js';

test('only temporary bot-authored Embed Builder control messages are startup orphans', () => {
  const botUserId = 'cloudy';

  assert.equal(isOrphanedEmbedBuilderMessage({
    id: 'builder',
    author: { id: botUserId },
    embeds: [{ title: 'Preview' }, { title: 'Message builder' }],
    components: [{ components: [{ customId: 'simple_embed_post' }] }],
  }, botUserId), true);

  assert.equal(isOrphanedEmbedBuilderMessage({
    id: 'posted-embed',
    author: { id: botUserId },
    embeds: [{ title: 'Message builder' }],
    components: [{ components: [{ customId: 'cloudy_builder_action:abc' }] }],
  }, botUserId), false);

  assert.equal(isOrphanedEmbedBuilderMessage({
    id: 'other-user',
    author: { id: 'someone-else' },
    embeds: [{ title: 'Message builder' }],
    components: [{ components: [{ customId: 'simple_embed_post' }] }],
  }, botUserId), false);
});
