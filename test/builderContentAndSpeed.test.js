import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/utils/database.js';
import { extractDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import { saveEmbedTemplateDecoration, warmSavedEmbedTemplateScopes, getCachedSavedEmbedTemplateData, decorateEmbedWithSavedTemplate } from '../src/services/embedTemplateService.js';
import { primeSystemSourceDefinitionPreview } from '../src/services/systemEmbedCatalogService.js';
import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { buildBuilderEmbeds } from '../src/commands/Tools/embedbuilder.js';
import { rememberBuilderRuntimePreview } from '../src/services/builderRuntimePreviewService.js';

const stored = new Map();
let reads = 0, writes = 0;
db.initialized = true; db.useFallback = false;
db.db = { get: async key => { reads++; return stored.get(key); }, set: async (key, data) => { writes++; stored.set(key, structuredClone(data)); return true; } };
const fields = [{ name: 'New Cash Balance', value: '$50', inline: true }, { name: 'New Bank Balance', value: '$150 / $500', inline: true }];

test('helper chains preserve all fields and footer without leaking the next embed fields', () => {
  const code = `const first = successEmbed('Deposit Successful', 'Full deposit text').addFields(
    { name: 'Cash', value: wallet, inline: true }, { name: 'Bank', value: bank, inline: false }
  ).setFooter({ text: 'Footer' });
  const second = successEmbed('Withdrawal', 'Withdraw text').addFields({name:'Other',value:'Different'});`;
  const entries = extractDefinitions(code, 'commands/Economy/deposit.js');
  const first = entries.find(item => item.title === 'Deposit Successful');
  assert.deepEqual(first.fields, [{ name: 'Cash', value: '{dynamic}', inline: true }, { name: 'Bank', value: '{dynamic}', inline: false }]);
  assert.equal(first.footer.text, 'Footer');
  assert.equal(entries.find(item => item.title === 'Withdrawal').fields[0].name, 'Other');
});

test('old empty-field saves retain complete runtime and source preview contents', async () => {
  const guild = 'legacy-content', channel = 'channel';
  stored.set(`cloudy:embed-template:${guild}:${channel}`, { 'deposit successful': { schemaVersion: 2, title: 'Deposit successful', description: 'You deposited **{dynamic}**.', fields: [], footer: null, color: 123 } });
  await warmSavedEmbedTemplateScopes(guild, [channel]);
  const original = { title: 'Deposit Successful', description: 'You deposited **$10**.', fields, footer: { text: 'Original footer' } };
  const runtime = getCachedSavedEmbedTemplateData(guild, channel, original).data;
  assert.deepEqual(runtime.fields, fields);
  assert.equal(runtime.footer.text, 'Original footer');
  primeSystemSourceDefinitionPreview({ kind: 'embed', title: original.title, description: 'You deposited **{dynamic}**.', fields, context: 'gambling/deposit' });
  const record = { guildId: guild, channelId: channel, messageId: 'message', embedIndex: 0, source: 'system-catalog', snapshot: { title: 'Deposit Successful', description: 'You deposited **{dynamic}**.', author: { name: 'Cloudy template key: embed:deposit || Cloudy context: gambling/deposit || Cloudy kind: embed' } } };
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, { id: guild }, record), true);
  const preview = buildBuilderEmbeds(state)[0].toJSON();
  assert.equal(preview.title, 'Deposit successful');
  assert.deepEqual(preview.fields, fields);
  const decorated = await decorateEmbedWithSavedTemplate(guild, channel, original);
  assert.deepEqual(decorated.embed.toJSON().fields, fields);
});

test('a title-only save preserves current body, dynamic field values and footer on all future replies', async () => {
  const base = { title: 'Details', description: 'Original message', fields, footer: { text: 'Original footer' } };
  await saveEmbedTemplateDecoration('changed-only', 'channel', ['Details'], { ...base, title: 'My title' }, { baseEmbedData: base });
  const future = { ...base, description: 'Current message', fields: [{ name: 'New Cash Balance', value: '$999', inline: true }], footer: { text: 'Current footer' } };
  const output = getCachedSavedEmbedTemplateData('changed-only', 'channel', future).data;
  assert.equal(output.title, 'My title');
  assert.equal(output.description, 'Current message');
  assert.deepEqual(output.fields, future.fields);
  assert.deepEqual(output.footer, future.footer);
  await saveEmbedTemplateDecoration('changed-only', 'channel', ['Details'], { ...base, title: 'My title', description: '', fields: [], footer: null }, { baseEmbedData: base });
  const removed = getCachedSavedEmbedTemplateData('changed-only', 'channel', future).data;
  assert.equal(removed.description, undefined);
  assert.equal(removed.fields, undefined);
  assert.equal(removed.footer, undefined);
});

test('old apply flags are honored consistently by cached and async decorators', async () => {
  stored.set('cloudy:embed-template:flags:channel', { details: { title: 'Renamed', description: null, fields: [], footer: null, applyDescription: false, applyFields: false, applyFooter: false } });
  await warmSavedEmbedTemplateScopes('flags', ['channel']);
  const input = { title: 'Details', description: 'Complete', fields, footer: { text: 'Footer' } };
  assert.equal(getCachedSavedEmbedTemplateData('flags', 'channel', input).data.description, 'Complete');
  const output = (await decorateEmbedWithSavedTemplate('flags', 'channel', input)).embed.toJSON();
  assert.deepEqual(output.fields, fields);
  assert.equal(output.footer.text, 'Footer');
});

test('concurrent cold template reads share one read per scope', async () => {
  const before = reads;
  await Promise.all(Array.from({ length: 20 }, () => warmSavedEmbedTemplateScopes('single-flight', ['channel'])));
  assert.equal(reads - before, 2);
});

test('identical preview captures do not repeat database writes', async () => {
  const before = writes;
  const payload = { embeds: [{ title: 'Repeated preview', description: 'Same full content', fields }] };
  await Promise.all(Array.from({ length: 20 }, () => rememberBuilderRuntimePreview(payload, { guildId: 'capture-speed', channelId: 'channel' })));
  assert.equal(writes - before, 1);
});
