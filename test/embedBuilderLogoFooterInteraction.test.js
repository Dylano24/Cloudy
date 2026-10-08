import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { loadRecordSnapshotIntoState, saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { buildBuilderEmbeds, buildControls, queueBuilderRefresh, refreshBuilderLogo } from '../src/commands/Tools/embedbuilder.js';
import { CLOUDY_LOGO_URL } from '../src/services/cloudyLogoService.js';

function reopen(snapshot, id) {
  const state = {};
  const record = {
    guildId: 'builder-logo-regression-guild',
    channelId: 'builder-logo-regression-channel',
    messageId: id,
    embedIndex: 0,
    source: 'embed-builder',
    title: snapshot.title,
    snapshot,
  };
  assert.equal(loadRecordSnapshotIntoState(
    state, { id: record.guildId }, record,
  ), true);
  return state;
}

test('saved embed without a C logo or footer reopens without silently adding the C', () => {
  const state = reopen({
    title: 'Logo free message',
    description: 'Manually saved without a thumbnail or footer',
  }, 'logo-free-1');

  assert.equal(state.showLogo, false);
  assert.equal(state.removeExistingLogo, false);
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail, undefined);
});

test('reopening a saved Cloudy thumbnail retains Add/Remove logo state', () => {
  const state = reopen({
    title: 'Logo enabled message',
    description: 'Keep the Cloudy thumbnail',
    thumbnail: { url: CLOUDY_LOGO_URL },
  }, 'logo-on-1');

  assert.equal(state.showLogo, true);
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail?.url, CLOUDY_LOGO_URL);
});

test('Builder logo clicks and footer submit acknowledge before changing preview state', () => {
  const source = fs.readFileSync('src/commands/Tools/embedbuilder.js', 'utf8');
  const collect = source.slice(source.indexOf("case 'simple_embed_logo':"), source.indexOf("case 'simple_embed_footer':"));
  assert.match(collect, /case 'simple_embed_logo':\s*await buttonInteraction\.deferUpdate\(\);\s*state\.showLogo = true/);
  assert.match(collect, /case 'simple_embed_remove_logo':\s*await buttonInteraction\.deferUpdate\(\);\s*state\.showLogo = false/);

  const footer = source.slice(source.indexOf('async function editBottomLine('), source.indexOf('async function editMedia('));
  assert.match(footer, /await submitted\.deferUpdate\(\);\s*state\.bottomLine =/);
  assert.match(footer, /await refreshBuilderPreviewOnly\(submitted, state\)/);

  const content = source.slice(source.indexOf('async function editContent('), source.indexOf('async function editBottomLine('));
  assert.match(content, /await submitted\.deferUpdate\(\);\s*state\.title =/);

  const media = source.slice(source.indexOf('async function editMedia('), source.indexOf('async function getSharedOwnerGuilds('));
  assert.match(media, /await submitted\.deferUpdate\(\);\s*if \(mediaKind === 'video'\)/);

  const clearMedia = source.slice(source.indexOf("case 'simple_embed_clear_media':"), source.indexOf("case 'simple_embed_buttons':"));
  assert.match(clearMedia, /await buttonInteraction\.deferUpdate\(\);\s*state\.mediaUrl = null/);
  const reset = source.slice(source.indexOf("case 'simple_embed_reset':"), source.indexOf('default:', source.indexOf("case 'simple_embed_reset':")));
  assert.match(reset, /await buttonInteraction\.deferUpdate\(\);\s*await cleanupBuilderButtonUi/);

  const controls = source.slice(source.indexOf('function buildControls('), source.indexOf('function getPreviewUpdateQueue('));
  assert.match(controls, /const hasLogo = Boolean\(buildPreviewEmbed\(state\)\.toJSON\(\)\.thumbnail\?\.url\)/);
  assert.match(controls, /setCustomId\('simple_embed_remove_logo'\)[\s\S]*?setDisabled\(!hasLogo\)/);
});

function assertLogoButtons(state, { canAdd, canRemove }) {
  const row = buildControls(state)[1].toJSON();
  const add = row.components.find(button => button.custom_id === 'simple_embed_logo');
  const remove = row.components.find(button => button.custom_id === 'simple_embed_remove_logo');
  assert.ok(add, 'Add logo control exists');
  assert.ok(remove, 'Remove logo control exists');
  assert.equal(add.disabled, !canAdd, 'Add logo follows the visible thumbnail');
  assert.equal(remove.disabled, !canRemove, 'Remove logo follows the visible thumbnail');
}

test('Add and Remove logo buttons always follow the actual preview', () => {
  const state = {
    title: 'Logo controls',
    message: 'Test message',
    sideColor: 0xffffff,
    showLogo: true,
    removeExistingLogo: false,
    bottomLine: null,
  };

  assertLogoButtons(state, { canAdd: false, canRemove: true });
  state.showLogo = false;
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail, undefined);
  assertLogoButtons(state, { canAdd: true, canRemove: false });

  state.showLogo = true;
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail?.url, CLOUDY_LOGO_URL);
  assertLogoButtons(state, { canAdd: false, canRemove: true });
});

test('Existing embed with a visible thumbnail always permits Remove logo', () => {
  const state = {
    title: 'Existing thumbnail',
    message: 'Test message',
    sideColor: 0xffffff,
    showLogo: false,
    removeExistingLogo: false,
    bottomLine: null,
    modifyTarget: {
      sourceEmbedData: {
        title: 'Existing thumbnail',
        thumbnail: { url: 'https://example.com/existing-thumbnail.png' },
      },
    },
  };

  // An existing thumbnail may differ from the default Cloudy URL.
  assertLogoButtons(state, { canAdd: false, canRemove: true });
  state.removeExistingLogo = true;
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail, undefined);
  assertLogoButtons(state, { canAdd: true, canRemove: false });

  state.showLogo = true;
  state.removeExistingLogo = false;
  state.logoTouched = true;
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail?.url, CLOUDY_LOGO_URL);
  assertLogoButtons(state, { canAdd: false, canRemove: true });
});

test('Logo button refresh edits the original live preview and updates controls', async () => {
  const previews = [];
  const controls = [];
  let botPreviewEdits = 0;
  const state = {
    title: 'Logo live preview',
    message: 'Test',
    sideColor: 0xffffff,
    showLogo: true,
    removeExistingLogo: false,
    bottomLine: null,
    componentRows: [],
    builderBotManaged: true,
    builderPreviewUnavailable: false,
    builderMessage: { edit: async () => { botPreviewEdits += 1; } },
    builderDashboardMessageId: 'test-dashboard',
    builderDashboardMessage: {
      edit: async payload => {
        controls.push(payload.components[1].toJSON());
      },
    },
  };
  const originalSlashInteraction = {
    editReply: async payload => {
      previews.push(payload.embeds[0].toJSON().thumbnail?.url || null);
    },
  };

  await queueBuilderRefresh(originalSlashInteraction, state, true, true);
  assert.equal(previews.at(-1), CLOUDY_LOGO_URL);
  assert.equal(controls.at(-1).components[0].disabled, true);
  assert.equal(controls.at(-1).components[1].disabled, false);

  state.showLogo = false;
  state.removeExistingLogo = true;
  await queueBuilderRefresh(originalSlashInteraction, state, true, true);
  assert.equal(previews.at(-1), null);
  assert.equal(controls.at(-1).components[0].disabled, false);
  assert.equal(controls.at(-1).components[1].disabled, true);
  assert.equal(botPreviewEdits, 0, 'Logo actions target the original reply directly');
});

test('Logo preview falls back to bot message edit if original reply edit fails', async () => {
  let fallbackLogo;
  const state = {
    title: 'Fallback preview',
    message: 'Test',
    sideColor: 0xffffff,
    showLogo: false,
    removeExistingLogo: true,
    bottomLine: null,
    componentRows: [],
    builderBotManaged: true,
    builderPreviewUnavailable: false,
    builderMessage: {
      edit: async payload => { fallbackLogo = payload.embeds[0].toJSON().thumbnail?.url || null; },
    },
  };
  const originalSlashInteraction = {
    editReply: async () => { throw new Error('Expired interaction token'); },
  };

  assert.equal(await queueBuilderRefresh(originalSlashInteraction, state, true, true), true);
  assert.equal(fallbackLogo, null);
  state.showLogo = true;
  state.removeExistingLogo = false;
  assert.equal(await queueBuilderRefresh(originalSlashInteraction, state, true, true), true);
  assert.equal(fallbackLogo, CLOUDY_LOGO_URL);
});

test('logo clicks use the same fixed preview message edit path as the working footer', async () => {
  const updates = [];
  const state = {
    title: 'Logo preview',
    message: 'Visible',
    embedFields: [],
    sideColor: 0xffffff,
    bottomLine: 'Leave the footer intact',
    showLogo: true,
    removeExistingLogo: false,
    builderBotManaged: true,
    builderPreviewUnavailable: false,
    builderMessage: {
      id: 'original-preview',
      edit: async payload => {
        updates.push({ type: 'preview', id: 'original-preview', payload });
        return { id: 'original-preview' };
      },
    },
    builderDashboardMessageId: 'builder-dashboard',
    builderDashboardMessage: {
      id: 'builder-dashboard',
      edit: async payload => {
        updates.push({ type: 'dashboard', id: 'builder-dashboard', payload });
        return null;
      },
    },
  };
  const dashboardInteraction = {
    editReply: async () => {
      assert.fail('a dashboard interaction must not edit its own reply for the top preview');
    },
  };

  assert.equal(await refreshBuilderLogo(dashboardInteraction, state), true);
  assert.deepEqual(updates.map(item => item.type), ['preview', 'dashboard']);
  assert.equal(updates[0].payload.embeds[0].toJSON().thumbnail?.url, CLOUDY_LOGO_URL);

  updates.length = 0;
  state.showLogo = false;
  state.removeExistingLogo = true;
  state.logoTouched = true;
  assert.equal(await refreshBuilderLogo(dashboardInteraction, state), true);
  assert.deepEqual(updates.map(item => item.type), ['preview', 'dashboard']);
  assert.equal(updates[0].payload.embeds[0].toJSON().thumbnail, undefined);
  assert.equal(updates[0].payload.embeds[0].toJSON().footer.text, 'Leave the footer intact');
  assert.equal(updates[1].payload.components[1].toJSON().components[0].disabled, false);
  assert.equal(updates[1].payload.components[1].toJSON().components[1].disabled, true);

  updates.length = 0;
  state.showLogo = true;
  state.removeExistingLogo = false;
  assert.equal(await refreshBuilderLogo(dashboardInteraction, state), true);
  assert.equal(updates[0].payload.embeds[0].toJSON().thumbnail?.url, CLOUDY_LOGO_URL);
  assert.equal(updates[1].payload.components[1].toJSON().components[0].disabled, true);
  assert.equal(updates[1].payload.components[1].toJSON().components[1].disabled, false);
});

test('reopened manually saved logo-free embed does not inherit logo from preview peer', () => {
  const saved = {
    guildId: 'regression-manual-no-logo-20261008',
    channelId: 'regression-manual-no-logo-channel',
    messageId: 'saved-no-logo',
    embedIndex: 0,
    source: 'embed-builder',
    title: 'Manually saved custom embed no logo',
    snapshot: { title: 'Manually saved custom embed no logo', description: 'Saved without logo' },
  };
  const olderPreviewPeer = {
    ...saved,
    messageId: 'stale-peer',
    snapshot: {
      title: saved.title,
      thumbnail: { url: CLOUDY_LOGO_URL },
    },
  };
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, { id: saved.guildId }, saved, olderPreviewPeer), true);
  assert.equal(state.showLogo, false);
  assert.equal(state.logoTouched, false);
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail, undefined);
  const row = buildControls(state)[1].toJSON();
  assert.equal(row.components[0].disabled, false);
  assert.equal(row.components[1].disabled, true);
});

test('saving a deliberate no-logo choice replaces a previously saved logo decoration', async () => {
  const { db } = await import('../src/utils/database.js');
  const { saveEmbedTemplateDecoration, getCachedSavedEmbedTemplateData } =
    await import('../src/services/embedTemplateService.js');
  const data = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => data.get(key) ?? null,
    set: async (key, value) => { data.set(key, structuredClone(value)); return true; },
  };

  const guildId = 'logo-remove-template-regression-20261008';
  const channelId = 'logo-remove-template-channel';
  const title = 'Persistent logo preference regression';
  const aliases = [title];

  assert.equal(await saveEmbedTemplateDecoration(
    guildId, channelId, aliases,
    { title, thumbnail: { url: CLOUDY_LOGO_URL } },
    { sharedScope: true, applyThumbnail: true },
  ), true);
  assert.equal(getCachedSavedEmbedTemplateData(
    guildId, channelId, { title },
  ).data.thumbnail?.url, CLOUDY_LOGO_URL);

  assert.equal(await saveEmbedTemplateDecoration(
    guildId, channelId, aliases,
    { title },
    { sharedScope: true, applyThumbnail: true },
  ), true);
  assert.equal(getCachedSavedEmbedTemplateData(
    guildId, channelId, { title, thumbnail: { url: CLOUDY_LOGO_URL } },
  ).data.thumbnail, undefined, 'old template logo cannot return after an explicit removal');

  assert.equal(await saveEmbedTemplateDecoration(
    guildId, channelId, aliases,
    { title, description: 'Edited text with no logo' },
    { sharedScope: true, applyThumbnail: false },
  ), true);
  assert.equal(getCachedSavedEmbedTemplateData(
    guildId, channelId, { title, thumbnail: { url: CLOUDY_LOGO_URL } },
  ).data.thumbnail, undefined, 'unrelated later Save preserves the no-logo preference');
});

test('a visible Discord-hosted custom logo is recognized without replacing its URL', () => {
  const customLogo = 'https://cdn.discordapp.com/attachments/123/456/a-special-visible-logo.png';
  const state = reopen({
    title: 'Recognize this thumbnail',
    description: 'Already visible in Discord',
    thumbnail: { url: customLogo },
  }, 'custom-logo-existing');

  assert.equal(state.showLogo, true);
  assert.equal(state.logoTouched, false);
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail?.url, customLogo);
  assertLogoButtons(state, { canAdd: false, canRemove: true });

  state.showLogo = false;
  state.removeExistingLogo = true;
  state.logoTouched = true;
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail, undefined);
  assertLogoButtons(state, { canAdd: true, canRemove: false });

  state.showLogo = true;
  state.removeExistingLogo = false;
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail?.url, CLOUDY_LOGO_URL);
  assertLogoButtons(state, { canAdd: false, canRemove: true });
});

test('Search uses the actual visible peer thumbnail, not the stale catalog source', () => {
  const record = {
    guildId: 'visible-peer-guild',
    channelId: 'visible-peer-channel',
    messageId: 'source-no-logo',
    source: 'system-catalog',
    embedIndex: 0,
    title: 'Logo in live peer',
    snapshot: { title: 'Logo in live peer', description: 'Source has no thumbnail' },
  };
  const peer = {
    ...record,
    messageId: 'live-peer-with-logo',
    snapshot: {
      title: 'Logo in live peer',
      description: 'Visible peer',
      thumbnail: { url: CLOUDY_LOGO_URL },
    },
  };
  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, { id: record.guildId }, record, peer), true);
  assert.equal(state.showLogo, true);
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail?.url, CLOUDY_LOGO_URL);
  assertLogoButtons(state, { canAdd: false, canRemove: true });

  state.showLogo = false;
  state.removeExistingLogo = true;
  state.logoTouched = true;
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().thumbnail, undefined);
  assertLogoButtons(state, { canAdd: true, canRemove: false });
});

test('a manual Save keeps the visible logo until it is explicitly removed, then never restores it', async () => {
  const { Embed } = await import('discord.js');
  const { db } = await import('../src/utils/database.js');
  const kv = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async key => kv.get(key) ?? null,
    set: async (key, value) => { kv.set(key, structuredClone(value)); return true; },
    delete: async key => kv.delete(key),
    list: async prefix => [...kv.keys()].filter(key => key.startsWith(prefix)),
  };

  const guildId = 'save-visible-logo-20261008';
  const channelId = 'save-visible-logo-channel';
  const message = {
    id: 'save-visible-logo-message', guildId, channelId,
    author: { id: 'bot' }, flags: { has: () => false },
    embeds: [new Embed({
      title: 'Logo save regression',
      description: 'Body remains unchanged',
      thumbnail: { url: 'https://cdn.discordapp.com/attachments/123/456/a-visible-logo.png' },
    })],
  };
  message.edit = async payload => {
    message.embeds = payload.embeds.map(data => new Embed(data));
    return message;
  };
  const channel = {
    id: channelId,
    name: 'test-channel',
    messages: {
      cache: new Map([[message.id, message]]),
      fetch: async () => message,
    },
  };
  message.channel = channel;
  const guild = {
    id: guildId, client: { user: { id: 'bot' } },
    channels: {
      cache: new Map([[channelId, channel]]),
      fetch: async () => channel,
    },
  };
  const record = () => ({
    guildId, channelId, messageId: message.id, source: 'embed-builder',
    embedIndex: 0, snapshot: message.embeds[0].toJSON(),
  });

  const state = {};
  assert.equal(loadRecordSnapshotIntoState(state, guild, record()), true);
  assert.equal(state.showLogo, true);
  const savedLogo = message.embeds[0].thumbnail.url;
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal(message.embeds[0].thumbnail.url, savedLogo, 'Save without Add must keep custom logo');

  state.showLogo = false;
  state.removeExistingLogo = true;
  state.logoTouched = true;
  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  assert.equal(message.embeds[0].thumbnail, null);

  const reopened = {};
  assert.equal(loadRecordSnapshotIntoState(reopened, guild, record()), true);
  assert.equal(reopened.showLogo, false);
  assert.equal(buildBuilderEmbeds(reopened)[0].toJSON().thumbnail, undefined);
  assertLogoButtons(reopened, { canAdd: true, canRemove: false });

  assert.equal((await saveModifiedEmbed(guild, reopened)).ok, true);
  assert.equal(message.embeds[0].thumbnail, null, 'another Save never re-adds the logo');

  reopened.showLogo = true;
  reopened.removeExistingLogo = false;
  reopened.logoTouched = true;
  assert.equal((await saveModifiedEmbed(guild, reopened)).ok, true);
  assert.equal(message.embeds[0].thumbnail.url, CLOUDY_LOGO_URL);

  const reopenedWithLogo = {};
  assert.equal(loadRecordSnapshotIntoState(reopenedWithLogo, guild, record()), true);
  assert.equal(reopenedWithLogo.showLogo, true);
  assertLogoButtons(reopenedWithLogo, { canAdd: false, canRemove: true });
});
