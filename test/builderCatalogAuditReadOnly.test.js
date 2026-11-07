import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getSystemEmbedTemplateKey } from '../src/services/systemEmbedCatalogService.js';

const api = await import('../scripts/builder-catalog-audit.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

function exported(name) {
  assert.equal(typeof api[name], 'function', `Missing read-only audit function ${name}`);
  return api[name];
}

test('raw audit reads all discovered application tables in one read-only snapshot without normalizing owner data', async () => {
  const snapshot = exported('readAuditSnapshot');
  const queries = [];
  const owner = { key: 'cloudy:embed-registry:g', value: [{ source: 'embed-builder',
    snapshot: { title: '<a:custom:123456789012345678> My title', description: 'One  space\n\nTwo',
      color: 0x123456, image: {url: 'https://example.test/banner.gif'} }, explicitSave: true }] };
  const client = {async query(sql) {
    queries.push(sql);
    if (/pg_catalog.pg_tables/.test(sql)) return {rows: [{schemaname: 'public', tablename: 'temp_data'}, {schemaname: 'custom', tablename: 'guilds'}]};
    if (/SELECT \* FROM "public"\."temp_data"/.test(sql)) return {rows: [owner]};
    if (/SELECT \* FROM "custom"\."guilds"/.test(sql)) return {rows: [{id: 'g', config: {welcome: {enabled: true}}}]};
    return {rows: []};
  }};
  const value = await snapshot(client);
  assert.equal(value.complete, true);
  assert.deepEqual(value.tables[0].rows, [owner]);
  assert.equal(value.tables.length, 2);
  assert.match(queries[0], /^BEGIN .*REPEATABLE READ.*READ ONLY$/);
  assert.equal(queries.at(-1), 'COMMIT');
  assert.ok(queries.every(sql => !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/.test(sql)));
});

test('a failed raw audit rolls back and throws instead of exporting an empty successful backup', async () => {
  const snapshot = exported('readAuditSnapshot');
  const queries = [];
  const client = {async query(sql) { queries.push(sql); if (/pg_catalog.pg_tables/.test(sql)) throw new Error('connection interrupted'); return {rows: []}; }};
  await assert.rejects(snapshot(client), /connection interrupted/);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.ok(!queries.includes('COMMIT'));
});

test('the audit backup includes original GIF bytes and fails rather than replacing an existing export', async () => {
  const save = exported('writeAuditExport');
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-catalog-export-'));
  const mediaDir = path.join(dir, 'source');
  await mkdir(mediaDir);
  const gif = Buffer.from('GIF89a-original-owner-animation');
  await writeFile(path.join(mediaDir, 'original.gif'), gif);
  const file = path.join(dir, 'backup', 'snapshot.json');
  await save({formatVersion: 1, complete: true, tables: []}, file, {mediaDir});
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.media.files.length, 1);
  assert.equal(saved.media.files[0].path, 'original.gif');
  assert.equal(saved.media.files[0].sha256, '8982b14f155fa2637ea77514f97feb845737cec9920842147d6c0c6fe31da006');
  assert.deepEqual(await readFile(path.join(dir, 'backup', 'media', 'original.gif')), gif);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(save({formatVersion: 1, complete: true, tables: []}, file, {mediaDir}), /exist/i);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
});

test('an incomplete audit cannot be saved as a complete backup', async () => {
  const save = exported('writeAuditExport');
  const dir = await mkdtemp(path.join(tmpdir(), 'cloudy-catalog-incomplete-'));
  await assert.rejects(save({complete: false, tables: []}, path.join(dir, 'snapshot.json')), /incomplete/i);
});

test('offline analysis preserves saved overlays and original media while reporting exact retired examples per server', () => {
  const analyze = exported('analyzeAuditSnapshot');
  const title = 'Giveaway Deleted';
  const description = 'The giveaway and its message were removed.';
  const key = getSystemEmbedTemplateKey('embed', title, description, 'giveaway/gdelete');
  const original = {source: 'system-catalog', guildId: 'g', channelId: 'botlog', messageId: 'old', embedIndex: 0,
    snapshot: {title, description, color: 0xFFFFFF, footer: {text: '© Cloudy Inc. • Quality. Innovation. Performance.'},
      author: {name: `Cloudy template key: ${key} || Cloudy context: giveaway/gdelete || Cloudy kind: embed`}}};
  const own = {...structuredClone(original), messageId: 'mine'};
  own.snapshot.image = {url: 'https://example.test/owner.gif'};
  const snapshot = {complete: true, tables: [{name: 'temp_data', rows: [
    {key: 'cloudy:embed-registry:g', value: [original, own]},
    {key: 'cloudy:embed-builder-used-catalog:g', value: []},
  ]}]};
  const before = structuredClone(snapshot);
  const report = analyze(snapshot);
  assert.equal(report.canMutate, false);
  assert.deepEqual(report.counts, {show: 0, archive: 1, review: 1});
  assert.deepEqual(snapshot, before);
  snapshot.tables[0].rows[1].value = [key];
  assert.deepEqual(analyze(snapshot).counts, {show: 2, archive: 0, review: 0});
  snapshot.tables[0].rows[1].value = [];
  snapshot.tables[0].rows.push({key: 'cloudy:embed-template:g:global', value: {[key]: {canonicalIdentity: key, title: 'My saved wording'}}});
  assert.equal(analyze(snapshot).counts.archive, 0, 'exact saved overlays must survive even when the registry snapshot is older');
  snapshot.tables[0].rows.at(-1).value = {'giveaway deleted': {title: 'My renamed legacy template'}};
  assert.equal(analyze(snapshot).counts.archive, 0, 'a renamed legacy overlay is found by its original title alias');
});
