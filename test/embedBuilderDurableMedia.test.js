import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, Embed } from 'discord.js';
import { db } from '../src/utils/database.js';
import { saveModifiedEmbed } from '../src/services/embedManagerService.js';
import { getEmbedRegistry } from '../src/services/embedRegistryService.js';
import { storeEmbedMediaBuffer, storeExistingDiscordEmbedMedia,
  registerEmbedMediaRoutes } from '../src/services/embedMediaStorageService.js';

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const channelId = '188888888888888880';
const messageId = '188888888888888881';
const attachmentId = '188888888888888882';
const imageUrl = 'https://cdn.discordapp.com/attachments/'
  + channelId + '/' + attachmentId + '/cloudy.gif?ex=signed';

async function storageFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cloudy-embed-media-'));
  const previousDir = process.env.CLOUDY_EMBED_MEDIA_DIR;
  const previousBase = process.env.CLOUDY_EMBED_MEDIA_BASE_URL;
  process.env.CLOUDY_EMBED_MEDIA_DIR = dir;
  process.env.CLOUDY_EMBED_MEDIA_BASE_URL = 'https://cloudy.example.com';
  t.after(async () => {
    if (previousDir === undefined) delete process.env.CLOUDY_EMBED_MEDIA_DIR;
    else process.env.CLOUDY_EMBED_MEDIA_DIR = previousDir;
    if (previousBase === undefined) delete process.env.CLOUDY_EMBED_MEDIA_BASE_URL;
    else process.env.CLOUDY_EMBED_MEDIA_BASE_URL = previousBase;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('media files have immutable HTTPS URLs and a restricted read-only endpoint', async t => {
  const dir = await storageFixture(t);
  const url = await storeEmbedMediaBuffer(gif);
  assert.match(url, /^https:\/\/cloudy\.example\.com\/cloudy-embed-media\/[a-f0-9]{64}\.gif$/);
  assert.equal(await storeEmbedMediaBuffer(gif), url);
  const filename = url.split('/').at(-1);
  assert.deepEqual(await readFile(join(dir, filename)), gif);
  let handler;
  registerEmbedMediaRoutes({get(path, callback) {
    assert.equal(path, '/cloudy-embed-media/:filename');
    handler = callback;
  }});
  const received = {};
  const res = {
    set(key, value) { received[key] = value; return this; },
    status(code) { received.code = code; return this; },
    send(data) { received.body = data; return this; },
    sendStatus(code) { received.code = code; return this; },
  };
  await handler({params: {filename}}, res);
  assert.equal(received.code, 200);
  assert.equal(received['Content-Type'], 'image/gif');
  assert.deepEqual(received.body, gif);
  await handler({params: {filename: '../secrets'}}, res);
  assert.equal(received.code, 404);
});

test('a saved GIF migrates from Discord attachment to immutable URL on title edit and logo change', async t => {
  const dir = await storageFixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(gif, {
    status: 200, headers: { 'content-length': String(gif.length), 'content-type':'image/gif' },
  }));
  const guildId = 'cloudy-inline-migration-20261027';
  const storage = new Map();
  t.mock.method(db, 'get', async (key, fallback) => structuredClone(storage.get(key) ?? fallback));
  t.mock.method(db, 'set', async (key, value) => {
    storage.set(key, structuredClone(value)); return true;
  });
  const before = {title:'TEST 1',description:'Body',color:0x123456,
    image:{url:imageUrl},thumbnail:{url:'https://example.com/logo.png'},
    footer:{text:'Cloudy footer'}};
  const message = {
    id:messageId,guildId,channelId,author:{id:'bot'},
    embeds:[new Embed(before)],components:[],content:'',flags:{has:()=>false},
    attachments: new Collection([
      [attachmentId, { id:attachmentId,name:'cloudy.gif',url:imageUrl,proxyURL:imageUrl }],
      ['188888888888888883', { id:'188888888888888883',name:'notes.pdf',
        url:'https://cdn.discordapp.com/attachments/a/b/notes.pdf' }],
    ]),
    editCalls:[],
  };
  const channel={id:channelId,name:'general',
    messages:{fetch:async ()=>message}};
  message.channel=channel;
  message.edit=async payload=>{
    message.editCalls.push(payload);
    message.embeds=payload.embeds.map(data=>new Embed(data));
    if (payload.attachments) {
      const kept = new Set(payload.attachments.map(x=>String(x.id)));
      message.attachments=new Collection(
        [...message.attachments].filter(([id])=>kept.has(String(id))));
    }
    return message;
  };
  const guild={id:guildId,client:{user:{id:'bot'}},
    channels:{cache:new Map([[channelId,channel]])}};
  const state={
    title:'TEST 2',message:'New description',sideColor:0x123456,
    bottomLine:'Cloudy footer',embedFields:[],showLogo:true,mediaUrl:imageUrl,
    modifyTarget:{guildId,channelId,messageId,embedIndex:0,source:'embed-builder',
      templateMode:false,cachedMessage:message,sourceEmbedData:before,
      previewSourceData:before},
  };
  assert.equal((await saveModifiedEmbed(guild,state)).ok,true);
  assert.equal(message.editCalls.length,1);
  assert.deepEqual(message.editCalls[0].attachments,[{id:'188888888888888883'}]);
  assert.equal(message.attachments.has(attachmentId),false);
  assert.equal(message.attachments.size,1);
  const image=message.embeds[0].image.url;
  assert.match(image,/^https:\/\/cloudy\.example\.com\/cloudy-embed-media\/[a-f0-9]{64}\.gif$/);
  assert.deepEqual(await readFile(join(dir,image.split('/').at(-1))),gif);
  assert.equal(message.embeds[0].title,'TEST 2');
  assert.equal(state.mediaUrl,image);
  assert.equal((await saveModifiedEmbed(guild,state)).ok,true);
  assert.equal(message.editCalls.length,1,'unchanged Save cannot patch GIF');
  state.title='TEST 3';
  state.logoTouched=true;
  state.showLogo=false;
  assert.equal((await saveModifiedEmbed(guild,state)).ok,true);
  assert.equal(message.editCalls.length,2);
  assert.equal(message.embeds[0].image.url,image);
  assert.equal(message.embeds[0].thumbnail,undefined);
  assert.equal((await getEmbedRegistry(guildId)).length,1);
  assert.equal((await getEmbedRegistry(guildId))[0].snapshot.title,'TEST 3');
});

test('a modal-uploaded Discord image is persisted before its signed link expires', async t => {
  await storageFixture(t);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(new URL(url).hostname,'cdn.discordapp.com');
    assert.equal(options.redirect,'error');
    return new Response(gif,{status:200});
  });
  const stored = await storeExistingDiscordEmbedMedia(imageUrl);
  assert.match(stored,/^https:\/\/cloudy\.example\.com\/cloudy-embed-media\/[a-f0-9]{64}\.gif$/);
  assert.notEqual(stored,imageUrl);
  assert.ok(originalFetch);
});
