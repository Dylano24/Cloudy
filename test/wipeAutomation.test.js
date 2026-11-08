import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import {
  autoWipeGiveawayPayload, changeAutoWipeEntry, configureWipeAutomation,
  expirePreviousWipeRoles, getWipeAutomationConfig, observeWipeEvent,
  refreshAutoWipeEntryMessage, runWipeAutomationTick, setWipeAutomationState, syncWipePrize, wipeSessionId,
} from '../src/services/wipeAutomationService.js';
import autoCommand from '../src/commands/Tools/auto.js';
import wipeCommand from '../src/commands/Giveaway/wipe.js';
import { loadVote } from '../src/services/voteService.js';

const GUILD = '1532882647838228723';
const USER = '1532882647838228724';
const ROLE = '1532882647838228725';
const SERVER = 'Cloudy Rust';
const MINUTE = 60000;
const futureWipe = Date.now() + 15 * MINUTE;

function fixture() {
  const store = new Map(), allPosts = [], roles = new Set(), edits = [];
  let nextId = 1n;
  const db = {
    async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
    async set(key, value) { store.set(key, structuredClone(value)); return true; },
  };
  const guild = {
    id: GUILD, premiumSubscriptionCount: 4,
    channels: { cache: new Collection() },
    roles: { cache: new Collection([[ROLE, { id: ROLE }]]) },
    members: { fetch: async () => member },
  };
  const client = { db, user: { id: GUILD }, guilds: { cache: new Collection([[GUILD, guild]]) }, channels: { cache: new Collection() } };
  const member = {
    id: USER, guild,
    roles: {
      cache: { has: id => roles.has(id) },
      async add(role) { roles.add(role.id); },
      async remove(role) { roles.delete(typeof role === 'string' ? role : role.id); },
    },
  };
  function channel(key, name) {
    const messages = new Map(), posts = [];
    const ch = {
      id: key, name, guild, guildId: GUILD,
      isTextBased: () => true, isSendable: () => true,
      messages: {
        cache: new Collection(),
        async fetch(id) {
          if (typeof id !== 'string') return new Collection([...messages].map(([k,v])=>[k,v]));
          return messages.get(id) || null;
        },
      },
      async send(payload) {
        const id = (1569000000000000000n + nextId++).toString();
        const msg = {
          id, author: { id: GUILD }, channelId: key, ...payload,
          async edit(next) { edits.push({ id, next }); Object.assign(msg, next); return msg; },
          async delete() {},
        };
        posts.push(msg);allPosts.push(msg);messages.set(id,msg);return msg;
      },
    };
    guild.channels.cache.set(key,ch);client.channels.cache.set(key,ch);
    return { ch, posts, messages };
  }
  const votes = channel('1554538595094888524', '🗳️│votes');
  const giveaways = channel('1554538606167724132', '🎉│giveaway');
  return { client, guild, db, store, votes, giveaways, allPosts, edits, member, roles };
}
const voteCfg = {
  server: SERVER, question: 'Which map for the next wipe?',
  maps: ['Map A', 'Map B'], beforeMinutes: 20, durationMinutes: 5,
};
const kitCfg = {
  server: SERVER, kit: 'Wipe kit', winnerRoleId: ROLE,
  winnerCount: 1, beforeMinutes: 20, durationMinutes: 5,
};

test('command definitions expose explicit settings and member sync without auto defaults', () => {
  const data = autoCommand.data.toJSON();
  assert.equal(data.name, 'auto');
  assert.deepEqual(data.options.map(option=>option.name), ['feed', 'giveaway', 'vote']);
  assert.equal(wipeCommand.data.toJSON().name, 'wipe');
  assert.equal(wipeCommand.data.toJSON().options[0].name, 'sync');
  for (const option of data.options.filter(x=>['vote', 'giveaway'].includes(x.name))) {
    assert.deepEqual(option.options, [], 'the dashboard replaces lengthy slash options');
  }
});

test('both automatic systems are disabled until configured, enabled and supplied with actual wipe time', async () => {
  const f=fixture();
  assert.deepEqual(await getWipeAutomationConfig(f.client,GUILD), { vote:null,giveaway:null,wipes:{} });
  await runWipeAutomationTick(f.client);
  assert.equal(f.allPosts.length,0);
  await configureWipeAutomation(f.client,GUILD,'vote',voteCfg);
  await configureWipeAutomation(f.client,GUILD,'giveaway',kitCfg);
  await observeWipeEvent(f.client,f.guild,{type:'status',server:SERVER,nextWipe:futureWipe});
  assert.equal(f.allPosts.length,0,'configured automations must not post without start');
  const cfg=await getWipeAutomationConfig(f.client,GUILD);
  assert.equal(cfg.vote.state,'stopped');
  assert.equal(cfg.giveaway.state,'stopped');
  assert.equal(cfg.wipes['cloudy rust'],futureWipe);
  await setWipeAutomationState(f.client,GUILD,'vote','paused');
  await setWipeAutomationState(f.client,GUILD,'giveaway','paused');
  await runWipeAutomationTick(f.client);
  assert.equal(f.allPosts.length,0);
  await setWipeAutomationState(f.client,GUILD,'vote','running');
  await setWipeAutomationState(f.client,GUILD,'giveaway','running');
  await runWipeAutomationTick(f.client);
  assert.equal(f.votes.posts.length,1);
  assert.equal(f.giveaways.posts.length,1);
  await runWipeAutomationTick(f.client);
  assert.equal(f.votes.posts.length,1,'no vote duplicate after next scheduler run');
  assert.equal(f.giveaways.posts.length,1,'no giveaway duplicate after next scheduler run');
});

test('configured vote uses exact map choices, question, existing vote code and no invented description', async () => {
  const f=fixture();
  await configureWipeAutomation(f.client,GUILD,'vote',voteCfg);
  await setWipeAutomationState(f.client,GUILD,'vote','running');
  await observeWipeEvent(f.client,f.guild,{type:'status',server:SERVER,nextWipe:futureWipe});
  assert.equal(f.votes.posts.length,1);
  const v=await loadVote(f.client,GUILD,f.votes.posts[0].id);
  assert.deepEqual(v.options,voteCfg.maps);
  assert.equal(v.question,voteCfg.question);
  assert.equal(v.description,undefined);
  assert.equal(v.automationId,wipeSessionId(GUILD,SERVER,futureWipe));
});

test('a wipe kit giveaway is entered without claims/rerolls, ends once and syncs its role until the NEXT wipe', async () => {
  const f=fixture();
  await configureWipeAutomation(f.client,GUILD,'giveaway',kitCfg);
  await setWipeAutomationState(f.client,GUILD,'giveaway','running');
  await observeWipeEvent(f.client,f.guild,{type:'status',server:SERVER,nextWipe:futureWipe});
  assert.equal(f.giveaways.posts.length,1);
  const id=wipeSessionId(GUILD,SERVER,futureWipe);
  const msg=f.giveaways.posts[0];
  const initial=msg.components[0].toJSON().components.map(b=>b.custom_id);
  assert.deepEqual(initial,[`wipeauto_enter:${id}`,`wipeauto_leave:${id}`]);
  assert.ok(!JSON.stringify(msg).includes('reroll'), 'no reroll button');
  assert.ok(!JSON.stringify(msg).includes('claim'), 'no claim button');
  assert.equal((await changeAutoWipeEntry(f.client,GUILD,id,USER,true)).status,'entered');
  assert.equal((await changeAutoWipeEntry(f.client,GUILD,id,USER,true)).status,'already');
  assert.equal((await changeAutoWipeEntry(f.client,GUILD,id,USER,false)).status,'left');
  assert.equal((await changeAutoWipeEntry(f.client,GUILD,id,USER,true)).status,'entered');
  assert.equal((await syncWipePrize(f.client,f.member)).status,'not-winner','no claim until giveaway ended');
  await runWipeAutomationTick(f.client,Date.now()+6*MINUTE);
  const session=await f.db.get(`guild:${GUILD}:wipe-automation:giveaway:${id}`);
  assert.equal(session.status,'ended');
  assert.deepEqual(session.winners,[USER]);
  assert.deepEqual(autoWipeGiveawayPayload(session).components,[]);
  assert.equal((await changeAutoWipeEntry(f.client,GUILD,id,USER,true)).status,'ended');
  assert.equal((await syncWipePrize(f.client,f.member)).status,'synced');
  assert.equal(f.roles.has(ROLE),true);
  assert.equal((await syncWipePrize(f.client,f.member)).status,'already');
  await expirePreviousWipeRoles(f.client,f.guild,SERVER,futureWipe);
  assert.equal(f.roles.has(ROLE),true,'must keep prize through the current wipe');
  await expirePreviousWipeRoles(f.client,f.guild,SERVER,futureWipe+8*24*60*MINUTE);
  assert.equal(f.roles.has(ROLE),false,'next wipe removes role');
  assert.equal((await syncWipePrize(f.client,f.member)).status,'not-winner','prize cannot sync after next wipe');
});

test('participant clicks refresh only the current giveaway message, not a duplicate or stale count', async () => {
  const f=fixture();
  await configureWipeAutomation(f.client,GUILD,'giveaway',kitCfg);
  await setWipeAutomationState(f.client,GUILD,'giveaway','running');
  await observeWipeEvent(f.client,f.guild,{type:'status',server:SERVER,nextWipe:futureWipe});
  const id=wipeSessionId(GUILD,SERVER,futureWipe),message=f.giveaways.posts[0];
  assert.equal((await changeAutoWipeEntry(f.client,GUILD,id,USER,true)).status,'entered');
  const changed=await refreshAutoWipeEntryMessage(f.client,GUILD,id,message);
  assert.equal(changed,true);
  assert.equal(f.edits.length,1);
  assert.match(message.embeds[0].description, /\*\*Participants\*\*\n1/);
  assert.equal(f.giveaways.posts.length,1,'no duplicate post');
  assert.equal(await refreshAutoWipeEntryMessage(f.client,GUILD,id,{id:'old',edit:async()=>{}}),false);
  assert.equal(f.edits.length,1,'never update a stale message');
});

test('bad configuration, unknown role, invalid session and wrong guild never trigger actions', async () => {
  const f=fixture();
  await assert.rejects(()=>configureWipeAutomation(f.client,GUILD,'vote',{...voteCfg,maps:['Map A']}),RangeError);
  await assert.rejects(()=>configureWipeAutomation(f.client,GUILD,'vote',{...voteCfg,maps:['Map A','Map A']}),RangeError);
  await assert.rejects(()=>configureWipeAutomation(f.client,GUILD,'vote',{...voteCfg,durationMinutes:20}),RangeError);
  await assert.rejects(()=>configureWipeAutomation(f.client,GUILD,'giveaway',{...kitCfg,winnerRoleId:'unconfigured'}),RangeError);
  await assert.rejects(()=>setWipeAutomationState(f.client,GUILD,'vote','running'),RangeError);
  assert.equal((await changeAutoWipeEntry(f.client,GUILD,'invalid',USER,true)).status,'invalid');
  assert.equal((await syncWipePrize(f.client,{guild:{id:'other'}})).status,'unavailable');
  await observeWipeEvent(f.client,{id:'other'},{type:'status',server:SERVER,nextWipe:futureWipe});
  assert.equal(f.allPosts.length,0);
});


test('repeating automatic votes use the selected channel, never duplicate a tick, and can pause', async () => {
  const f = fixture();
  await configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 15, durationMinutes: 5,
    channelId: f.giveaways.ch.id, server: 'Cloudy',
    question: 'Choose a new map', maps: ['Map Alpha', 'Map Bravo', 'Map Charlie'],
    randomize: true,
  });
  await setWipeAutomationState(f.client, GUILD, 'vote', 'running');
  let stored = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  assert.equal(stored.schedule, 'repeat');
  assert.equal(stored.state, 'running');
  assert.ok(stored.nextRunAt > Date.now());
  await runWipeAutomationTick(f.client, stored.nextRunAt - 100);
  assert.equal(f.allPosts.length, 0, 'cannot post early');
  await Promise.all([
    runWipeAutomationTick(f.client, stored.nextRunAt + 10),
    runWipeAutomationTick(f.client, stored.nextRunAt + 10),
  ]);
  assert.equal(f.giveaways.posts.length, 1, 'only one vote even with concurrent ticks');
  assert.equal(f.votes.posts.length, 0, 'must use custom destination rather than the old votes channel');
  const first = await loadVote(f.client, GUILD, f.giveaways.posts[0].id);
  assert.deepEqual([...first.options].sort(), ['Map Alpha', 'Map Bravo', 'Map Charlie'].sort());
  stored = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  await runWipeAutomationTick(f.client, stored.nextRunAt + 10);
  assert.equal(f.giveaways.posts.length, 2, 'second interval produces a fresh vote');
  await setWipeAutomationState(f.client, GUILD, 'vote', 'paused');
  stored = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  await runWipeAutomationTick(f.client, stored.nextRunAt + 10);
  assert.equal(f.giveaways.posts.length, 2, 'paused schedule must not publish');
});

test('repeating kit giveaways select one of the configured prizes and conclude safely', async () => {
  const f = fixture();
  await configureWipeAutomation(f.client, GUILD, 'giveaway', {
    schedule: 'repeat', repeatMinutes: 30, durationMinutes: 5,
    channelId: f.votes.ch.id, server: 'Cloudy', winnerRoleId: '',
    kit: 'Red kit', prizes: ['Red kit', 'Blue kit', 'Green kit'],
    winnerCount: 2, randomize: true, description: 'A prize for our members.',
  });
  await setWipeAutomationState(f.client, GUILD, 'giveaway', 'running');
  const setting = (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
  await runWipeAutomationTick(f.client, setting.nextRunAt + 100);
  assert.equal(f.votes.posts.length, 1, 'giveaway posts in the selected channel');
  const id = wipeSessionId(GUILD, 'giveaway:repeat', setting.nextRunAt);
  const session = await f.db.get(`guild:${GUILD}:wipe-automation:giveaway:${id}`);
  assert.ok(['Red kit', 'Blue kit', 'Green kit'].includes(session.kit));
  assert.equal(session.description, 'A prize for our members.');
  assert.equal(session.winnerCount, 2);
  assert.equal((await changeAutoWipeEntry(f.client, GUILD, id, USER, true)).status, 'entered');
  await runWipeAutomationTick(f.client, setting.nextRunAt + 6 * MINUTE);
  const ended = await f.db.get(`guild:${GUILD}:wipe-automation:giveaway:${id}`);
  assert.equal(ended.status, 'ended');
  assert.deepEqual(ended.winners, [USER]);
  assert.equal(ended.roleId, '');
  assert.equal(f.giveaways.posts.length, 0, 'must not post in the legacy channel');
});

test('repeat rejects invalid schedules and never posts until explicitly started', async () => {
  const f = fixture();
  await assert.rejects(() => configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 10, durationMinutes: 5,
    question: 'Test', maps: ['One', 'Two'],
  }), RangeError);
  await assert.rejects(() => configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 30, durationMinutes: 30,
    question: 'Test', maps: ['One', 'Two'],
  }), RangeError);
  await configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 15, durationMinutes: 5,
    question: 'Test', maps: ['One', 'Two'],
  });
  const stored = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  await runWipeAutomationTick(f.client, stored.nextRunAt + 15 * MINUTE);
  assert.equal(f.allPosts.length, 0, 'saving cannot automatically start a schedule');
});
