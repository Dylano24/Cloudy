import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import {
  autoWipeGiveawayPayload, changeAutoWipeEntry, configureWipeAutomation,
  expirePreviousWipeRoles, getWipeAutomationConfig, observeWipeEvent,
  refreshAutoWipeEntryMessage, runWipeAutomationTick, setWipeAutomationState, syncWipePrize, wipeSessionId,
  listAutomaticVotes, saveAutomaticVoteJob, setAutomaticVoteJobState, deleteAutomaticVoteJob,
  planRandomWeeklySlots,
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
  assert.deepEqual(await getWipeAutomationConfig(f.client,GUILD), { vote:null,giveaway:null,voteJobs:[],wipes:{} });
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
    schedule: 'repeat', repeatMinutes: 0, durationMinutes: 5,
    question: 'Test', maps: ['One', 'Two'],
  }), RangeError);
  await assert.rejects(() => configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 30, durationMinutes: 31,
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

test('a dated one-time vote publishes exactly once and stops itself', async () => {
  const f = fixture();
  const startAt = Date.now() + 3 * MINUTE;
  await configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'once', startAt, durationMinutes: 1440,
    question: 'Once only', maps: ['A', 'B'], channelId: f.votes.ch.id,
  });
  let config = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  assert.equal(config.nextRunAt, startAt);
  assert.equal(config.state, 'stopped');
  await setWipeAutomationState(f.client, GUILD, 'vote', 'running');
  await runWipeAutomationTick(f.client, startAt - 1);
  assert.equal(f.votes.posts.length, 0, 'date must be honored');
  await Promise.all([
    runWipeAutomationTick(f.client, startAt + 1),
    runWipeAutomationTick(f.client, startAt + 1),
  ]);
  assert.equal(f.votes.posts.length, 1);
  config = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  assert.equal(config.state, 'stopped');
  assert.ok(config.completedAt);
  await runWipeAutomationTick(f.client, startAt + 10 * MINUTE);
  assert.equal(f.votes.posts.length, 1, 'once never triggers another vote');
  await assert.rejects(() => setWipeAutomationState(f.client, GUILD, 'vote', 'running'), RangeError);
});

test('a dated repeating giveaway waits until its selected day, then repeats on interval', async () => {
  const f = fixture();
  const startAt = Date.now() + 2 * MINUTE;
  await configureWipeAutomation(f.client, GUILD, 'giveaway', {
    schedule: 'repeat', startAt, repeatMinutes: 1440, durationMinutes: 1440,
    kit: 'Timed kit', winnerCount: 1, channelId: f.giveaways.ch.id,
  });
  await setWipeAutomationState(f.client, GUILD, 'giveaway', 'running');
  let cfg = (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
  assert.equal(cfg.nextRunAt, startAt);
  await runWipeAutomationTick(f.client, startAt - 10);
  assert.equal(f.giveaways.posts.length, 0);
  await runWipeAutomationTick(f.client, startAt + 10);
  assert.equal(f.giveaways.posts.length, 1);
  cfg = (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
  assert.equal(cfg.nextRunAt, startAt + 1440 * MINUTE);
  await runWipeAutomationTick(f.client, cfg.nextRunAt + 10);
  assert.equal(f.giveaways.posts.length, 2);
});

test('multiple automatic votes retain independent names, channels, schedules and statuses', async () => {
  const f = fixture();
  await configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 60, durationMinutes: 5,
    question: 'Original legacy vote', maps: ['One', 'Two'],
    channelId: f.votes.ch.id,
  });
  const a = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'repeat', repeatMinutes: 60, durationMinutes: 5,
    question: 'First scheduled vote', maps: ['A', 'B'], channelId: f.votes.ch.id,
  });
  const b = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'repeat', repeatMinutes: 120, durationMinutes: 10,
    question: 'Second scheduled vote', maps: ['Yes', 'No'], channelId: f.giveaways.ch.id,
  });
  assert.match(a.id, /^[a-f0-9]{16}$/);
  assert.match(b.id, /^[a-f0-9]{16}$/);
  assert.notEqual(a.id, b.id);
  const votes = await listAutomaticVotes(f.client, GUILD);
  assert.deepEqual(votes.map(v => v.question),
    ['Original legacy vote', 'First scheduled vote', 'Second scheduled vote']);
  assert.equal(votes[0].id, 'legacy');
  assert.equal(votes[1].channelId, f.votes.ch.id);
  assert.equal(votes[2].channelId, f.giveaways.ch.id);
  await setAutomaticVoteJobState(f.client, GUILD, a.id, 'running');
  await setAutomaticVoteJobState(f.client, GUILD, b.id, 'paused');
  assert.deepEqual((await listAutomaticVotes(f.client, GUILD)).map(v => v.state),
    ['stopped', 'running', 'paused']);
  const nextA = (await listAutomaticVotes(f.client, GUILD)).find(v => v.id === a.id).nextRunAt;
  await Promise.all([
    runWipeAutomationTick(f.client, nextA + 1),
    runWipeAutomationTick(f.client, nextA + 1),
  ]);
  assert.equal(f.votes.posts.length, 1, 'only running first vote publishes');
  assert.equal(f.giveaways.posts.length, 0, 'paused second vote does not publish');
  assert.equal((await listAutomaticVotes(f.client, GUILD))[1].state, 'running');
  await setAutomaticVoteJobState(f.client, GUILD, b.id, 'running');
  const nextB = (await listAutomaticVotes(f.client, GUILD)).find(v => v.id === b.id).nextRunAt;
  await runWipeAutomationTick(f.client, nextB + 1);
  assert.equal(f.giveaways.posts.length, 1, 'second auto vote publishes to its own channel');
  assert.equal((await listAutomaticVotes(f.client, GUILD))[0].state, 'stopped');
});

test('editing one auto vote does not overwrite another or the legacy configuration', async () => {
  const f = fixture();
  await configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 30, durationMinutes: 5,
    question: 'Legacy remains', maps: ['One', 'Two'],
  });
  const a = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'repeat', repeatMinutes: 60, durationMinutes: 5,
    question: 'Vote A', maps: ['A', 'B'],
  });
  const b = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'repeat', repeatMinutes: 60, durationMinutes: 5,
    question: 'Vote B', maps: ['C', 'D'],
  });
  await setAutomaticVoteJobState(f.client, GUILD, a.id, 'running');
  const saved = await saveAutomaticVoteJob(f.client, GUILD, {
    ...a, question: 'Vote A renamed', maps: ['X', 'Y'],
  }, a.id);
  assert.equal(saved.id, a.id);
  assert.equal(saved.state, 'running');
  assert.equal(saved.nextRunAt, a.nextRunAt);
  const votes = await listAutomaticVotes(f.client, GUILD);
  assert.deepEqual(votes.map(v => v.question), ['Legacy remains', 'Vote A renamed', 'Vote B']);
  assert.equal(votes[2].id, b.id);
  await deleteAutomaticVoteJob(f.client, GUILD, a.id);
  assert.deepEqual((await listAutomaticVotes(f.client, GUILD)).map(v => v.question),
    ['Legacy remains', 'Vote B']);
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).vote.question, 'Legacy remains');
});

test('separate once-only automatic votes each run once and preserve their own completed status', async () => {
  const f = fixture();
  const startAt = Date.now() + 4 * MINUTE;
  const base = { schedule: 'once', startAt, durationMinutes: 5, maps: ['Yes', 'No'] };
  const a = await saveAutomaticVoteJob(f.client, GUILD, {
    ...base, question: 'A', channelId: f.votes.ch.id,
  });
  const b = await saveAutomaticVoteJob(f.client, GUILD, {
    ...base, question: 'B', channelId: f.votes.ch.id,
  });
  await setAutomaticVoteJobState(f.client, GUILD, a.id, 'running');
  await setAutomaticVoteJobState(f.client, GUILD, b.id, 'running');
  await runWipeAutomationTick(f.client, startAt + 1);
  assert.equal(f.votes.posts.length, 2, 'IDs must not collide for same-day automatic votes');
  const states = await listAutomaticVotes(f.client, GUILD);
  assert.deepEqual(states.map(v => v.state), ['stopped', 'stopped']);
  assert.ok(states.every(v => v.completedAt));
  await runWipeAutomationTick(f.client, startAt + MINUTE);
  assert.equal(f.votes.posts.length, 2);
});


test('random weekly plan schedules exactly 2 or 3 stable, dispersed slots per week', () => {
  const startAt = Date.now() + 2 * MINUTE;
  const pickLastCountAndFirstMinute = (low, high) => high === undefined ? 0 : high - 1;
  for (const weekIndex of [0, 1]) {
    const slots = planRandomWeeklySlots(startAt, weekIndex, 2, 3, pickLastCountAndFirstMinute);
    assert.equal(slots.length, 3);
    assert.equal(new Set(slots).size, 3);
    for (const date of slots) {
      assert.ok(date >= startAt + weekIndex * 7 * 24 * 60 * MINUTE);
      assert.ok(date < startAt + (weekIndex + 1) * 7 * 24 * 60 * MINUTE);
    }
    assert.ok(slots[0] < slots[1] && slots[1] < slots[2]);
  }
});

test('random weekly vote posts only at its persisted slots and never double-posts', async () => {
  const f = fixture();
  const startAt = Date.now() + 2 * MINUTE;
  const job = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'random_weekly', startAt, weeklyMin: 2, weeklyMax: 3,
    durationMinutes: 60, question: 'Weekly vote?', maps: ['Yes', 'No'],
    channelId: f.votes.ch.id, randomize: true,
  });
  assert.equal(job.schedule, 'random_weekly');
  assert.ok(job.weekTimes.length >= 2 && job.weekTimes.length <= 3);
  const times = [...job.weekTimes];
  await setAutomaticVoteJobState(f.client, GUILD, job.id, 'running');
  await runWipeAutomationTick(f.client, times[0] - 1);
  assert.equal(f.votes.posts.length, 0);
  for (let i = 0; i < times.length; i++) {
    await Promise.all([
      runWipeAutomationTick(f.client, times[i] + 10),
      runWipeAutomationTick(f.client, times[i] + 10),
    ]);
    assert.equal(f.votes.posts.length, i + 1, 'one post per slot, even with concurrent ticks');
  }
  const updated = (await listAutomaticVotes(f.client, GUILD)).find(row => row.id === job.id);
  assert.equal(updated.weekIndex, 1, 'week plan advances after last slot');
  assert.ok(updated.nextRunAt > times.at(-1));
  await runWipeAutomationTick(f.client, times.at(-1) + 11);
  assert.equal(f.votes.posts.length, times.length);
});

test('auto vote job persists more than 50 media references without truncation', async () => {
  const f = fixture();
  const mediaLibrary = Array.from({ length: 60 }, (_, index) => ({
    channelId: '1569000000000000111',
    messageId: '1569000000000000222',
    name: `automedia_12345678_${index}.png`,
  }));
  const stored = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'repeat', repeatMinutes: 1440, durationMinutes: 30,
    question: 'Choose?', maps: ['A', 'B'], mediaLibrary,
  });
  assert.equal(stored.mediaLibrary.length, 60);
  assert.equal((await listAutomaticVotes(f.client, GUILD))[0].mediaLibrary.length, 60);
  await assert.rejects(() => saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'repeat', repeatMinutes: 1440, durationMinutes: 30,
    question: 'Choose?', maps: ['A', 'B'],
    mediaLibrary: [...mediaLibrary, { channelId: 'bad', messageId: '1', name: 'oops' }],
  }), RangeError);
});


test('running weekly votes can update media after their original start date, but new past dates fail', async () => {
  const f = fixture();
  const original = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'random_weekly', startAt: Date.now() + 3 * MINUTE,
    weeklyMin: 2, weeklyMax: 3, durationMinutes: 30,
    question: 'First?', maps: ['A', 'B'],
  });
  const legacyStart = Date.now() - 8 * 24 * 60 * MINUTE;
  const config = await getWipeAutomationConfig(f.client, GUILD);
  config.voteJobs[0].startAt = legacyStart;
  await f.db.set(`guild:${GUILD}:wipe-automations:v1`, config);
  const edited = await saveAutomaticVoteJob(f.client, GUILD, {
    ...config.voteJobs[0], question: 'Edited after first week?',
  }, original.id);
  assert.equal(edited.startAt, legacyStart);
  assert.equal(edited.question, 'Edited after first week?');
  await assert.rejects(() => saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'random_weekly', startAt: Date.now() - 2 * MINUTE,
    weeklyMin: 2, weeklyMax: 3, durationMinutes: 30,
    question: 'Past?', maps: ['A', 'B'],
  }), RangeError);
});


test('editing a repeat vote later never resets its existing scheduled run', async () => {
  const f = fixture();
  const job = await saveAutomaticVoteJob(f.client, GUILD, {
    schedule: 'repeat', repeatMinutes: 60, durationMinutes: 5,
    question: 'Initial question', maps: ['Yes', 'No'],
  });
  // A delayed edit must not drift by even a few milliseconds.
  await new Promise(resolve => { setTimeout(resolve, 12); });
  const updated = await saveAutomaticVoteJob(f.client, GUILD, {
    ...job, question: 'Updated question', maps: ['Agree', 'Disagree'],
  }, job.id);
  assert.equal(updated.nextRunAt, job.nextRunAt);
  assert.equal(updated.question, 'Updated question');
});
