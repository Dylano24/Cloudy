import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dm from '../src/commands/Moderation/dm.js';

function failedDmInteraction(code, errorMessage) {
  const responses = [];
  const target = {
    id: '1532882647838228725',
    tag: 'recipient#0001',
    bot: false,
    async createDM() { throw Object.assign(new Error(errorMessage), { code }); },
  };
  const interaction = {
    id: '1532882647838228726',
    createdTimestamp: Date.now(),
    deferred: true,
    replied: false,
    commandName: 'dm',
    user: { id: '1532882647838228724', tag: 'staff#0001' },
    guildId: '1532882647838228723',
    options: {
      getUser: () => target,
      getString: () => 'Message for recipient',
      getBoolean: () => false,
    },
    async editReply(payload) {
      responses.push(payload);
      this.replied = true;
      return payload;
    },
  };
  return { interaction, responses };
}

test('Discord 50278 no shared guild returns a controlled staff DM error', async () => {
  const f = failedDmInteraction(50278, 'Cannot send messages to this user due to having no mutual guilds');
  await dm.execute(f.interaction, {}, {});
  assert.equal(f.responses.length, 1);
  const rendered = JSON.stringify(f.responses[0]);
  assert.match(rendered, /no shared server/i);
  assert.doesNotMatch(rendered, /Cannot send messages to this user due to having no mutual guilds/i);
});

test('unexpected DM transport errors cannot reveal internal exception text', async () => {
  const f = failedDmInteraction(59999, 'private connectionString=postgres://secret:password@db');
  await dm.execute(f.interaction, {}, {});
  assert.equal(f.responses.length, 1);
  const rendered = JSON.stringify(f.responses[0]);
  assert.match(rendered, /Could not send the DM/);
  assert.doesNotMatch(rendered, /connectionString|secret:password/i);
});

test('sent moderation messages and giveaways acknowledge before optional audit logging', () => {
  for (const [path, trigger, acknowledge] of [
    ['../src/commands/Moderation/say.js', 'const sentMessage = await channel.send(', 'await InteractionHelper.safeEditReply('],
    ['../src/commands/Moderation/dm.js', 'await dmChannel.send(', 'await InteractionHelper.safeEditReply('],
    ['../src/commands/Giveaway/gcreate.js', 'const saved = await saveGiveaway(', 'await InteractionHelper.safeReply('],
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const delivery = source.indexOf(trigger);
    const response = source.indexOf(acknowledge, delivery);
    const log = source.indexOf('await logEvent(', delivery);
    assert.ok(delivery >= 0 && response > delivery && log > response,
      path + ': send/save must succeed before acknowledgement, and audit I/O follows acknowledgement');
  }
});
