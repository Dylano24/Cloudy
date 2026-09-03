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
