import test from 'node:test';
import assert from 'node:assert/strict';
import { Embed, MessageFlags } from 'discord.js';
import { buildDedicatedGuidePayload } from '../src/services/dedicatedChannelService.js';
import panels from '../src/interactions/buttons/dedicatedCommands.js';

for (const key of ['gambling', 'shop']) {
  test(`${key} panel is compact with a Commands button`, () => {
    const result = buildDedicatedGuidePayload(key);
    assert.equal(result.embeds[0].title, key === 'shop' ? 'Shop & Economy' : 'Games & Economy');
    assert.ok(!result.embeds[0].description.includes('/balance'));
    assert.equal(result.components[0].toJSON().components[0].custom_id, `dedicated_commands:${key}`);
  });
  test(`${key} Commands opens only the requested categories privately for exactly 5 minutes`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reply, deleted = false;
    const interaction = { reply: async payload => { reply = payload; }, deleteReply: async () => { deleted = true; } };
    await panels.execute(interaction, {}, [key]);
    assert.equal(reply.flags, MessageFlags.Ephemeral);
    const text = reply.embeds[0].description;
    assert.ok(text.includes('/balance'));
    assert.equal(text.includes('/blackjack'), key === 'gambling');
    assert.equal(text.includes('/work'), key === 'gambling');
    assert.equal(text.includes('/buy'), key === 'shop');
    t.mock.timers.tick(299999); assert.equal(deleted, false);
    t.mock.timers.tick(1); await Promise.resolve(); assert.equal(deleted, true);
  });
}

test('new panels preserve manual Builder content and Commands buttons on later moves', () => {
  const existing = {
    embeds: [new Embed({ title: 'My games', description: 'Custom saved wording', color: 123 })],
    components: buildDedicatedGuidePayload('gambling').components,
  };
  const moved = buildDedicatedGuidePayload('gambling', existing);
  assert.equal(moved.embeds[0].title, 'My games');
  assert.equal(moved.embeds[0].description, 'Custom saved wording');
  assert.deepEqual(moved.components, existing.components);
});
