import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { buildBuilderEmbeds, buildControls, queueBuilderRefresh } from '../src/commands/Tools/embedbuilder.js';
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
