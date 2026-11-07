import assert from 'node:assert/strict';
import test from 'node:test';

import { db } from '../src/utils/database.js';
import { getEmbedRegistry, registerCloudyEmbedMessage } from '../src/services/embedRegistryService.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { cleanupOrphanCatalogRegistry } from '../src/events/gamingCatalogDiagnosticReady.js';

// Builder admission (owner's choice): the automatic orphan cleanup removes a
// stored catalog row only when Discord proves its message is gone, keeps the
// owner's saved work as a template and never overwrites a Save at the same time.
const values = new Map();
function resetDb({ failKeys = [] } = {}) {
  values.clear();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => {
      if (failKeys.some(prefix => key.startsWith(prefix))) throw new Error('database offline');
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => { values.delete(key); return true; },
  };
}

const row = (guildId, messageId, title, extra = {}) => ({
  guildId, channelId: 'feature', backingChannelId: 'botlog', messageId, embedIndex: 0, source: 'system-catalog',
  title, name: title, createdAt: '2026-10-01T00:00:00.000Z',
  snapshot: { title, description: `${title} body`,
    author: { name: `Cloudy template key: embed-type:${messageId} || Cloudy context: botlog/${messageId} || Cloudy kind: embed` } },
  ...extra,
});

function guildWith(guildId, { gone = [], denied = [] } = {}) {
  const fetched = [];
  const botlog = {
    id: 'botlog',
    messages: {
      fetch: async id => {
        fetched.push(String(id));
        if (gone.includes(String(id))) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        if (denied.includes(String(id))) throw Object.assign(new Error('Missing Access'), { code: 50001 });
        return { id: String(id) };
      },
    },
  };
  return { guild: { id: guildId, channels: { cache: new Map([['botlog', botlog]]) } }, fetched };
}

test('only rows whose message is proven gone are removed; saved work stays as a template', async () => {
  resetDb();
  const guildId = 'orphan-protect-guild';
  values.set(`cloudy:system-embed-catalog:${guildId}`, ['100']);
  values.set(`cloudy:embed-registry:${guildId}`, [
    row(guildId, '100', 'Active catalog row'),
    row(guildId, '201', 'Old unchanged example'),
    row(guildId, '202', 'Explicitly saved', { manualSaved: true, explicitSave: true }),
    row(guildId, '203', 'Old save flag', { manualSaved: true }),
    row(guildId, '204', 'Saved colour only'),
    row(guildId, '205', 'Cannot check'),
  ]);
  await saveEmbedTemplateDecoration(guildId, 'feature', ['embed-type:204'], { title: 'Saved colour only', color: 0xFF0080 });
  const { guild, fetched } = guildWith(guildId, { gone: ['201', '202', '203', '204'], denied: ['205'] });
  const result = await cleanupOrphanCatalogRegistry(guild);
  assert.deepEqual(result, { removed: 1, detached: 3 });
  assert.ok(!fetched.includes('100'), 'an active catalog row is never checked or touched');
  const stored = values.get(`cloudy:embed-registry:${guildId}`);
  const byId = Object.fromEntries(stored.map(item => [item.messageId, item]));
  assert.equal(byId['201'], undefined, 'the proven-gone unchanged example is removed');
  for (const id of ['202', '203', '204']) {
    assert.equal(byId[id]?.detached, true, `saved work ${id} stays as a detached template`);
    assert.equal(byId[id].snapshot.title, row(guildId, id, byId[id].title).title);
  }
  assert.equal(byId['205']?.detached, undefined, 'missing access is no proof: kept as it was');
  assert.ok(byId['100']);
  assert.ok(![...values.keys()].some(key => key.startsWith('cloudy:embed-registry-deleted:')), 'no permanent tombstone');
});

test('an unreadable registry or catalog list changes nothing', async () => {
  const guildId = 'orphan-unreadable-guild';
  resetDb({ failKeys: [`cloudy:system-embed-catalog:${guildId}`] });
  const before = [row(guildId, '301', 'Old example')];
  values.set(`cloudy:embed-registry:${guildId}`, before);
  const { guild, fetched } = guildWith(guildId, { gone: ['301'] });
  assert.deepEqual(await cleanupOrphanCatalogRegistry(guild), { removed: 0, detached: 0 });
  assert.deepEqual(fetched, []);
  assert.deepEqual(values.get(`cloudy:embed-registry:${guildId}`), before);
});

test('a Save at the same moment is kept: the cleanup is queued with every other registry write', async () => {
  resetDb();
  const guildId = 'orphan-concurrent-save';
  values.set(`cloudy:system-embed-catalog:${guildId}`, ['400']);
  values.set(`cloudy:embed-registry:${guildId}`, [row(guildId, '400', 'Active'), row(guildId, '401', 'Old example')]);
  await getEmbedRegistry(guildId);
  const { guild } = guildWith(guildId, { gone: ['401'] });
  const post = {
    id: '1532882647838240001', guildId, channelId: 'general', client: { user: { id: 'bot' } }, author: { id: 'bot' },
    embeds: [{ title: 'My new post', description: 'Saved now', toJSON: () => ({ title: 'My new post', description: 'Saved now' }) }],
    components: [], createdAt: new Date('2026-11-07T07:00:00.000Z'), channel: { name: 'general' },
  };
  await Promise.all([
    cleanupOrphanCatalogRegistry(guild),
    registerCloudyEmbedMessage(post, 'embed-builder', { manualSave: true, manualSaveIndex: 0, explicitSave: true }),
  ]);
  const stored = values.get(`cloudy:embed-registry:${guildId}`);
  assert.ok(stored.some(item => item.messageId === post.id && item.explicitSave === true), 'the Save is kept');
  assert.ok(!stored.some(item => item.messageId === '401'), 'the gone example is removed');
  assert.ok(stored.some(item => item.messageId === '400'));
});
