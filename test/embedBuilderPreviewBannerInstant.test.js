import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { buildBuilderEmbeds, buildPostedEmbeds } from '../src/commands/Tools/embedbuilder.js';
import { previewBannerUrl, rememberPreviewBanner } from '../src/utils/builderPreviewBanner.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const upload = 'https://cdn.discordapp.com/ephemeral-attachments/1534506224312389863/198888888888888882/banner.png?ex=signed';
const permanent = 'https://cloudy.example.com/cloudy-embed-media/' + 'a'.repeat(64) + '.png';

test('the preview shows a just-uploaded banner from Discord\'s own link; the post keeps Cloudy\'s link', () => {
  const state = { title: 'Rules', message: 'Body', sideColor: 0xffffff, embedFields: [], mediaUrl: permanent };
  rememberPreviewBanner(state, permanent, upload);
  assert.equal(previewBannerUrl(state), upload);
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().image.url, upload);
  assert.equal(buildPostedEmbeds(state).at(-1).toJSON().image.url, permanent);

  // A different banner afterwards is shown as it is.
  state.mediaUrl = 'https://cloudy.example.com/cloudy-embed-media/' + 'b'.repeat(64) + '.png';
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().image.url, state.mediaUrl);

  // Only a fresh upload link is used, never another Discord attachment link.
  const other = { mediaUrl: permanent };
  rememberPreviewBanner(other, permanent, 'https://cdn.discordapp.com/attachments/1/2/old.png');
  assert.equal(previewBannerUrl(other), permanent);
  assert.equal(previewBannerUrl({ mediaUrl: null }), null);
});

test('Save of a new banner: the post gets Cloudy\'s link, the Builder preview keeps the upload', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cloudy-preview-banner-'));
  const previous = { dir: process.env.CLOUDY_EMBED_MEDIA_DIR, base: process.env.CLOUDY_EMBED_MEDIA_BASE_URL };
  process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.example.com';
  t.after(async () => {
    for (const [key, value] of [['CLOUDY_EMBED_MEDIA_DIR', previous.dir], ['CLOUDY_EMBED_MEDIA_BASE_URL', previous.base]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), upload);
    return new Response(png, { status: 200, headers: { 'content-length': String(png.length) } });
  });
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => { storage.set(key, structuredClone(value)); return true; });

  const guildId = 'cloudy-preview-banner-guild';
  const channelId = '198888888888888880';
  const messageId = '198888888888888881';
  const before = { title: 'Rules', description: 'Body', color: 0xffffff, footer: { text: 'Cloudy footer' } };
  const message = {
    id: messageId, guildId, channelId, author: { id: 'bot' }, embeds: [new Embed(before)],
    components: [], content: '', flags: { has: () => false }, attachments: new Collection(), editCalls: [],
  };
  const channel = { id: channelId, name: 'rules', messages: { fetch: async () => message } };
  message.channel = channel;
  message.edit = async payload => {
    message.editCalls.push(payload);
    message.embeds = payload.embeds.map(data => new Embed(data));
    return message;
  };
  const guild = { id: guildId, client: { user: { id: 'bot' } }, channels: { cache: new Map([[channelId, channel]]) } };
  const state = {
    title: 'Rules', message: 'Body', sideColor: 0xffffff, bottomLine: 'Cloudy footer', embedFields: [],
    showLogo: false, mediaUrl: upload, mediaTouched: true,
    modifyTarget: { guildId, channelId, messageId, embedIndex: 0, source: 'embed-builder', templateMode: false,
      cachedMessage: message, sourceEmbedData: before, previewSourceData: before },
  };

  assert.equal((await saveModifiedEmbed(guild, state)).ok, true);
  const posted = message.embeds[0].image.url;
  assert.match(posted, /^https:\/\/cloudy\.example\.com\/cloudy-embed-media\/[a-f0-9]{64}\.png$/);
  assert.equal(state.mediaUrl, posted);
  assert.equal(buildBuilderEmbeds(state)[0].toJSON().image.url, upload, 'preview shows at once');
});
