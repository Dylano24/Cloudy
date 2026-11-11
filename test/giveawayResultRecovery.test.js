import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import {
  checkGiveaways, checkUnclaimedGiveawayWinners, finishGiveaway, loadGiveaway, rerollGiveaway,
  resumeGiveawayResult, GIVEAWAY_RESULT_MAX_ATTEMPTS, GIVEAWAY_WINNER_CLAIM_WINDOW_MS,
} from '../src/services/giveawayActions.js';

// A drawn giveaway result must reach Discord even when Discord, or Cloudy
// itself, is unavailable at the moment the giveaway ends. Winners are never
// redrawn for that, never tagged twice, and a giveaway that only could not be
// checked is never treated as deleted.

const GUILD = 'giveaway-recovery-guild';
const MESSAGE = '1565600000000000777';
const busy = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
const unknownMessage = () => Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });

function world(stored = {}) {
  const values = new Map([[`guild:${GUILD}:giveaways`, structuredClone(stored)]]);
  const client = {
    db: {
      get: async (key, fallback) => structuredClone(values.get(key) ?? fallback),
      set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
      list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
    },
    guilds: { cache: new Collection() },
    channels: { fetch: async () => null },
  };
  const sent = [];
  const state = { lookup: null, edit: null, send: null, lookups: 0 };
  const giveawayMessage = { id: MESSAGE, edits: [],
    edit: async payload => { if (state.edit) throw state.edit(); giveawayMessage.edits.push(payload); return giveawayMessage; } };
  const channel = { id: 'giveaways', isTextBased: () => true,
    messages: { fetch: async id => {
      state.lookups += 1;
      if (state.lookup) throw state.lookup();
      return id === MESSAGE ? giveawayMessage : null;
    } },
    send: async payload => {
      if (state.send) throw state.send();
      const message = { id: String(1565600000000009000n + BigInt(sent.length)), ...payload };
      sent.push(message);
      return message;
    } };
  const guild = { id: GUILD, ownerId: 'owner', channels: { cache: new Collection([[channel.id, channel]]) } };
  client.guilds.cache.set(GUILD, guild);
  const read = () => loadGiveaway(client, GUILD, MESSAGE);
  return { client, guild, values, sent, state, giveawayMessage, read };
}

const due = (extra = {}) => ({ messageId: MESSAGE, channelId: 'giveaways', guildId: GUILD, prize: '1 month vip',
  winnerCount: 1, participants: ['winner'], endsAt: Date.now() - 1_000, ended: false, isEnded: false, ...extra });

test('Discord is unavailable when a giveaway ends: the saved winner is announced once Discord answers again', async () => {
  const w = world({ [MESSAGE]: due() });
  w.state.lookup = busy;
  await checkGiveaways(w.client);

  let saved = await w.read();
  assert.equal(saved.ended, true);
  assert.deepEqual(saved.winnerIds, ['winner']);
  assert.deepEqual(saved.resultPending, { kind: 'ended', winners: ['winner'], attempts: 1 });
  assert.equal(w.sent.length, 0, 'nobody is tagged while Discord cannot be reached');
  assert.equal(w.giveawayMessage.edits.length, 0);

  // Still unavailable a minute later: one more attempt, nothing else changes.
  await checkGiveaways(w.client);
  assert.equal((await w.read()).resultPending.attempts, 2);
  assert.equal(w.sent.length, 0);

  w.state.lookup = null;
  await checkGiveaways(w.client);
  saved = await w.read();
  assert.equal(saved.resultPending, undefined);
  assert.deepEqual(saved.winnerIds, ['winner'], 'the winner drawn at the end is kept, never redrawn');
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].content, '<@winner>');
  assert.match(w.sent[0].embeds[0].description, /Congratulations!/);
  assert.equal(w.giveawayMessage.edits.length, 1);
  assert.match(w.giveawayMessage.edits[0].embeds[0].description, /Giveaway ended!/);
  assert.equal(saved.winnerPingMessageId, w.sent[0].id);
  assert.ok(Date.parse(saved.claimDeadlineAt) >= Date.now() + GIVEAWAY_WINNER_CLAIM_WINDOW_MS - 1_000,
    'the 24-hour claim window starts when the winner is really announced');

  await checkGiveaways(w.client);
  await checkGiveaways(w.client);
  assert.equal(w.sent.length, 1, 'announced exactly once');
  assert.equal(w.giveawayMessage.edits.length, 1);
});

test('Cloudy restarts right after the draw was saved: the next start announces that same winner', async () => {
  // What is in the database when the process stops between saving the draw
  // and telling Discord about it.
  const w = world({ [MESSAGE]: due({ ended: true, isEnded: true, winnerIds: ['winner'], participants: ['winner', 'other'],
    endedAt: new Date().toISOString(), endedBy: 'automatic', resultPending: { kind: 'ended', winners: ['winner'], attempts: 0 } }) });
  await checkGiveaways(w.client);
  const saved = await w.read();
  assert.equal(saved.resultPending, undefined);
  assert.deepEqual(saved.winnerIds, ['winner']);
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0].allowedMentions.users, ['winner']);
  await checkGiveaways(w.client);
  assert.equal(w.sent.length, 1);
});

test('a giveaway message that was really deleted is closed without tagging anyone', async () => {
  const w = world({ [MESSAGE]: due() });
  w.state.lookup = unknownMessage;
  const result = await finishGiveaway(w.client, w.guild, MESSAGE);
  assert.equal(result.announced, false);
  assert.notEqual(result.pending, true);
  const saved = await w.read();
  assert.equal(saved.ended, true);
  assert.equal(saved.resultPending, undefined);
  w.state.lookup = null;
  await checkGiveaways(w.client);
  assert.equal(w.sent.length, 0);
});

test('a result that can never be shown is closed after a fixed number of attempts', async () => {
  const w = world({ [MESSAGE]: due() });
  w.state.lookup = busy;
  await finishGiveaway(w.client, w.guild, MESSAGE);
  for (let attempt = 1; attempt < GIVEAWAY_RESULT_MAX_ATTEMPTS; attempt += 1) await checkGiveaways(w.client);
  const saved = await w.read();
  assert.equal(saved.resultPending, undefined);
  assert.ok(saved.resultAbandonedAt);
  assert.equal(w.state.lookups, GIVEAWAY_RESULT_MAX_ATTEMPTS);
  await checkGiveaways(w.client);
  assert.equal(w.state.lookups, GIVEAWAY_RESULT_MAX_ATTEMPTS, 'no further attempts after giving up');
  assert.equal(w.sent.length, 0);
});

test('an announcement Discord refused is sent again; an unclear failure is never sent twice', async () => {
  const refused = world({ [MESSAGE]: due() });
  refused.state.send = busy;
  const first = await finishGiveaway(refused.client, refused.guild, MESSAGE);
  assert.equal(first.announced, false);
  assert.equal(first.pending, true);
  assert.equal((await refused.read()).resultPending.attempts, 1);
  refused.state.send = null;
  await checkGiveaways(refused.client);
  assert.equal(refused.sent.length, 1);
  assert.equal((await refused.read()).resultPending, undefined);

  // No answer at all (a broken connection): Discord may have posted it.
  const unclear = world({ [MESSAGE]: due() });
  unclear.state.send = () => new Error('socket hang up');
  await assert.rejects(finishGiveaway(unclear.client, unclear.guild, MESSAGE), /socket hang up/);
  unclear.state.send = null;
  assert.equal((await unclear.read()).resultPending, undefined);
  await checkGiveaways(unclear.client);
  assert.equal(unclear.sent.length, 0, 'never risk tagging the winners twice');
});

test('giveaways that ended before this change are left exactly as they are', async () => {
  const old = due({ ended: true, isEnded: true, winnerIds: ['winner'], endedAt: new Date().toISOString() });
  const w = world({ [MESSAGE]: old });
  await checkGiveaways(w.client);
  assert.equal(await resumeGiveawayResult(w.client, w.guild, MESSAGE), null);
  assert.equal(w.sent.length, 0);
  assert.equal(w.giveawayMessage.edits.length, 0);
  assert.equal(w.state.lookups, 0);
  assert.deepEqual(await w.read(), old);
});

test('a manual reroll never uses up a winner when Discord cannot be reached', async () => {
  const ended = due({ ended: true, isEnded: true, winnerIds: ['first'], participants: ['first', 'second'] });
  const w = world({ [MESSAGE]: ended });
  w.state.lookup = busy;
  await assert.rejects(rerollGiveaway(w.client, w.guild, MESSAGE, { rerolledBy: 'staff' }),
    error => /no new winner was drawn/i.test(error.userMessage));
  assert.deepEqual(await w.read(), ended, 'nothing was drawn or saved');
  assert.equal(w.sent.length, 0);

  w.state.lookup = null;
  const result = await rerollGiveaway(w.client, w.guild, MESSAGE, { rerolledBy: 'staff' });
  assert.deepEqual(result.winners, ['second']);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].embeds[0].description, /New winner!/);
  const saved = await w.read();
  assert.deepEqual(saved.previousWinnerIds, ['first']);
  assert.equal(saved.resultPending, undefined);
});

test('a reroll waits while the winners of that giveaway are still being announced', async () => {
  const w = world({ [MESSAGE]: due({ participants: ['first', 'second'] }) });
  w.state.lookup = busy;
  await finishGiveaway(w.client, w.guild, MESSAGE);
  await assert.rejects(rerollGiveaway(w.client, w.guild, MESSAGE, { rerolledBy: 'staff' }),
    error => /still being announced/.test(error.userMessage));
  assert.equal((await w.read()).previousWinnerIds, undefined);
});

test('the automatic reroll of an unclaimed prize waits for Discord instead of giving the prize up', async () => {
  const expired = new Date(Date.now() - 5_000).toISOString();
  const w = world({ [MESSAGE]: due({ ended: true, isEnded: true, winnerIds: ['first'], participants: ['first', 'second'],
    claimDeadlineAt: expired }) });
  w.state.lookup = busy;
  await checkUnclaimedGiveawayWinners(w.client);
  let saved = await w.read();
  assert.equal(saved.claimDeadlineAt, expired, 'the check stays active');
  assert.deepEqual(saved.winnerIds, ['first']);
  assert.equal(w.sent.length, 0);

  w.state.lookup = null;
  await checkUnclaimedGiveawayWinners(w.client);
  saved = await w.read();
  assert.deepEqual(saved.winnerIds, ['second']);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].content, '<@second>');
  assert.equal(saved.resultPending, undefined);

  // A giveaway that really was removed still stops the check for good.
  const removed = world({ [MESSAGE]: due({ ended: true, isEnded: true, winnerIds: ['first'], participants: ['first', 'second'],
    claimDeadlineAt: expired }) });
  removed.state.lookup = unknownMessage;
  await checkUnclaimedGiveawayWinners(removed.client);
  assert.equal((await removed.read()).claimDeadlineAt, null);
  assert.equal(removed.sent.length, 0);
});
