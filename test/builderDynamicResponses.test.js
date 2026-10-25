import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EmbedBuilder } from 'discord.js';
import { extractDefinitions } from '../src/services/embedDefinitionDiscoveryService.js';
import {
  applyRuntimeEmbedTemplateData,
  getSystemEmbedTemplateKey,
  primeSystemEmbedTemplateData,
  registerDiscoveredEmbedDefinition,
} from '../src/services/systemEmbedCatalogService.js';
import { db } from '../src/utils/database.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from '../src/services/cloudyBrandingService.js';
import { rememberBuilderRuntimePreview, hydrateBuilderPreviewRecord } from '../src/services/builderRuntimePreviewService.js';
import { collapseDisplayRecords, loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { buildMatches } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { buildBuilderEmbeds } from '../src/commands/Tools/embedbuilder.js';
import { infoEmbed, successEmbed, warningEmbed } from '../src/utils/embeds.js';

const values = new Map();
db.initialized = true;
db.useFallback = false;
db.db = { get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); return true; } };

test('beg discovery indexes both named outcomes instead of title-only Success and Warning cards', async () => {
  const source = await fs.readFile('src/commands/Economy/beg.js', 'utf8');
  const definitions = extractDefinitions(source, 'commands/Economy/beg.js').filter(item => item.kind === 'embed');
  assert.deepEqual(definitions.map(item => item.title).sort(), ['Begging Successful', 'Insufficient Funds']);
  assert.ok(definitions.every(item => item.description === '{dynamic}'));
});

test('helper discovery follows the runtime overload for a variable body and a one-argument notification', () => {
  for (const [name, helper, fallback] of [['warningEmbed', warningEmbed, 'Warning'], ['successEmbed', successEmbed, 'Success'], ['infoEmbed', infoEmbed, 'Information']]) {
    const title = 'Named response';
    const named = extractDefinitions(`${name}('${title}', actualBody)`, 'commands/Tools/example.js')[0];
    const notification = extractDefinitions(`${name}('Actual notification text')`, 'commands/Tools/example.js')[0];
    assert.equal(named.title, helper(title, 'The complete live body').toJSON().title);
    assert.equal(notification.title, fallback);
    assert.equal(notification.description, 'Actual notification text');
    const trailingComma = extractDefinitions(`${name}('Actual notification text',)`, 'commands/Tools/example.js')[0];
    assert.equal(trailingComma.title, helper('Actual notification text').toJSON().title);
    assert.equal(trailingComma.description, notification.description);
  }
});

test('other affected source responses retain their names when their contents are calculated', async () => {
  for (const [path, title] of [['Core/configWizard.js', 'Configuration Updated'], ['Economy/gamble.js', 'Gambling & Games'], ['Economy/games.js', 'Games'], ['Fun/fight.js', '🏆 Duel Complete!'], ['Reaction_roles/reactroles.js', 'Role Validation Warning'], ['Utility/todo.js', 'Your To-Do List']]) {
    const source = await fs.readFile(`src/commands/${path}`, 'utf8');
    const definitions = extractDefinitions(source, `commands/${path}`);
    assert.ok(definitions.some(item => item.kind === 'embed' && item.title === title), path);
    assert.ok(!definitions.some(item => ['Success', 'Information', 'Warning'].includes(item.title) && item.description === title), path);
  }
});

test('conditional title alternatives never become a concatenated phantom response', () => {
  const definitions = extractDefinitions("successEmbed(anonymous ? 'Staff message' : `Message from ${sender}`, body)", 'commands/Moderation/dm.js');
  assert.ok(!definitions.some(item => item.title === 'Staff messageMessage from {dynamic}'));
});

test('a whole variable body preserves every random begging result and formatted reward', () => {
  const context = 'gambling/beg-dynamic-test';
  for (const title of ['Insufficient Funds', 'Begging Successful']) {
    const key = getSystemEmbedTemplateKey('embed', title, '', context);
    registerDiscoveredEmbedDefinition({ kind: 'embed', context, title, description: '{dynamic}' });
    primeSystemEmbedTemplateData(key, context, { title: title.replace('Funds', 'funds'), description: '{dynamic}', color: 0xFCFFA1 });
    for (const description of ['The police chased you off. You got nothing.', "A squirrel stole the single coin you had.", 'A kind stranger drops **$125** into your cup.', 'Someone gave <@123456789012345678> **$150**!']) {
      const output = applyRuntimeEmbedTemplateData({ title, description }, { commandName: 'beg-dynamic-test' });
      assert.equal(output.description, description);
      assert.equal(output.title, title.replace('Funds', 'funds'));
    }
  }
});

test('an empty runtime body remains a valid title-only response through both template layers', async () => {
  const title = 'Optional live body';
  const context = 'gambling/empty-body-test';
  const key = getSystemEmbedTemplateKey('embed', title, '', context);
  registerDiscoveredEmbedDefinition({ kind: 'embed', context, title, description: '{dynamic}' });
  primeSystemEmbedTemplateData(key, context, { title, description: '{dynamic}' });
  const data = applyRuntimeEmbedTemplateData({ title }, { commandName: 'empty-body-test' });
  assert.equal(data.description, undefined);
  assert.equal(new EmbedBuilder(data).toJSON().title, title);
  await saveEmbedTemplateDecoration('empty-body-guild', 'empty-body-channel', [title], { title, description: '{dynamic}' });
  const outgoing = await applySavedResponsePayloadTemplates({ embeds: [data] }, { guildId: 'empty-body-guild', channelId: 'empty-body-channel' });
  assert.equal(outgoing.embeds[0].description, undefined);
  assert.equal(new EmbedBuilder(outgoing.embeds[0]).toJSON().title, title);
});

test('saved Insufficient funds styling appears once in search and in the full live preview', async () => {
  const guildId = 'funds-parity-guild';
  const channelId = 'funds-parity-channel';
  const guild = { id: guildId, channels: { cache: new Map([[channelId, { id: channelId, name: 'gambling' }]]) } };
  const original = { title: 'Insufficient Funds', description: 'The police chased you off. You got nothing.', color: 0xFCFFA1, fields: [{ name: 'Cash', value: '$100', inline: false }] };
  await saveEmbedTemplateDecoration(guildId, channelId, ['Insufficient Funds'], { title: 'Insufficient funds', description: '{dynamic}', color: 0x7A1712, fields: [] }, { applyFields: false });
  const outgoing = await applySavedResponsePayloadTemplates({ embeds: [original] }, { guildId, channelId, commandName: 'beg' });
  assert.equal(outgoing.embeds[0].title, 'Insufficient funds');
  assert.equal(outgoing.embeds[0].description, original.description);
  assert.deepEqual(outgoing.embeds[0].fields, original.fields);
  assert.equal(outgoing.embeds[0].color, 0x7A1712);
  await rememberBuilderRuntimePreview(outgoing, { guildId, channelId });
  const record = { guildId, channelId, messageId: 'catalog', source: 'system-catalog', title: 'Insufficient funds', name: 'Insufficient funds', snapshot: { title: 'Insufficient funds', description: '{dynamic}' } };
  const peers = [record, { ...record, messageId: 'peer', snapshot: { title: 'Insufficient Funds', description: '{dynamic}' } }];
  const matches = buildMatches(guild, peers, 'insufficient funds');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].document.title, 'Insufficient funds');
  const selected = collapseDisplayRecords(peers, channelId)[0];
  const preview = await hydrateBuilderPreviewRecord(guild, selected, null, 'user');
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, selected, preview, selected.sourceRecord), true);
  const data = buildBuilderEmbeds(state)[0].toJSON();
  assert.equal(data.title, 'Insufficient funds');
  assert.equal(data.description, original.description);
  assert.deepEqual(data.fields, original.fields);
  assert.equal(data.color, 0x7A1712);
});


test('new unsaved Cloudy replies and logs share Search title casing without changing body or decoration', async () => {
  const source = { guildId: 'title-parity-outgoing-guild', channelId: 'title-parity-outgoing-channel', commandName: 'welcome' };
  const original = {
    title: '✅ Welcome Ping Updated',
    description: 'Keep every original value and <@123456789012345678> mention',
    fields: [{ name: 'Member', value: '<@123456789012345678>', inline: true }],
    color: 0xFFFFFF,
    footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  };
  const output = await applySavedResponsePayloadTemplates({ embeds: [original] }, source);
  assert.equal(output.embeds[0].title, 'Welcome ping updated');
  assert.deepEqual({ ...output.embeds[0], title: original.title }, original);

  const log = await applySavedResponsePayloadTemplates({
    embeds: [{ title: '⚠️ PERMISSION DENIED', description: 'Action denied' }],
  }, { ...source, commandName: 'moderation' });
  assert.equal(log.embeds[0].title, 'Permission denied');
});

test('runtime title formatting does not rewrite ticket identifiers, dynamic wagers or manually Builder-posted embeds', async () => {
  const source = { guildId: 'title-parity-protected-guild', channelId: 'title-parity-protected-channel', commandName: 'ticket' };
  const protectedTitles = [
    'Ticket #123',
    'Blackjack — Bet $100',
    "<@123456789012345678>'s balance",
    'ZORP Guide',
    'Roll {dynamic}',
  ];
  const payload = { embeds: protectedTitles.map(title => ({ title, description: 'Keep runtime identity' })) };
  const output = await applySavedResponsePayloadTemplates(payload, source);
  assert.deepEqual(output.embeds.map(embed => embed.title), protectedTitles);

  const ownerTitle = '✅ OWNER CUSTOM TITLE';
  const manuallyPosted = { title: ownerTitle, description: 'Owner content',
    footer: { text: 'Own footer' + MESSAGE_BUILDER_FOOTER_MARKER } };
  const post = await applySavedResponsePayloadTemplates({ embeds: [manuallyPosted] }, source);
  assert.equal(post.embeds[0].title, ownerTitle, 'Builder-authored posts retain exact user styling');
  assert.deepEqual(post.embeds[0], manuallyPosted);
});
