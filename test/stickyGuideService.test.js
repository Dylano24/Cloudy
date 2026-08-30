import test from 'node:test';
import assert from 'node:assert/strict';
import { createStickyGuideManager } from '../src/services/stickyGuideService.js';

class Messages extends Map {
  first() { return this.values().next().value; }
}

function fixture() {
  let nextId = 100;
  let state = null;
  const history = new Map();
  const actions = [];
  const failures = {};
  const errors = [];
  const bot = { id: 'bot', bot: true };
  const guild = { id: 'guild', client: { user: bot } };
  const channel = { id: 'channel', guild, client: guild.client, lastMessageId: null };
  function addMessage({ guide = false, author = bot, title = 'Gambling & Games' } = {}) {
    const message = {
      id: String(++nextId), guild, channel, author,
      embeds: guide ? [{ title, description: 'Guide text', color: 123 }] : [],
      async delete() {
        actions.push(['delete', this.id]);
        if (failures.delete === this.id) throw new Error('Cannot delete');
        history.delete(this.id);
      },
    };
    history.set(message.id, message);
    channel.lastMessageId = message.id;
    return message;
  }
  channel.messages = {
    async fetch(options) {
      if (failures.history) throw new Error('Cannot read history');
      if (options.message) {
        actions.push(['fetch', options.message]);
        if (failures.fetch) throw Object.assign(new Error('Missing access'), { code: 50001 });
        const message = history.get(options.message);
        if (!message) throw Object.assign(new Error('Unknown message'), { code: 10008 });
        return message;
      }
      return new Messages([...history.entries()].reverse().slice(0, options.limit));
    },
  };
  channel.send = async payload => {
    if (failures.send) throw new Error('Cannot send');
    const message = addMessage({ guide: true });
    message.embeds = structuredClone(payload.embeds);
    actions.push(['send', message.id]);
    await channel.onSend?.(message);
    return message;
  };
  const options = {
    loadState: async () => structuredClone(state),
    saveState: async (_channel, value) => {
      if (failures.save) return false;
      state = structuredClone(value);
      actions.push(['save', value.messageId]);
      return true;
    },
    isGuide: message => message.embeds.some(embed => embed.title === 'Gambling & Games'),
    buildPayload: async (_channel, existing) => ({
      embeds: existing?.embeds || [{ title: 'Gambling & Games', description: 'Guide text' }],
    }),
    onError: error => errors.push(error),
  };
  return {
    channel, guild, bot, history, actions, failures, errors, addMessage,
    get state() { return state; },
    set state(value) { state = value; },
    manager: createStickyGuideManager(options),
    restart: () => createStickyGuideManager(options),
  };
}

const settle = () => new Promise(resolve => { setImmediate(resolve); });

test('moves the guide below a user and saves the replacement before deleting the old guide', async () => {
  const f = fixture();
  const old = f.addMessage({ guide: true });
  const user = f.addMessage({ author: { id: 'user' } });
  await f.manager.refresh(f.channel);
  assert.deepEqual(f.actions.map(([action]) => action), ['send', 'save', 'delete', 'save']);
  assert.equal(f.history.has(old.id), false);
  assert.equal(f.history.has(user.id), true);
  assert.deepEqual(f.history.get(f.state.messageId).embeds, old.embeds);
  assert.equal(f.channel.lastMessageId, f.state.messageId);
});

test('concurrent refreshes leave exactly one guide without reposting a guide already last', async () => {
  const f = fixture();
  f.addMessage({ guide: true });
  f.addMessage({ author: { id: 'user' } });
  await Promise.all(Array.from({ length: 10 }, () => f.manager.refresh(f.channel)));
  assert.equal(f.actions.filter(([action]) => action === 'send').length, 1);
  assert.equal([...f.history.values()].filter(message => message.author.id === 'bot').length, 1);
});

test('a burst of new messages produces a single delayed replacement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.addMessage({ guide: true });
  for (let index = 0; index < 10; index++) {
    f.manager.schedule(f.addMessage({ author: { id: 'user' } }));
  }
  t.mock.timers.tick(1499);
  assert.equal(f.actions.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(f.actions.filter(([action]) => action === 'send').length, 1);
  assert.equal(f.channel.lastMessageId, f.state.messageId);
});

test('ignores its own guide but follows game results and messages from other bots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  assert.equal(f.manager.schedule(f.addMessage({ guide: true })), false);
  assert.equal(f.manager.schedule(f.addMessage()), true);
  assert.equal(f.manager.schedule(f.addMessage({ author: { id: 'other-bot', bot: true } })), true);
  t.mock.timers.tick(1500);
  await settle();
  assert.equal(f.actions.filter(([action]) => action === 'send').length, 1);
});

test('messages arriving during a send trigger one further pass', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.addMessage({ guide: true });
  f.channel.onSend = async () => {
    f.channel.onSend = null;
    f.manager.schedule(f.addMessage({ author: { id: 'late-user' } }));
  };
  f.manager.schedule(f.addMessage({ author: { id: 'user' } }));
  t.mock.timers.tick(1500);
  await settle();
  assert.notEqual(f.channel.lastMessageId, f.state.messageId);
  t.mock.timers.tick(1500);
  await settle();
  assert.equal(f.actions.filter(([action]) => action === 'send').length, 2);
  assert.equal(f.channel.lastMessageId, f.state.messageId);
});

test('keeps the existing guide when history or sending fails', async () => {
  for (const failure of ['history', 'send']) {
    const f = fixture();
    const old = f.addMessage({ guide: true });
    f.addMessage({ author: { id: 'user' } });
    f.failures[failure] = true;
    await assert.rejects(f.manager.refresh(f.channel));
    assert.equal(f.history.has(old.id), true);
    assert.equal(f.actions.some(([action]) => action === 'delete'), false);
  }
});

test('rolls back the replacement if its ID cannot be saved', async () => {
  const f = fixture();
  const old = f.addMessage({ guide: true });
  f.addMessage({ author: { id: 'user' } });
  f.failures.save = true;
  await assert.rejects(f.manager.refresh(f.channel), /save sticky/);
  assert.equal(f.history.has(old.id), true);
  assert.equal([...f.history.values()].filter(message => message.embeds.length).length, 1);
});

test('retries failed cleanup after restart without reposting a guide already last', async () => {
  const f = fixture();
  const old = f.addMessage({ guide: true });
  f.addMessage({ author: { id: 'user' } });
  f.failures.delete = old.id;
  await f.manager.refresh(f.channel);
  assert.deepEqual(f.state.staleMessageIds, [old.id]);
  f.failures.delete = null;
  await f.restart().refresh(f.channel);
  assert.equal(f.history.has(old.id), false);
  assert.deepEqual(f.state.staleMessageIds, []);
  assert.equal(f.actions.filter(([action]) => action === 'send').length, 1);
});

test('finds a renamed guide beyond the latest 100 messages using its saved ID', async () => {
  const f = fixture();
  const old = f.addMessage({ guide: true, title: 'Custom guide title' });
  f.state = { messageId: old.id, staleMessageIds: [] };
  for (let i = 0; i < 110; i++) f.addMessage({ author: { id: 'user' } });
  await f.restart().refresh(f.channel);
  assert.equal(f.actions.some(([action, id]) => action === 'fetch' && id === old.id), true);
  assert.equal(f.history.has(old.id), false);
  assert.equal(f.history.get(f.state.messageId).embeds[0].title, 'Custom guide title');
});

test('recreates a deleted tracked guide but does not duplicate one on a temporary fetch failure', async () => {
  const f = fixture();
  f.state = { messageId: '50', staleMessageIds: [] };
  f.failures.fetch = true;
  await assert.rejects(f.manager.refresh(f.channel), /Missing access/);
  assert.equal(f.actions.some(([action]) => action === 'send'), false);
  f.failures.fetch = false;
  await f.manager.refresh(f.channel);
  assert.equal(f.history.has(f.state.messageId), true);
});

test('never deletes a user message or another bot message that copies the guide', async () => {
  const f = fixture();
  const user = f.addMessage({ guide: true, author: { id: 'user' } });
  const otherBot = f.addMessage({ guide: true, author: { id: 'other-bot', bot: true } });
  await f.manager.refresh(f.channel);
  assert.equal(f.history.has(user.id), true);
  assert.equal(f.history.has(otherBot.id), true);
});

test('creates a missing guide once and cleans up legacy duplicate bot guides', async () => {
  const f = fixture();
  await f.manager.refresh(f.channel);
  await f.manager.refresh(f.channel);
  assert.equal(f.history.size, 1);
  f.addMessage({ guide: true });
  f.addMessage({ author: { id: 'user' } });
  await f.manager.refresh(f.channel);
  assert.equal([...f.history.values()].filter(message => message.embeds.length).length, 1);
});
