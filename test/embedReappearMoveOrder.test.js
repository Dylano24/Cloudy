import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function fixture({ deleteFails = false, sendFails = false, every = 1, fetchFails = false, disableDuringDelete = false } = {}) {
  const source = readFileSync('src/events/messageCreate.js', 'utf8');
  const start = source.indexOf('async function handleEmbedReappear');
  const ruleKey = 'cloudy:embed-reappear:g:c:original';
  const values = new Map([
    ['cloudy:embed-reappear-index:g:c', ['original']],
    [ruleKey, { every, count: 0, messageId: 'old', embed: { title: 'Saved title' }, components: [] }],
  ]);
  const actions = [];
  const visible = new Set(['old']);
  let overlap = false;
  const get = async (key, fallback) => structuredClone(values.get(key) ?? fallback);
  const set = async (key, value) => { values.set(key, structuredClone(value)); return true; };
  const remove = async key => values.delete(key);
  const handle = new Function('getFromDb', 'setInDb', 'deleteFromDb', 'logger', 'setTimeout', `const reappearQueues = new Map(); ${source.slice(start)}; return handleEmbedReappear;`)(get, set, remove, { error() {} }, (callback, delay) => { actions.push('delay:' + delay); callback(); });
  let serial = 0;
  const channel = {
    id: 'c',
    messages: { fetch: async id => {
      if (fetchFails) throw new Error('Discord unavailable');
      return visible.has(id) ? { delete: async () => {
      actions.push('delete:' + id);
      if (deleteFails) throw new Error('delete failed');
      visible.delete(id);
      if (disableDuringDelete) values.set('cloudy:embed-reappear-disabled:g:c:original:0', { disabled: true });
    } } : null;
    } },
    async send(payload) {
      actions.push('send');
      assert.deepEqual(payload.embeds, [{ title: 'Saved title' }]);
      if (sendFails) throw new Error('send failed');
      if (visible.size) overlap = true;
      const id = 'new-' + ++serial;
      visible.add(id);
      return { id, delete: async () => visible.delete(id) };
    },
  };
  return { run: () => handle({ guild: { id: 'g' }, channel }), actions, visible, values, ruleKey, overlap: () => overlap, allowSend: () => { sendFails = false; } };
}

test('Reappear deletes the previous copy before sending the next', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.actions, ['delete:old', 'delay:2000', 'send']);
  assert.equal(f.overlap(), false);
  assert.equal(f.visible.size, 1);
});

test('failed deletion preserves the existing embed and sends no duplicate', async () => {
  const f = fixture({ deleteFails: true });
  await f.run();
  assert.deepEqual(f.actions, ['delete:old']);
  assert.deepEqual([...f.visible], ['old']);
});

test('failed sending keeps the rule ready for retry', async () => {
  const f = fixture({ sendFails: true });
  await f.run();
  assert.equal(f.values.get(f.ruleKey).count, 1);
  assert.deepEqual(f.values.get(f.ruleKey).embed, { title: 'Saved title' });
  f.allowSend();
  await f.run();
  assert.equal(f.visible.size, 1);
  assert.equal(f.values.get(f.ruleKey).count, 0);
});

test('Reappear retains the configured message count', async () => {
  const f = fixture({ every: 2 });
  await f.run();
  assert.deepEqual(f.actions, []);
  await f.run();
  assert.deepEqual(f.actions, ['delete:old', 'delay:2000', 'send']);
});

test('a lookup failure never creates a second visible copy', async () => {
  const f = fixture({ fetchFails: true });
  await f.run();
  assert.deepEqual(f.actions, []);
  assert.deepEqual([...f.visible], ['old']);
});

test('turning Reappear off during deletion prevents reposting', async () => {
  const f = fixture({ disableDuringDelete: true });
  await f.run();
  assert.deepEqual(f.actions, ['delete:old', 'delay:2000']);
  assert.equal(f.values.has(f.ruleKey), false);
});

test('simultaneous Reappear triggers do not stack copies', async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run(), f.run()]);
  assert.equal(f.overlap(), false);
  assert.equal(f.visible.size, 1);
  assert.equal(f.actions.filter(action => action === 'send').length, 3);
});
