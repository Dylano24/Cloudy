import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import { buildBuilderEmbeds } from '../src/commands/Tools/embedbuilder.js';
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

  const controls = source.slice(source.indexOf('function buildControls('), source.indexOf('function getPreviewUpdateQueue('));
  assert.match(controls, /const hasLogo = Boolean\(buildPreviewEmbed\(state\)\.toJSON\(\)\.thumbnail\?\.url\)/);
  assert.match(controls, /setCustomId\('simple_embed_remove_logo'\)[\s\S]*?setDisabled\(!hasLogo\)/);
});
