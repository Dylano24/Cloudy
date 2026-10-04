import test from 'node:test';
import assert from 'node:assert/strict';
import interactionCreate from '../src/events/interactionCreate.js';
import { installInteractionMessageLifecycle } from '../src/utils/interactionMessageLifecycle.js';
import { setResponseLifetime } from '../src/utils/responseLifetime.js';

function fixture(customId) {
  const replies = [];
  let deleted = 0;
  const message = { id: 'report-ack', embeds: [], components: [], flags: 64, channel: { name: 'general' } };
  const interaction = {
    id: '1556151388323708939', customId, user: { id: '1534506224312389801', tag: 'Reporter' },
    createdTimestamp: Date.now(), guildId: '1532882647838228723', channelId: '1554538663512248350',
    isChatInputCommand: () => false, isMessageContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false, isStringSelectMenu: () => false, isModalSubmit: () => true,
    reply: async payload => { replies.push(payload); message.embeds = payload.embeds || []; interaction.replied = true; return message; },
    editReply: async payload => { replies.push(payload); message.embeds = payload.embeds || []; interaction.replied = true; return message; },
    followUp: async payload => { replies.push(payload); return message; },
    fetchReply: async () => message,
    deleteReply: async () => { deleted += 1; },
    webhook: { deleteMessage: async () => { deleted += 1; } },
  };
  return { interaction, replies, deleted: () => deleted, client: { modals: new Map() } };
}

test('inline report modal is handled once and its confirmation survives the general event dispatcher', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installInteractionMessageLifecycle();
  const f = fixture('cloudy_report:1556151388323708938:1556151388323708937');
  await interactionCreate.execute(f.interaction, f.client);
  assert.equal(f.replies.length, 0, 'the dispatcher must not send an unknown-form error');
  setResponseLifetime(f.interaction, 120_000);
  await f.interaction.editReply({ embeds: [{ title: 'Success', description: 'Your report has been sent to the staff team.' }] });
  t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.deleted(), 0);
  t.mock.timers.tick(109_999);
  assert.equal(f.deleted(), 0);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.deleted(), 1);
});

test('unregistered unrelated modal still returns the normal short error response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installInteractionMessageLifecycle();
  const f = fixture('unknown_form:123');
  await interactionCreate.execute(f.interaction, f.client);
  assert.ok(f.replies.length > 0);
  t.mock.timers.tick(9_999);
  assert.equal(f.deleted(), 0);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.deleted() > 0);
});
