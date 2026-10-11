import test from 'node:test';
import assert from 'node:assert/strict';
import ban from '../src/commands/Moderation/ban.js';
import kick from '../src/commands/Moderation/kick.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';

for (const [name, command, method] of [['ban', ban, 'banUser'], ['kick', kick, 'kickUser']]) {
  for (const ackWorks of [true, false]) {
    test(`${name} acknowledges before action and ${ackWorks ? 'retains the success reply' : 'stops if acknowledgement fails'}`, async t => {
      const order = [];
      let payload;
      t.mock.method(InteractionHelper, 'safeDefer', async () => { order.push('ack'); return ackWorks; });
      t.mock.method(ModerationService, method, async () => { order.push('action'); return { caseId: 7 }; });
      t.mock.method(InteractionHelper, 'universalReply', async (_interaction, reply) => { order.push('reply'); payload = reply; });
      const user = { id: 'target', tag: 'Target' };
      await command.execute({ user: { id: 'owner' }, options: { getUser: () => user, getMember: () => ({ user }), getString: () => 'Reason' } }, {}, { user: { id: 'bot' } });
      assert.deepEqual(order, ackWorks ? ['ack', 'action', 'reply'] : ['ack']);
      if (ackWorks) assert.match(payload.embeds[0].toJSON().description, /\*\*Case ID:\*\* #7/);
    });
  }
}
