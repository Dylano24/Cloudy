import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import purge from '../src/commands/Moderation/purge.js';

test('purge answers the moderator without waiting for the moderation log', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseLog;
  const logStarted = new Promise(resolve => { releaseLog = resolve; });
  let logReads = 0;
  // The log looks up the guild first; hold that open like a slow Discord/database call.
  const client = { guilds: { cache: new Collection(), fetch: () => { logReads += 1; return logStarted.then(() => null); } } };
  const messages = new Collection([['m1', { id: 'm1', createdTimestamp: Date.now(), guild: { id: 'g-purge' } }]]);
  const channel = { id: 'c-purge', toString: () => '<#c-purge>',
    messages: { fetch: async () => messages }, bulkDelete: async fetched => fetched };
  const replies = [];
  const interaction = {
    id: '1300000000000000401', guildId: 'g-purge', createdTimestamp: Date.now(),
    guild: { id: 'g-purge', channels: { cache: new Collection() }, members: { cache: new Collection() } },
    channel, user: { id: 'mod', tag: 'mod#0001' }, options: { getInteger: () => 1 },
    deferred: false, replied: false, isChatInputCommand: () => true, isRepliable: () => true,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); this.replied = true; },
    async deleteReply() {},
  };
  const run = purge.execute(interaction, {}, client);
  for (let i = 0; i < 50 && !replies.length; i += 1) await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(replies.length, 1, 'the reply is sent while the log is still being written');
  assert.match(JSON.stringify(replies[0]), /Deleted 1 messages/);
  assert.ok(logReads >= 1, 'the log was started');
  releaseLog();
  await run;
});
