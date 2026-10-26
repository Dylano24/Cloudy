import test from 'node:test';
import assert from 'node:assert/strict';
import { Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveNewBuilderDraft, saveModifiedEmbed, loadRecordSnapshotIntoState, getCanonicalBuilderRecords } from '../src/services/embedManagerService.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { buildPostedEmbeds, buildControls } from '../src/commands/Tools/embedbuilder.js';
import { buildAutocompleteMatches, buildMatches, buildSearchChoices } from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';
import { getEmbedTextLength } from '../src/utils/discordEmbedLimits.js';
import { hydrateBuilderMessageComponents } from '../src/services/embedBuilderButtonEditorService.js';
import { getEmbedRegistry, reconcileEmbedRegistry, registerCloudyEmbedMessage, relinkDetachedEmbedRegistryMessage } from '../src/services/embedRegistryService.js';

function fixture(t, suffix) {
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });
  const channelId = '123456789012345681';
  const channel = { id: channelId, name: 'general', permissionsFor: () => ({ has: () => true }) };
  const guild = { id: 'new-draft-' + suffix, channels: { cache: new Map([[channelId, channel]]) } };
  const state = { title: 'Saved notice <:cloudy:123456789012345678>', message: 'Owner contents',
    embedFields: [{ name: 'Saved field', value: 'Saved value', inline: true }],
    sideColor: 0x123456, showLogo: false, bottomLine: 'Owner footer',
    mediaUrl: 'https://example.com/saved.gif', reappearAfter: 3,
    componentRows: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open', url: 'https://example.com/' }] }] };
  return { storage, channelId, guild, state };
}

test('a private new draft survives a fresh registry load with full text, media, color, footer and buttons', async t => {
  const f = fixture(t, 'cold');
  f.state.message = 'x'.repeat(6600);
  f.state.mediaUrl = null;
  f.state.mediaName = 'converted.gif';
  f.state.mediaBuffer = Buffer.from('GIF89a-saved-owner-media');
  assert.equal((await saveNewBuilderDraft(f.guild, f.state, f.channelId)).ok, true);
  const cold = await import('../src/services/embedRegistryService.js?new-draft-restart');
  const [record] = await cold.getEmbedRegistry(f.guild.id);
  const reopened = {};
  assert.equal(loadRecordSnapshotIntoState(reopened, f.guild, record), true);
  for (const key of ['title', 'message', 'sideColor', 'bottomLine', 'reappearAfter', 'mediaName']) {
    assert.equal(reopened[key], f.state[key], key);
  }
  assert.deepEqual(reopened.mediaBuffer, f.state.mediaBuffer);
  assert.deepEqual(reopened.embedFields, f.state.embedFields);
  assert.deepEqual(reopened.componentRows, f.state.componentRows);
  assert.equal(reopened.showLogo, false);
  const posted = buildPostedEmbeds(reopened).map(embed => embed.toJSON());
  assert.deepEqual(posted[0].fields, f.state.embedFields);
  assert.ok(posted.length > 1, 'Save must retain text beyond the first Discord embed');
  assert.equal(posted.map(embed => embed.description || '').join(''), f.state.message);
  const choices = buildSearchChoices(buildMatches(f.guild, [record], 'saved notice'));
  assert.deepEqual(choices, [{ name: f.state.title, value: `${f.channelId}:${record.messageId}:0` }]);
  assert.ok(!buildControls(reopened).flatMap(row => row.toJSON().components).some(button => button.custom_id === 'simple_embed_repost'),
    'a never-published draft uses the existing Post button');
});

test('Post preserves saved draft fields within Discord limits before consuming the draft record', async t => {
  const f = fixture(t, 'post-fields');
  f.state.message = 'x'.repeat(1000);
  f.state.embedFields = Array.from({ length: 4 }, (_, index) => ({ name: `Keep ${index}`, value: 'v'.repeat(1000), inline: true }));
  await saveNewBuilderDraft(f.guild, f.state, f.channelId);
  const [record] = await getEmbedRegistry(f.guild.id);
  const reopened = {};
  loadRecordSnapshotIntoState(reopened, f.guild, record);
  reopened.message = 'x'.repeat(4096);
  const posted = buildPostedEmbeds(reopened);
  assert.deepEqual(posted[0].toJSON().fields, f.state.embedFields);
  assert.ok(posted.every(embed => getEmbedTextLength(embed) <= 6000));
  const message = { id: '123456789012345689', guildId: f.guild.id, channelId: f.channelId,
    embeds: [new Embed(posted[0].toJSON())], components: f.state.componentRows };
  await registerCloudyEmbedMessage(message, 'embed-builder', { manualSave: true });
  assert.equal(await relinkDetachedEmbedRegistryMessage(f.guild.id, record, message), true);
  const [persisted] = await getEmbedRegistry(f.guild.id);
  assert.deepEqual(persisted.snapshot.fields, f.state.embedFields);
  assert.equal(persisted.messageId, message.id);
});

test('saved private drafts need no Discord fetch for buttons or startup reconciliation', async t => {
  const f = fixture(t, 'local-only');
  f.guild.client = { user: { id: 'bot' } };
  let fetches = 0;
  f.guild.channels.cache.get(f.channelId).messages = { fetch: async () => { fetches++; return null; } };
  await saveNewBuilderDraft(f.guild, f.state, f.channelId);
  await hydrateBuilderMessageComponents(f.guild, f.state);
  await reconcileEmbedRegistry(f.guild);
  assert.equal(fetches, 0, 'a private saved draft has no Discord message to fetch');
  const [record] = await getEmbedRegistry(f.guild.id);
  assert.equal(record.draftData.message, f.state.message);
});

test('a saved draft at the Discord text limit posts without trimming its footer for a hidden marker', async t => {
  const f = fixture(t, 'post-limit');
  f.state.title = 'T';
  f.state.message = 'x';
  f.state.bottomLine = 'f'.repeat(993);
  f.state.embedFields = Array.from({ length: 5 }, () => ({ name: 'N', value: 'v'.repeat(1000), inline: false }));
  assert.equal((await saveNewBuilderDraft(f.guild, f.state, f.channelId)).ok, true);
  const posted = buildPostedEmbeds(f.state);
  assert.ok(posted.every(embed => getEmbedTextLength(embed) <= 6000));
  assert.equal(posted[0].toJSON().footer.text, f.state.bottomLine);
});

test('a new draft with a bot-template title keeps its own saved content and color', async t => {
  const f = fixture(t, 'overlay');
  f.state.title = 'Removed from builder';
  await saveEmbedTemplateDecoration(f.guild.id, f.channelId, ['Removed from builder'], {
    title: 'Owner renamed bot notice', description: 'Bot-only saved contents', color: 0xff0000,
  }, { sharedScope: true });
  assert.equal((await saveNewBuilderDraft(f.guild, f.state, f.channelId)).ok, true);
  const [record] = f.storage.get('cloudy:embed-registry:' + f.guild.id);
  const [canonical] = await getCanonicalBuilderRecords(f.guild, [record]);
  const reopened = {};
  loadRecordSnapshotIntoState(reopened, f.guild, canonical);
  assert.equal(reopened.title, 'Removed from builder');
  assert.equal(reopened.message, 'Owner contents');
  assert.equal(reopened.sideColor, 0x123456);
  const fillers = Array.from({ length: 80 }, (_, index) => ({ ...record,
    messageId: `other-${index}`, snapshot: { title: `Other saved notice ${index}` } }));
  const matches = buildAutocompleteMatches(f.guild, [...fillers, canonical], 'Removed from builder');
  assert.ok(matches.some(match => match.record.messageId === record.messageId),
    'the large-list shortlist must search the draft title, not a similarly named bot override');
});

test('a failed new draft write cannot report success or create a selected record', async t => {
  const f = fixture(t, 'failure');
  t.mock.method(db, 'set', async () => false);
  const saved = await saveNewBuilderDraft(f.guild, f.state, f.channelId);
  assert.equal(saved.ok, false);
  assert.equal(saved.reason, 'persistence-failed');
  assert.equal(f.state.modifyTarget, undefined);
});

test('a failed update to an unpublished draft never reports a Discord edit', async t => {
  const f = fixture(t, 'update-failure');
  await saveNewBuilderDraft(f.guild, f.state, f.channelId);
  t.mock.method(db, 'set', async () => false);
  f.state.message = 'Could not persist';
  const saved = await saveModifiedEmbed(f.guild, f.state);
  assert.equal(saved.ok, false);
  assert.notEqual(saved.discordUpdated, true);
});

test('editing during a new draft Save preserves the next unsaved editor contents', async t => {
  const f = fixture(t, 'concurrent-edit');
  t.mock.method(db, 'set', async (key, value) => {
    f.state.title = 'Next editor title';
    f.state.message = 'Next editor contents';
    f.storage.set(key, structuredClone(value));
    return true;
  });
  assert.equal((await saveNewBuilderDraft(f.guild, f.state, f.channelId)).ok, true);
  assert.equal(f.state.title, 'Next editor title');
  assert.equal(f.state.message, 'Next editor contents');
  const [record] = f.storage.get('cloudy:embed-registry:' + f.guild.id);
  assert.equal(record.snapshot.title, 'Saved notice <:cloudy:123456789012345678>');
  assert.equal(record.snapshot.description, 'Owner contents');
});
