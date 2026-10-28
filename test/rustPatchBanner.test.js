import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';

import { parseLatestPatch } from '../src/services/rustPatchNotesService.js';
import { db } from '../src/utils/database.js';
import {
  decorateEmbedWithSavedTemplate,
  saveEmbedTemplateDecoration,
} from '../src/services/embedTemplateService.js';

test('Rust RSS hero image is retained as the patch-note banner', () => {
  const feed = `<?xml version="1.0"?><rss><channel><item>
    <guid>https://rust.facepunch.com/news/power-trip/</guid>
    <link>https://rust.facepunch.com/news/power-trip/</link>
    <title>Power Trip</title>
    <description>&lt;img src="https://files.facepunch.com/lewis/2026/August/pt_hero.jpg"&gt;&lt;br/&gt;Update text</description>
    <pubDate>Thu, 06 Aug 2026 18:59:00 Z</pubDate>
  </item></channel></rss>`;

  const patch = parseLatestPatch(feed);
  assert.equal(patch.title, 'Power Trip');
  assert.equal(patch.image, 'https://files.facepunch.com/lewis/2026/August/pt_hero.jpg');
});

test('an empty saved media setting cannot erase the live official Rust banner', async () => {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.get(key) || null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };

  const guildId = 'rust-banner-guild';
  const channelId = 'rust-banner-channel';
  await saveEmbedTemplateDecoration(
    guildId,
    channelId,
    ['Power Trip'],
    { title: 'Power Trip', color: 0xFFFFFF },
    { applyImage: true },
  );

  const banner = 'https://files.facepunch.com/lewis/2026/August/pt_hero.jpg';
  const runtime = new EmbedBuilder({
    title: 'Power Trip',
    url: 'https://rust.facepunch.com/news/power-trip/',
    image: { url: banner },
  });
  const decorated = await decorateEmbedWithSavedTemplate(guildId, channelId, runtime);

  assert.equal(decorated.embed.toJSON().image.url, banner);
});

for (const url of ['https://rust.facepunch.com/news/halloween-2026/', 'https://server.nitrado.net/en-US/news/rust-update']) {
  test(`saved runtime decorations keep the newly uploaded article banner: ${url}`, async () => {
    const guildId = `required-banner-${new URL(url).hostname}`;
    const channelId = 'patch-channel';
    await saveEmbedTemplateDecoration(guildId, channelId, ['Official update'], { title: 'Official update', image: { url: 'https://example.com/stale-banner.jpg' } }, { applyImage: true });
    const runtime = new EmbedBuilder({ title: 'Official update', url, image: { url: 'attachment://patch-notes-banner.png' } });
    const decorated = await decorateEmbedWithSavedTemplate(guildId, channelId, runtime);
    assert.equal(decorated.embed.toJSON().image.url, 'attachment://patch-notes-banner.png');
  });
}

test('runtime catalog cannot remove the required article banner while applying saved styling', async () => {
  const { primeSystemEmbedTemplateData, applyRuntimeEmbedTemplateData } = await import('../src/services/systemEmbedCatalogService.js');
  primeSystemEmbedTemplateData('official catalog patch', 'patches/banner', { title: 'Official catalog patch', color: 123 });
  const decorated = applyRuntimeEmbedTemplateData({ title: 'Official catalog patch', color: 456, url: 'https://server.nitrado.net/en-US/news/rust-update', image: { url: 'attachment://patch-notes-banner.png' } }, { channel: { name: 'patches/banner' } });
  assert.equal(decorated.color, 123);
  assert.equal(decorated.image?.url, 'attachment://patch-notes-banner.png');
});

test('Discord hosted article banners survive the MessageCreate saved-template pass', async () => {
  const guildId = 'discord-hosted-patch';
  const channelId = 'patch-channel';
  await saveEmbedTemplateDecoration(guildId, channelId, ['Hosted update'], { title: 'Hosted update', image: { url: 'https://example.com/stale-image.jpg' } }, { applyImage: true });
  const banner = 'https://cdn.discordapp.com/attachments/123/456/patch-notes-banner.png?ex=123';
  const runtime = new EmbedBuilder({ title: 'Hosted update', url: 'https://server.nitrado.net/en-US/news/rust-update', image: { url: banner } });
  const result = await decorateEmbedWithSavedTemplate(guildId, channelId, runtime);
  assert.equal(result.embed.toJSON().image?.url, banner);
});
