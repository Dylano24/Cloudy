import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

function interaction(editError) {
  const followUps = [];
  return {
    id: '1532882647838228726',
    user: { id: '1532882647838228724' },
    deferred: true,
    replied: false,
    async editReply() { throw editError; },
    async followUp(options) { followUps.push(options); },
    followUps,
  };
}

test('edit recovery gracefully handles transport errors without a message property', async () => {
  const target = interaction({ code: 'TEMPORARY_DISCORD_ERROR' });
  assert.equal(await InteractionHelper.safeEditReply(target, { content: 'Safe' }), false);
  assert.equal(target.followUps.length, 0);
});

test('deleted reply still follows up when Discord error has no message property', async () => {
  const target = interaction({ code: 10008 });
  assert.equal(await InteractionHelper.safeEditReply(target, { content: 'Recovered' }), true);
  assert.deepEqual(target.followUps, [{ content: 'Recovered' }]);
});
