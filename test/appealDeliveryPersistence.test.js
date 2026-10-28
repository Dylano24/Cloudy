import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { registerAppealsApi } from '../src/web/appealsApi.js';

const validAppeal = {
  scope: 'discord',
  action: 'Ban',
  discordIdentity: 'valid-discord-member',
  email: 'appeal@example.com',
  punishmentReason: 'Action description',
  punishmentJustified: 'I understand',
  acceptanceReason: 'Please reconsider',
  futureChanges: 'Respect the rules',
};

function fixture(persistResult = false) {
  let sendCount = 0;
  let deleteCount = 0;
  let writeCount = 0;
  const channel = {
    id: 'appeals-channel',
    name: 'ban-timeout-appeals',
    type: 0,
    rawPosition: 1,
    guild: { id: 'guild-appeals' },
    isTextBased: () => true,
    async send() {
      sendCount++;
      return { id: 'appeal-message-id', async delete() { deleteCount++; } };
    },
  };
  const guild = { id: 'guild-appeals',
    channels: { cache: new Collection([[channel.id, channel]]), async fetch() {} },
  };
  const client = {
    isReady: () => true,
    channels: { cache: new Collection(), async fetch() { return null; } },
    guilds: { cache: new Collection([[guild.id, guild]]) },
    db: { async set() { writeCount++; return persistResult; } },
  };
  const routes = new Map();
  const app = { post(path, handler) { routes.set(path, handler); } };
  registerAppealsApi(app, client);
  const response = {
    code: 0, payload: null, headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.code = value; return this; },
    json(value) { this.payload = value; return this; },
  };
  const req = {
    get: name => name === 'x-cloudy-source' ? 'cloudy-store-appeal-v1' : null,
    body: structuredClone(validAppeal),
  };
  return {
    send: () => sendCount, removed: () => deleteCount, written: () => writeCount,
    async submit() { await routes.get('/api/appeals')(req, response); return response; },
  };
}

test('a failed appeal DB write rolls back the posted Discord message', async () => {
  const f = fixture(false);
  const res = await f.submit();
  assert.equal(res.code, 500);
  assert.equal(f.written(), 1);
  assert.equal(f.send(), 1);
  assert.equal(f.removed(), 1);
  assert.match(res.payload.error, /could not be delivered/i);
});

test('a successful appeal retains the review post and reports its case ID', async () => {
  const f = fixture(true);
  const res = await f.submit();
  assert.equal(res.code, 200);
  assert.equal(res.payload.ok, true);
  assert.match(res.payload.id, /^CLD-/);
  assert.equal(f.written(), 1);
  assert.equal(f.send(), 1);
  assert.equal(f.removed(), 0);
});
