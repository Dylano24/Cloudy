import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isUsableMessage, discoverRecentChannelEmbeds, discoverMissingChannelEmbeds } from '../src/services/embedMissingChannelService.js';

function item(id, title, extra={}) {
  return {
    id: String(id), guildId: 'full-history-guild', channelId: 'gambling',
    author: { id: 'cloudy-bot' }, flags: { has: () => false },
    embeds: [{ title, description: 'Complete dynamic content: '+id }],
    components: [], createdTimestamp: Number(id),
    createdAt: new Date('2026-10-24T10:00:00Z'), ...extra,
  };
}

test('real posted bot embeds are browseable without the special Builder footer while transient command output is excluded', () => {
  assert.equal(isUsableMessage(item(1, 'Gambling & Games'), 'cloudy-bot'), true);
  assert.equal(isUsableMessage(item(2, 'Roulette win'), 'cloudy-bot'), true);
  assert.equal(isUsableMessage(item(3, 'Too fast'), 'cloudy-bot'), false);
  assert.equal(isUsableMessage(item(4, 'Ping!', { interactionMetadata: { id: 'command' } }), 'cloudy-bot'), false);
  assert.equal(isUsableMessage(item(5, 'Message builder'), 'cloudy-bot'), false);
});

test('channel fetch shows newest page quickly and then loads ALL older pages, without registering messages as Builder Saves', async () => {
  const total = 230;
  const all = Array.from({ length: total }, (_, i) => item(i+1, 'Game result ' + (i+1))).reverse();
  const calls = [];
  const channel = {
    id:'gambling', type:0, name:'gambling',
    messages: {
      cache: new Map(),
      fetch: async ({limit, before}={}) => {
        calls.push(before || 'latest');
        const start = before ? all.findIndex(m=>m.id === String(before))+1 : 0;
        const page = all.slice(start, start+limit);
        const map = new Map(page.map(m=>[m.id,m]));
        map.last = () => page.at(-1);
        return map;
      },
    },
  };
  const guild = {
    id:'full-history-guild', channels:{cache:new Map([['gambling',channel]])},
  };
  const recent = await discoverRecentChannelEmbeds(guild,'gambling','cloudy-bot');
  assert.equal(recent.length,100);
  assert.equal(calls.length,1, 'first paint uses one Discord history request');
  const pages = [];
  const full = await discoverMissingChannelEmbeds(guild,'gambling','cloudy-bot',{
    onBatch: records => pages.push(records.length),
  });
  assert.equal(full.length,total, 'every message from the channel must appear after history pagination');
  assert.equal(new Set(full.map(x=>x.messageId)).size,total);
  assert.deepEqual(pages, [100, 30], 'new pages are streamed to the browser without waiting for the full sweep');
  assert.equal(calls.filter(x=>x==='latest').length,1,
    'the background sweep reuses the just-verified newest page instead of fetching it twice');
  assert.ok(full.every(x=>!x.manualSaved && x.channelId==='gambling'));
});

test('initial channel menu keeps known explicit Saves; source-only catalog remains Search-only',()=>{
  const code=fs.readFileSync('src/services/embedManagerService.js','utf8');
  const start=code.indexOf('export async function openEmbedManager(');
  const end=code.indexOf('const checkingChannelIds', start);
  const initial=code.slice(start,end);
  assert.match(initial,/allStoredRecords\.filter\(record => record\.source === 'embed-builder'\s*&& record\.manualSaved === true\)/);
  assert.match(initial,/projectCatalogTemplatesToFeatureChannels/);
  assert.doesNotMatch(initial,/getSearchableSystemCatalogRecords/);
});

test('channel navigation starts latest page and progressively hydrates old channel messages while keeping an existing Save',()=>{
  const code=fs.readFileSync('src/services/embedManagerService.js','utf8');
  const start=code.indexOf("if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:'))");
  const end=code.indexOf("if (interaction.customId.startsWith('simple_embed_modify_embed_page:'))",start);
  const body=code.slice(start,end);
  assert.match(body,/discoverRecentChannelEmbeds\(guild, channelId/);
  assert.match(body,/discoverMissingChannelEmbeds\(guild, channelId/);
  assert.match(body,/record\.manualSaved === true/);
  assert.match(body,/onBatch:/);
  assert.doesNotMatch(body,/getCanonicalBuilderRecords\(\s*guild, liveRecords/);
});

test('cold Search selection tries a targeted registry refresh before triggering global catalog work',()=>{
  const code=fs.readFileSync('src/commands/Tools/zz_embedbuilderLiveSearchPatch.js','utf8');
  const start=code.indexOf('export async function loadEmbedBuilderSearchSelection');
  const end=code.indexOf('export async function hydrateLiveSearchRecord',start);
  const body=code.slice(start,end);
  assert.match(body,/getEmbedRegistry\(interaction\.guildId, \{ cached: true \}\)/);
  assert.match(body,/mergeSearchRecords\(interaction\.guildId/);
});
