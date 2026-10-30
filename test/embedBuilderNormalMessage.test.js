import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ChannelType, Collection } from 'discord.js';

import {
  isBuilderUiMessage,
  isForeignBuilderClick,
  registerBuilderInteraction,
  registerBuilderPreviewMessage,
} from '../src/utils/builderSessionCleanup.js';
import { isRegistrableCloudyEmbedMessage, isSearchableCloudyBotEmbedMessage } from '../src/services/embedRegistryService.js';
import { scheduleTransientMessageDeletion } from '../src/utils/transientResponse.js';
import { isBotActionFeedback } from '../src/services/deletionAttributionService.js';
import brandingCreate from '../src/events/cloudyBrandingMessageCreate.js';
import brandingUpdate from '../src/events/cloudyBrandingMessageUpdate.js';
import { removeOrphanedEmbedBuilders } from '../src/events/embedBuilderOrphanCleanupReady.js';
import { editBuilderPreviewMessage } from '../src/commands/Tools/embedbuilder.js';

const BOT = { id: '1500000000000000001', bot: true };
const OWNER = { id: '1500000000000000002' };
const OTHER = { id: '1500000000000000003' };
const noFlags = { has: () => false, bitfield: 0 };

// The /embedbuilder reply as Discord delivers it in the first gateway event,
// before Cloudy knows its message id.
function builderReply(interactionId, overrides = {}) {
  const edits = [];
  return {
    id: overrides.id || '1500000000000000100',
    guildId: '1500000000000000200',
    channelId: '1500000000000000300',
    client: { user: BOT },
    author: BOT,
    flags: noFlags,
    interactionMetadata: { id: interactionId, user: OWNER },
    embeds: [{ title: 'Success', description: 'My draft', footer: { text: 'My footer' } }],
    components: [],
    deletable: true,
    edits,
    async edit(payload) { edits.push(payload); return this; },
    async delete() { throw new Error('must not be deleted'); },
    ...overrides,
  };
}

test('a public Builder reply is Builder UI from its first gateway event on', async () => {
  registerBuilderInteraction('1500000000000000010');
  const preview = builderReply('1500000000000000010');
  assert.equal(isBuilderUiMessage(preview), true);
  // Never a Search item, never a 10-second status notice, never logged when removed.
  assert.equal(isRegistrableCloudyEmbedMessage(preview), false);
  assert.equal(isSearchableCloudyBotEmbedMessage(preview, BOT.id), false);
  assert.equal(scheduleTransientMessageDeletion(preview), false, 'a status-like draft title is content');
  assert.equal(isBotActionFeedback(preview), true);
  // Generic branding/template passes never restyle the owner's draft.
  await brandingCreate.execute(preview);
  await brandingUpdate.execute(preview, preview);
  assert.deepEqual(preview.edits, []);

  // Another bot reply (not the Builder) is still an ordinary message.
  const other = builderReply('1500000000000000011');
  assert.equal(isBuilderUiMessage(other), false);
});

test('only the owner can use a public Builder; anyone else gets a notice instead of a silent failure', () => {
  registerBuilderInteraction('1500000000000000020');
  const controls = builderReply('1500000000000000020', { id: '1500000000000000101', embeds: [{ title: 'Message builder' }] });
  const click = (user, customId = 'simple_embed_post', message = controls) => ({
    isMessageComponent: () => true, customId, message, user,
  });
  assert.equal(isForeignBuilderClick(click(OTHER)), true);
  assert.equal(isForeignBuilderClick(click(OWNER)), false);
  // Search in Modify embed answers by itself; other panels are not Builders.
  assert.equal(isForeignBuilderClick(click(OTHER, 'simple_embed_title_search')), false);
  assert.equal(isForeignBuilderClick(click(OTHER, 'ticket_close')), false);
  assert.equal(isForeignBuilderClick(click(OTHER, 'simple_embed_post', builderReply('1500000000000000021'))), false);

  const router = fs.readFileSync('src/events/interactionCreate.js', 'utf8');
  const notice = router.indexOf('isForeignBuilderClick(interaction)');
  assert.ok(notice > 0 && notice < router.indexOf('runWithTraceContext(interactionTraceContext'));
  assert.match(router.slice(notice, notice + 400), /replyUserError\(interaction[\s\S]*Only the person who opened this Embed Builder can use it\./);
});

test('the public Builder preview keeps updating after Discord\'s 15 minutes: it is edited as a normal message', async () => {
  let webhookEdits = 0;
  const preview = builderReply('1500000000000000030', { id: '1500000000000000102' });
  registerBuilderPreviewMessage(preview);
  const state = {
    builderBotManaged: true,
    builderMessage: preview,
    builderMessageId: preview.id,
    builderWebhook: { async editMessage() { webhookEdits += 1; throw Object.assign(new Error('Invalid Webhook Token'), { code: 50027 }); } },
  };
  assert.equal(await editBuilderPreviewMessage(state, null, { embeds: [{ title: 'Later edit' }] }), true);
  assert.equal(preview.edits.length, 1);
  assert.equal(webhookEdits, 0, 'no 15-minute interaction link is needed');
  assert.notEqual(state.builderPreviewUnavailable, true);
});

test('after a restart the leftover public Builder controls and the preview above them are removed', async () => {
  const removed = [];
  const message = (id, extra) => ({
    id, author: BOT, createdTimestamp: 1, embeds: [], components: [],
    async delete() { removed.push(id); },
    ...extra,
  });
  const preview = message('1500000000000000401', { embeds: [{ title: 'Draft' }] });
  const controls = message('1500000000000000402', {
    embeds: [{ title: 'Message builder' }],
    components: [{ components: [{ customId: 'simple_embed_open_content' }] }],
    interactionMetadata: { id: '1', originalResponseMessageId: preview.id },
  });
  const posted = message('1500000000000000403', { embeds: [{ title: 'Posted embed' }] });
  const batch = new Collection([[controls.id, controls], [preview.id, preview], [posted.id, posted]]);
  const channel = {
    id: '1500000000000000500', type: ChannelType.GuildText, position: 0,
    messages: { async fetch() { return batch; } },
    permissionsFor: () => ({ has: () => true }),
  };
  const guild = { members: { me: BOT }, channels: { cache: new Collection([[channel.id, channel]]) } };
  const result = await removeOrphanedEmbedBuilders(guild, BOT.id, 1_000);
  assert.deepEqual(removed.sort(), [preview.id, controls.id].sort());
  assert.equal(result.removed, 2);
});

test('in a server the editor buttons send their link privately, never inside the public Builder', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /state\.contentEditorUrl && state\.builderBotManaged[\s\S]{0,120}setCustomId\('simple_embed_open_content'\)/);
  assert.match(source, /state\.colorPickerUrl && state\.builderBotManaged[\s\S]{0,120}setCustomId\('simple_embed_open_color'\)/);
  const open = source.slice(source.indexOf('async function openPrivateBuilderEditor'));
  assert.match(open.slice(0, 900), /flags: MessageFlags\.Ephemeral/);
});
