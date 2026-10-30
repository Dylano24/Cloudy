import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  isBuilderSessionMessage,
  registerBuilderSessionInteraction,
  unregisterBuilderSessionInteraction,
} from '../src/utils/builderSessionCleanup.js';
import {
  isOrphanedEmbedBuilderMessage,
  isOrphanedEmbedBuilderPreview,
} from '../src/events/embedBuilderOrphanCleanupReady.js';
import brandingMessageCreate from '../src/events/cloudyBrandingMessageCreate.js';
import brandingMessageUpdate from '../src/events/cloudyBrandingMessageUpdate.js';

const BOT = { id: '1600000000000000001', bot: true };

function publicReply(interactionId, extra = {}) {
  return {
    id: String(BigInt(interactionId) + 1n),
    author: BOT,
    flags: { bitfield: 0, has: () => false },
    interactionMetadata: { id: interactionId, type: 2 },
    embeds: [{ title: 'Rules', description: 'Draft text' }],
    ...extra,
  };
}

test('the public Builder preview is recognised from its first gateway event, before its id is known', () => {
  const interactionId = '1600000000000000100';
  const preview = publicReply(interactionId);
  assert.equal(isBuilderSessionMessage(preview), false, 'unknown interaction: an ordinary message');
  registerBuilderSessionInteraction(interactionId);
  try {
    assert.equal(isBuilderSessionMessage(preview), true);
    // A private error or status reply of the same interaction keeps its 10-second lifetime.
    const privateNotice = publicReply(interactionId, {
      id: '1600000000000000999',
      flags: { bitfield: MessageFlags.Ephemeral, has: flag => flag === MessageFlags.Ephemeral },
      embeds: [{ title: 'Permission denied' }],
    });
    assert.equal(isBuilderSessionMessage(privateNotice), false);
  } finally {
    unregisterBuilderSessionInteraction(interactionId);
  }
  assert.equal(isBuilderSessionMessage(preview), false, 'forgotten once the Builder ended');
});

test('generic branding and template passes never touch the public Builder preview', async () => {
  const interactionId = '1600000000000000200';
  registerBuilderSessionInteraction(interactionId);
  let edits = 0;
  const preview = publicReply(interactionId, {
    guildId: 'g', channelId: 'c',
    client: { user: BOT },
    // "Success" would make an ordinary Cloudy message a 10-second status reply.
    embeds: [{ title: 'Success', description: 'Draft', toJSON() { return { title: 'Success', description: 'Draft' }; } }],
    deletable: true,
    async delete() { assert.fail('the Builder preview must never be deleted as a status reply'); },
    async edit() { edits += 1; },
  });
  try {
    await brandingMessageCreate.execute(preview);
    await brandingMessageUpdate.execute(preview, preview);
    assert.equal(edits, 0, 'no automatic restyle or template save');
  } finally {
    unregisterBuilderSessionInteraction(interactionId);
  }
});

test('after a restart the orphaned public Builder goes with its own preview, never another Cloudy message', () => {
  const cutoff = Date.now();
  const interactionId = '1600000000000000300';
  const controls = {
    id: '1600000000000000302', author: BOT, createdTimestamp: cutoff - 60_000,
    interactionMetadata: { id: interactionId },
    embeds: [{ title: 'Message builder' }],
    components: [{ components: [{ custom_id: 'simple_embed_post' }] }],
  };
  const preview = { id: '1600000000000000301', author: BOT, createdTimestamp: cutoff - 60_000,
    interactionMetadata: { id: interactionId }, embeds: [{ title: 'Rules' }], components: [] };
  const postedEmbed = { id: '1600000000000000200', author: BOT, createdTimestamp: cutoff - 120_000,
    embeds: [{ title: 'Rules' }], components: [] };
  const otherCommandReply = { id: '1600000000000000400', author: BOT, createdTimestamp: cutoff - 60_000,
    interactionMetadata: { id: '1600000000000000399' }, embeds: [{ title: 'Balance' }], components: [] };

  assert.equal(isOrphanedEmbedBuilderMessage(controls, BOT.id, cutoff), true);
  const orphanIds = new Set([interactionId]);
  assert.equal(isOrphanedEmbedBuilderPreview(preview, BOT.id, orphanIds, cutoff), true);
  assert.equal(isOrphanedEmbedBuilderPreview(postedEmbed, BOT.id, orphanIds, cutoff), false, 'a posted embed is never removed');
  assert.equal(isOrphanedEmbedBuilderPreview(otherCommandReply, BOT.id, orphanIds, cutoff), false);
  assert.equal(isOrphanedEmbedBuilderPreview({ ...preview, createdTimestamp: cutoff + 1 }, BOT.id, orphanIds, cutoff), false,
    'a Builder opened after the restart is never an orphan');
});
