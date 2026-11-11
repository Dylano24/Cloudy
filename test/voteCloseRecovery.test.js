import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import {
  deleteVote, endDueVotes, endVoteNow, loadVote, voteWinners, VOTE_CLOSE_MAX_ATTEMPTS,
} from '../src/services/voteService.js';

// When a vote ends, its buttons must go and its result must be posted, also
// when Discord or Cloudy itself is unavailable at that exact moment. The
// result is posted once, and a tie's random winner never changes afterwards.

const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
const VOTE = '900000000000000003';
const busy = () => Object.assign(new Error('Service Unavailable'), { status: 503 });
const json = value => value?.toJSON?.() || value;

function textOf(payload) {
  const texts = [];
  const walk = component => {
    const data = json(component);
    if (data.type === 10) texts.push(data.content);
    for (const child of data.components || []) walk(child);
  };
  for (const component of payload.components || []) walk(component);
  return texts.join('\n');
}

function world(vote) {
  const store = new Map([[`guild:${GUILD}:votes`, { [vote.messageId]: structuredClone(vote) }]]);
  const state = { lookup: null, edit: null, lookups: 0 };
  const sent = [];
  const channel = {
    id: CHANNEL,
    send: async payload => {
      const message = { id: String(910000000000000000n + BigInt(sent.length)), ...payload };
      sent.push(message);
      return message;
    },
    messages: { fetch: async id => {
      state.lookups += 1;
      if (state.lookup) throw state.lookup();
      return id === VOTE ? voteMessage : null;
    } },
  };
  const voteMessage = { id: VOTE, edits: [],
    edit: async payload => { if (state.edit) throw state.edit(); voteMessage.edits.push(payload); },
    reply: async payload => channel.send(payload), delete: async () => {} };
  const guild = { id: GUILD, channels: { cache: new Collection([[CHANNEL, channel]]) } };
  const client = {
    guilds: { cache: new Collection([[GUILD, guild]]) },
    db: {
      get: async (key, fallback = null) => (store.has(key) ? structuredClone(store.get(key)) : fallback),
      set: async (key, value) => { store.set(key, structuredClone(value)); return true; },
    },
  };
  const results = () => sent.filter(message => /The vote has ended!/.test(textOf(message)));
  return { client, guild, state, sent, voteMessage, results, read: () => loadVote(client, GUILD, VOTE) };
}

const card = (extra = {}) => ({ messageId: VOTE, channelId: CHANNEL, guildId: GUILD, question: 'Which map?',
  options: ['Map 1', 'Map 2'], votes: { a: 0, b: 0, c: 1 }, endsAt: Date.now() - 1_000, ended: false,
  layout: 'preview', createdAt: new Date().toISOString(), ...extra });

test('Discord is unavailable when a vote ends: buttons and result follow once Discord answers again', async () => {
  const w = world(card());
  w.state.lookup = busy;
  await endDueVotes(w.client);
  let saved = await w.read();
  assert.equal(saved.ended, true);
  assert.deepEqual(saved.closePending, { attempts: 1 });
  assert.equal(w.voteMessage.edits.length, 0);
  assert.equal(w.results().length, 0);

  await endDueVotes(w.client);
  assert.deepEqual((await w.read()).closePending, { attempts: 2 });

  w.state.lookup = null;
  await endDueVotes(w.client);
  saved = await w.read();
  assert.equal(saved.closePending, undefined);
  assert.equal(w.voteMessage.edits.length, 1);
  assert.equal(w.voteMessage.edits[0].components.length, 1, 'only the card is left: the vote buttons are gone');
  assert.equal(w.results().length, 1);
  assert.match(textOf(w.results()[0]), /\*\*Most votes\*\*\n[^\n]*\*\*Map 1\*\*/);
  assert.equal(saved.resultMessageId, w.results()[0].id);

  await endDueVotes(w.client);
  await endDueVotes(w.client);
  assert.equal(w.results().length, 1, 'the result is posted exactly once');
  assert.equal(w.voteMessage.edits.length, 1);
});

test('Cloudy restarts right after a vote was marked ended: the next start finishes closing it', async () => {
  const w = world(card({ ended: true, endedAt: Date.now() - 500, closePending: { attempts: 0 } }));
  await endDueVotes(w.client);
  assert.equal(w.results().length, 1);
  assert.equal((await w.read()).closePending, undefined);
  await endDueVotes(w.client);
  assert.equal(w.results().length, 1);
});

test('a tie picks its winner when the vote ends and shows that same winner later', async () => {
  const w = world(card({ votes: { a: 0, b: 1 } }));
  w.state.lookup = busy;
  await endDueVotes(w.client);
  const picked = (await w.read()).tieWinner;
  assert.ok([0, 1].includes(picked), 'the winner is saved together with the end');
  w.state.lookup = null;
  await endDueVotes(w.client);
  const saved = await w.read();
  assert.equal(saved.tieWinner, picked, 'never drawn again');
  assert.deepEqual(voteWinners(saved), [picked]);
  assert.match(textOf(w.results()[0]),
    new RegExp(`\\*\\*Random selection result\\*\\*\\n[^\\n]*\\*\\*Map ${picked + 1}\\*\\*`));
});

test('votes that ended before this change are left exactly as they are', async () => {
  const old = card({ ended: true, endedAt: Date.now() - 86_400_000 });
  const w = world(old);
  await endDueVotes(w.client);
  assert.equal(w.state.lookups, 0);
  assert.equal(w.sent.length, 0);
  assert.deepEqual(await w.read(), old);
});

test('a vote message that was really deleted is closed without posting a result', async () => {
  const w = world(card());
  w.state.lookup = () => Object.assign(new Error('Unknown Message'), { code: 10008, status: 404 });
  await endDueVotes(w.client);
  const saved = await w.read();
  assert.equal(saved.ended, true);
  assert.equal(saved.closePending, undefined);
  assert.equal(w.sent.length, 0);
});

test('a vote that can never be closed in Discord is given up after a fixed number of attempts', async () => {
  const w = world(card());
  w.state.edit = busy;
  for (let attempt = 0; attempt < VOTE_CLOSE_MAX_ATTEMPTS; attempt += 1) await endDueVotes(w.client);
  assert.equal((await w.read()).closePending, undefined);
  const lookups = w.state.lookups;
  await endDueVotes(w.client);
  assert.equal(w.state.lookups, lookups, 'no further attempts');
  assert.equal(w.results().length, 0);
});

test('End in Manage vote and the minute check at the same moment post one result', async () => {
  const w = world(card({ endsAt: Date.now() + 60_000 }));
  // Hold the first redraw so both closers are under way together.
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const edit = w.voteMessage.edit;
  let first = true;
  w.voteMessage.edit = async payload => {
    if (first) { first = false; await held; }
    return edit(payload);
  };
  const manual = endVoteNow(w.client, w.guild, VOTE);
  await new Promise(resolve => { setImmediate(resolve); });
  const check = endDueVotes(w.client);
  release();
  await Promise.all([manual, check]);
  assert.equal(w.results().length, 1);
  assert.equal((await w.read()).closePending, undefined);
});

test('a vote deleted while it is being closed stays deleted', async () => {
  const w = world(card());
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const edit = w.voteMessage.edit;
  w.voteMessage.edit = async payload => { await held; return edit(payload); };
  const closing = endDueVotes(w.client);
  await new Promise(resolve => { setImmediate(resolve); });
  await deleteVote(w.client, w.guild, VOTE);
  release();
  await closing;
  assert.equal(await w.read(), null, 'closing never writes a deleted vote back');
  assert.equal(w.results().length, 0);
});
