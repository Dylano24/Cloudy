import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  projectCatalogTemplatesToFeatureChannels,
  buildEmbedPayload,
  loadRecordSnapshotIntoState,
} from '../src/services/embedManagerService.js';
import { isUsableMessage } from '../src/services/embedMissingChannelService.js';

const channel = (id, name) => ({
  id, name, type: 0, rawPosition: 1, messages: { fetch: async () => new Map() },
  toString: () => '#' + name,
});
const author = key => ({
  name: 'Cloudy template key: ' + key + ' || Cloudy context: general/notices || Cloudy kind: embed',
});
const guild = { id: 'origin-channel-case', channels: { cache: new Map([
  ['welcome', channel('welcome', 'welcome')],
  ['general', channel('general', 'general')],
  ['botlog', channel('botlog', 'botlog')],
]) } };
const catalog = {
  guildId: guild.id, channelId: 'botlog', backingChannelId: 'botlog',
  messageId: 'catalog-001', source: 'system-catalog', name: 'Too fast',
  snapshot: { title: 'Too fast', description: 'Bot notification', author: author('rate-limit') },
};
const message = (id, extra={}) => ({
  id, guildId: guild.id, channelId: 'general', author: { id: 'bot' },
  embeds: [{ title: 'Too fast', description: 'Runtime notice' }],
  components: [], flags: { has: () => false }, ...extra,
});

test('unsaved runtime source templates cannot be projected from Search to a channel menu', () => {
  const unsaved = [
    catalog,
    { ...catalog, messageId: 'catalog-002', snapshot: {
      title: 'Content creators', description: 'Command output', author: author('content-creators'),
    } },
  ];
  assert.deepEqual(projectCatalogTemplatesToFeatureChannels(guild, unsaved), []);
  assert.equal(buildEmbedPayload(guild, unsaved, 'general').components[0].components[0]?.data?.options?.length || 0, 0,
    'Search-only catalog templates should not become channel options');
});

test('explicitly saved source master keeps its authoritative origin and cannot be moved to the Builder invocation channel', () => {
  const saved = {
    ...catalog, channelId: 'general', backingChannelId: 'botlog', manualSaved: true,
    snapshot: { ...catalog.snapshot, title: 'Saved general notice' },
  };
  const [projected] = projectCatalogTemplatesToFeatureChannels(guild, [saved]);
  assert.equal(projected.channelId, 'general');
  assert.equal(projected.backingChannelId, 'botlog');
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, projected), true);
  assert.equal(state.modifyTarget.channelId, 'general');
  assert.equal(state.modifyTarget.backingChannelId, 'botlog');
  assert.notEqual(state.modifyTarget.channelId, 'welcome',
    'opening /embedbuilder in #welcome never changes the source channel');
});

test('opening Search or preview never makes ordinary bot notifications into browseable posts', () => {
  assert.equal(isUsableMessage(message('rate-limit'), 'bot'), false);
  assert.equal(isUsableMessage(message('slash', { interactionMetadata: { id: 'slash-command' } }), 'bot'), false);
  assert.equal(isUsableMessage(message('posted', {
    embeds: [{ title: 'My explicit Builder post', footer: { text: 'Cloudy custom\u200B' } }],
  }), 'bot'), true);
});

test('opening Search only saves for the loaded record origin, never the Builder invocation channel', () => {
  const source = fs.readFileSync('src/services/embedManagerService.js', 'utf8');
  const start = source.indexOf('export function loadRecordSnapshotIntoState(');
  const end = source.indexOf('\nexport async function syncBuilderLogoFromLiveMessage', start);
  const code = source.slice(start, end);
  assert.match(code, /channelId: logicalChannelId/);
  assert.doesNotMatch(code, /interaction\.channelId/);
  assert.match(source, /saveEmbedTemplateDecoration\(\s*guild\.id,\s*target\.channelId,/);
});

test('Search uses saved registry snapshot first without compulsory live-fetch latency', () => {
  const source = fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js', 'utf8');
  const start = source.indexOf('export async function loadEmbedBuilderSearchSelection(');
  const end = source.indexOf('\nexport async function hydrateLiveSearchRecord', start);
  const section = source.slice(start, end);
  assert.match(section, /record\.manualSaved\s*===\s*true/);
  assert.match(section, /record\.snapshot/);
});
