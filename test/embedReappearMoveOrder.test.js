import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalGamblingGuideEmbedData } from '../src/services/dedicatedChannelService.js';

function fixture({ deleteFails = false, sendFails = false, every = 1, fetchFails = false, disableDuringDelete = false, gamblingGuide = false } = {}) {
  const source = readFileSync('src/events/messageCreate.js', 'utf8');
  const start = source.indexOf('async function handleEmbedReappear');
  const ruleKey = 'cloudy:embed-reappear:g:c:original';
  const savedEmbed = gamblingGuide
    ? { title: 'Games & economy', description: 'Customized guide wording', color: 0xFFFFFF }
    : { title: 'Saved title' };
  const values = new Map([
    ['cloudy:embed-reappear-index:g:c', ['original']],
    [ruleKey, { every, count: 0, messageId: 'old', embed: savedEmbed, components: [] }],
  ]);
  const actions = [];
  const visible = new Set(['old']);
  let overlap = false;
  const get = async (key, fallback) => structuredClone(values.get(key) ?? fallback);
  const set = async (key, value) => { values.set(key, structuredClone(value)); return true; };
  const remove = async key => values.delete(key);
  const moves = [];
  const reappearIdentity = {
    lock: async () => () => {},
    beginMove: (_guildId, _channelId, messageId) => { actions.push('guard:' + messageId); return () => actions.push('release:' + messageId); },
    move: async (_guildId, _channelId, from, sent) => { moves.push([from, sent.id]); return true; },
    ownedPayload: payload => payload,
    rememberOwned: () => {},
  };
  const handle = new Function('getFromDb', 'setInDb', 'deleteFromDb', 'logger', 'setTimeout', 'reappearIdentity', 'canonicalGamblingGuideEmbedData', `const reappearQueues = new Map(); ${source.slice(start)}; return handleEmbedReappear;`)(get, set, remove, { error() {}, warn() {}, info() {} }, (callback, delay) => { actions.push('delay:' + delay); callback(); }, reappearIdentity, canonicalGamblingGuideEmbedData);
  let serial = 0;
  const channel = {
    id: 'c',
    name: gamblingGuide ? '🎲｜gambling' : 'general',
    messages: { fetch: async id => {
      if (fetchFails) throw new Error('Discord unavailable');
      return visible.has(id) ? {
        embeds: gamblingGuide ? [{ toJSON: () => ({ ...savedEmbed }) }] : [],
        components: [],
        delete: async () => {
      actions.push('delete:' + id);
      if (deleteFails) throw new Error('delete failed');
      visible.delete(id);
      if (disableDuringDelete) values.set('cloudy:embed-reappear-disabled:g:c:original:0', { disabled: true });
    } } : null;
    } },
    async send(payload) {
      actions.push('send');
      assert.deepEqual(payload.embeds, [gamblingGuide
        ? { ...savedEmbed, title: 'Games & Economy' }
        : { title: 'Saved title' }]);
      if (sendFails) throw new Error('send failed');
      if (visible.size) overlap = true;
      const id = 'new-' + ++serial;
      visible.add(id);
      return { id, delete: async () => visible.delete(id) };
    },
  };
  return { run: () => handle({ guild: { id: 'g' }, channel }), actions, visible, values, ruleKey, moves, overlap: () => overlap, allowSend: () => { sendFails = false; } };
}

test('Reappear deletes the previous copy before sending the next', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.actions, ['guard:old', 'delete:old', 'delay:2000', 'send', 'release:old']);
  assert.equal(f.overlap(), false);
  assert.equal(f.visible.size, 1);
  assert.deepEqual(f.moves, [['old', 'new-1']], 'the registry identity follows the moved message');
  assert.deepEqual(f.values.get(f.ruleKey).previousMessageIds, ['old'],
    'the rule remembers every former physical ID of this embed');
});

test('failed deletion preserves the existing embed and sends no duplicate', async () => {
  const f = fixture({ deleteFails: true });
  await f.run();
  assert.deepEqual(f.actions, ['guard:old', 'delete:old', 'release:old']);
  assert.deepEqual([...f.visible], ['old']);
  assert.deepEqual(f.moves, []);
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
  assert.deepEqual(f.actions, ['guard:old', 'delete:old', 'delay:2000', 'send', 'release:old']);
});

test('old deleted Yess never reappears when a new Test is posted in general', async () => {
  const f = fixture();
  f.visible.delete('old'); // The owner already deleted the old Yess.
  f.visible.add('new-test'); // Different, newly posted Test stays untouched.
  await f.run();
  assert.deepEqual(f.actions, [], 'no old content may be posted');
  assert.deepEqual([...f.visible], ['new-test']);
  assert.equal(f.values.has(f.ruleKey), false, 'orphan reappear rule is removed');
  assert.deepEqual(f.values.get('cloudy:embed-reappear-index:g:c'), []);
  assert.ok(f.values.get('cloudy:embed-reappear-disabled:g:c:original:0'));
});

test('a permanent Builder Delete also stops a legacy Yess Reappear rule', async () => {
  const f = fixture();
  f.visible.add('new-test');
  f.values.set('cloudy:embed-registry-deleted:g', ['c:original']);
  await f.run();
  assert.equal(f.values.has(f.ruleKey), false);
  assert.ok(f.values.get('cloudy:embed-reappear-disabled:g:c:original:0'));
  assert.deepEqual([...f.visible], ['new-test'], 'clean only old physical Yess');
  assert.equal(f.actions.includes('send'), false, 'never recreate a deleted embed');
});

test('missing old physical message is retired without sending its stored template', async () => {
  const f = fixture();
  f.visible.delete('old');
  await f.run();
  assert.equal(f.actions.includes('send'), false);
  assert.equal(f.values.has(f.ruleKey), false);
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
  assert.deepEqual(f.actions, ['guard:old', 'delete:old', 'delay:2000', 'release:old']);
  assert.equal(f.values.has(f.ruleKey), false);
});

test('simultaneous Reappear triggers do not stack copies', async () => {
  const f = fixture();
  await Promise.all([f.run(), f.run(), f.run()]);
  assert.equal(f.overlap(), false);
  assert.equal(f.visible.size, 1);
  assert.equal(f.actions.filter(action => action === 'send').length, 3);
});

test('Reappear sends Gambling guide in uppercase from stale live and saved snapshots', async () => {
  const f = fixture({ gamblingGuide: true });
  await f.run();
  assert.equal(f.visible.size, 1);
  assert.equal(f.values.get(f.ruleKey).embed.title, 'Games & Economy');
  assert.ok(f.actions.includes('send'));
});
