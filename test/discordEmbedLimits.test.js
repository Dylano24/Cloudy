import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBuilderEmbeds,
  buildPostedEmbeds,
} from '../src/commands/Tools/embedbuilder.js';
import {
  CLOUDY_BANNER_URL,
  CLOUDY_LOGO_URL,
  migrateCloudyLogoEmbedData,
} from '../src/services/cloudyLogoService.js';
import {
  DISCORD_EMBED_TOTAL_TEXT_LIMIT,
  fitEmbedToTextBudget,
  getEmbedsTextLength,
  getEmbedTextLength,
} from '../src/utils/discordEmbedLimits.js';

test('embed text accounting includes every field in Discord total limit', () => {
  const embed = {
    title: 'title',
    description: 'description',
    author: { name: 'author' },
    footer: { text: 'footer' },
    fields: [
      { name: 'field', value: 'value' },
      { name: 'second', value: 'entry' },
    ],
  };

  assert.equal(getEmbedTextLength(embed), 49);
  assert.equal(getEmbedsTextLength([embed, embed]), 98);
});

test('preview fitting stays inside its budget without mutating saved content', () => {
  const source = {
    title: 'T'.repeat(256),
    description: 'D'.repeat(4096),
    footer: { text: 'F'.repeat(1000) },
    fields: [{ name: 'N'.repeat(100), value: 'V'.repeat(548) }],
  };

  assert.equal(getEmbedTextLength(source), DISCORD_EMBED_TOTAL_TEXT_LIMIT);
  const fitted = fitEmbedToTextBudget(source, 5600);

  assert.equal(getEmbedTextLength(fitted), 5600);
  assert.equal(source.description.length, 4096);
  assert.equal(fitted.title, source.title);
  assert.deepEqual(fitted.fields, source.fields);
});

test('builder preview reserves room for its control embed', () => {
  const state = {
    title: 'T'.repeat(256),
    message: 'D'.repeat(4000),
    embedFields: [{ name: 'N'.repeat(100), value: 'V'.repeat(644), inline: false }],
    sideColor: 0xFFFFFF,
    showLogo: false,
    removeExistingLogo: false,
    bottomLine: 'F'.repeat(1000),
    mediaUrl: null,
    mediaBuffer: null,
    mediaName: null,
    mediaConvertedFromVideo: false,
    modifyTarget: { sourceEmbedData: {} },
  };

  const embeds = buildBuilderEmbeds(state);
  assert.equal(embeds.length, 2);
  assert.ok(getEmbedsTextLength(embeds) <= DISCORD_EMBED_TOTAL_TEXT_LIMIT);
  assert.equal(state.message.length, 4000);
  assert.equal(state.embedFields[0].value.length, 644);
});

test('posted builder messages preserve all text while respecting the per-message total', () => {
  const state = {
    title: 'T'.repeat(256),
    message: 'M'.repeat(4000),
    sideColor: 0xFFFFFF,
    showLogo: true,
    bottomLine: 'F'.repeat(2047),
    mediaUrl: null,
    mediaBuffer: null,
    mediaName: null,
  };

  const embeds = buildPostedEmbeds(state);
  assert.equal(embeds.length, 2);
  assert.equal(
    embeds.map(embed => embed.toJSON().description || '').join(''),
    state.message,
  );
  assert.ok(embeds.every(embed =>
    getEmbedTextLength(embed) <= DISCORD_EMBED_TOTAL_TEXT_LIMIT));
});

test('Cloudy runtime media uses immutable CDN URLs and migrates direct GitHub media', () => {
  const legacyLogo = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';
  const legacyBanner = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-dynamic-banner.gif';
  const temporaryStaticLogo = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@646fdaacabd0811da7ef2eca6df82ce32c078552/assets/cloudy-c-logo-static.png';
  const migrated = migrateCloudyLogoEmbedData({
    thumbnail: { url: legacyLogo },
    image: { url: legacyBanner },
  });

  assert.equal(migrated.changed, true);
  assert.equal(migrated.data.thumbnail.url, CLOUDY_LOGO_URL);
  assert.equal(migrated.data.image.url, CLOUDY_BANNER_URL);
  const restoredStatic = migrateCloudyLogoEmbedData({ thumbnail: { url: temporaryStaticLogo } });
  assert.equal(restoredStatic.changed, true);
  assert.equal(restoredStatic.data.thumbnail.url, CLOUDY_LOGO_URL);
  assert.match(restoredStatic.data.thumbnail.url, /cloudy-c-logo-auf-auf\.gif$/);
  assert.doesNotMatch(CLOUDY_LOGO_URL, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(CLOUDY_BANNER_URL, /raw\.githubusercontent\.com/);
  assert.match(CLOUDY_LOGO_URL, /@[0-9a-f]{40}\//);
  assert.match(CLOUDY_BANNER_URL, /@[0-9a-f]{40}\//);
});
