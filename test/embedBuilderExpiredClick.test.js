import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  BUILDER_SESSION_IDLE_MS,
  linkBuilderSessionPreview,
  registerBuilderPreviewMessage,
  registerBuilderSessionCollector,
  rememberExpiredBuilderMessage,
  removeExpiredBuilderMessage,
  touchBuilderSessionMessage,
} from '../src/utils/builderSessionCleanup.js';
import { isCloudyInteractionMessage } from '../src/services/deletionAttributionService.js';

const MINUTE = 60_000;

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => { setImmediate(resolve); });
}

const expiredLink = () => Promise.reject(Object.assign(new Error('Invalid Webhook Token'), { code: 50027 }));
const unknownMessage = () => Promise.reject(Object.assign(new Error('Unknown Message'), { code: 10008 }));

function click(messageId, customId = 'simple_embed_title') {
  const calls = [];
  return {
    calls,
    interaction: {
      customId,
      message: { id: messageId },
      deferred: false,
      replied: false,
      isMessageComponent: () => true,
      async deferUpdate() { calls.push('ack'); this.deferred = true; },
      async deleteReply() { calls.push('delete:clicked'); },
      webhook: { async deleteMessage(id) { calls.push('delete:' + id); } },
    },
  };
}

// Discord lets Cloudy remove a private message only while the link of its last
// click works (15 minutes). After 30 quiet minutes that link always expired.
function builderDiscordNoLongerLetsCloudyRemove(prefix) {
  const panel = { id: `${prefix}1`, embeds: [{ title: 'Message builder' }], delete: unknownMessage };
  const preview = { id: `${prefix}2`, embeds: [{ title: 'Rules' }], delete: unknownMessage };
  registerBuilderPreviewMessage(preview);
  registerBuilderSessionCollector(panel, { ended: false, resetTimer() {}, stop() { this.ended = true; } });
  linkBuilderSessionPreview(panel, preview);
  touchBuilderSessionMessage(preview, expiredLink);
  touchBuilderSessionMessage(panel, expiredLink);
  return { panel, preview };
}

test('the Embed Builder stays 30 minutes without activity (owner\'s choice)', () => {
  assert.equal(BUILDER_SESSION_IDLE_MS, 30 * MINUTE);
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  assert.match(source, /const BUILDER_IDLE_TIMEOUT = BUILDER_SESSION_IDLE_MS;/);
});

test('a click on a Builder that expired after Discord\'s 15 minutes removes it instead of failing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { panel, preview } = builderDiscordNoLongerLetsCloudyRemove('8100000000000000');

  t.mock.timers.tick(30 * MINUTE);
  await settle();

  const { interaction, calls } = click(panel.id);
  assert.equal(await removeExpiredBuilderMessage(interaction), true);
  assert.deepEqual(calls, ['ack', 'delete:clicked', `delete:${preview.id}`],
    'the click is answered, then the Builder and its preview are removed with the click\'s own link');
  assert.equal(isCloudyInteractionMessage(panel.id), true, 'the removal is never logged as an Unknown deletion');

  // Removed once: a later click is not handled again.
  assert.equal(await removeExpiredBuilderMessage(click(panel.id).interaction), false);
});

test('a live Builder, a Builder Cloudy did remove, other messages and Search are never touched', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Live Builder: the click belongs to its own controls.
  const live = { id: '8200000000000001', embeds: [{ title: 'Message builder' }], delete: async () => {} };
  registerBuilderSessionCollector(live, { ended: false, resetTimer() {}, stop() { this.ended = true; } });
  touchBuilderSessionMessage(live, async () => {});
  const liveClick = click(live.id);
  assert.equal(await removeExpiredBuilderMessage(liveClick.interaction), false);
  assert.deepEqual(liveClick.calls, []);

  // Removed normally (within Discord's window): nothing is remembered.
  t.mock.timers.tick(30 * MINUTE);
  await settle();
  assert.equal(await removeExpiredBuilderMessage(click(live.id).interaction), false);

  // Commands and other messages are ignored.
  assert.equal(await removeExpiredBuilderMessage({ isMessageComponent: () => false, message: { id: live.id } }), false);
  assert.equal(await removeExpiredBuilderMessage(click('8200000000000009').interaction), false);

  // Search in Modify embed answers by itself.
  assert.equal(rememberExpiredBuilderMessage({ id: '8200000000000002' }), true);
  const search = click('8200000000000002', 'simple_embed_title_search');
  assert.equal(await removeExpiredBuilderMessage(search.interaction), false);
  assert.deepEqual(search.calls, []);
  assert.equal(await removeExpiredBuilderMessage(click('8200000000000002', 'simple_embed_google_search_page_2').interaction), false);
});

test('expired Builder clicks are handled before routing; an old copy left by /embedbuilder resume is remembered too', () => {
  const router = fs.readFileSync('src/events/interactionCreate.js', 'utf8');
  const hook = router.indexOf('await removeExpiredBuilderMessage(interaction)');
  assert.ok(hook > 0 && hook < router.indexOf('runWithTraceContext(interactionTraceContext'));

  const builder = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const retire = builder.slice(builder.indexOf('async function retireResumedBuilderMessages'));
  assert.match(retire.slice(0, 700), /rememberExpiredBuilderMessage\(dashboardMessage, previewMessage\)/);
});
