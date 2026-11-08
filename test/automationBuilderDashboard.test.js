import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageFlags, PermissionFlagsBits } from 'discord.js';
import autoCommand from '../src/commands/Tools/auto.js';
import { amsterdamParts, parseAmsterdamStart } from '../src/services/automationSchedule.js';
import {
  openAutomationDashboard, handleAutomationBuilderInteraction,
} from '../src/services/automationBuilderService.js';
import {
  getWipeAutomationConfig, runWipeAutomationTick,
  configureWipeAutomation, setWipeAutomationState, observeWipeEvent,
  changeAutoWipeEntry, syncWipePrize,
} from '../src/services/wipeAutomationService.js';

const GUILD = '1532882647838228723';
const CHANNEL = '1569000000000000999';
const USER = '1569000000000000900';
const futureStart = amsterdamParts(Date.now() + 3 * 24 * 60 * 60_000);

function fixture() {
  const store = new Map(), posts = [];
  const db = {
    async get(key, fallback = null) { return store.has(key) ? structuredClone(store.get(key)) : fallback; },
    async set(key, value) { store.set(key, structuredClone(value)); return true; },
  };
  const channel = {
    id: CHANNEL, name: 'automation-target',
    isTextBased: () => true, isSendable: () => true,
    async send(payload) {
      const message = {
        id: String(1569000000000100000n + BigInt(posts.length)),
        author: { id: GUILD }, channelId: CHANNEL, ...payload,
        async edit(next) { Object.assign(message, next); return message; },
      };
      posts.push(message);
      return message;
    },
    messages: {
      async fetch(id) {
        if (typeof id === 'object') return new Collection(posts.map(m => [m.id, m]));
        return posts.find(msg => msg.id === id) || null;
      },
    },
  };
  const channels = new Collection([[CHANNEL, channel]]);
  const guild = {
    id: GUILD,
    channels: { cache: channels, fetch: async id => channels.get(id) || null },
    roles: { cache: new Collection() },
    members: { me: { permissions: { has: () => true },
      roles: { highest: { comparePositionTo: () => 1 } } } },
  };
  channel.guild = guild;
  const client = {
    db, user: { id: GUILD },
    guilds: { cache: new Collection([[GUILD, guild]]) },
    channels: { cache: channels },
  };
  const user = { id: USER };
  const memberPermissions = { has: flag => flag === PermissionFlagsBits.ManageGuild };
  let view = null, modal = null;
  const base = { guildId: GUILD, guild, client, user, memberPermissions };

  async function open(kind, { showList = false } = {}) {
    const interaction = {
      ...base,
      options: { getSubcommand: () => kind },
      async reply(payload) { view = payload; return payload; },
    };
    await autoCommand.execute(interaction, {}, client);
    assert.equal(view.flags, MessageFlags.Ephemeral);
    const firstButton = view.components.flatMap(row => row.toJSON().components)
      .find(component => component.type === 2);
    const id = firstButton.custom_id.split(':').at(-1);
    await action(id, showList ? 'manage' : 'new');
    return id;
  }

  async function action(id, command, values = [], extras = {}) {
    const interaction = {
      ...base,
      customId: `auto_builder:${command}:${id}`,
      values,
      isChannelSelectMenu: () => command === 'channel',
      isRoleSelectMenu: () => command === 'role',
      isStringSelectMenu: () => command === 'mode' || command === 'tag',
      async update(payload) { view = payload; },
      async deferUpdate() { this.deferred = true; },
      async editReply(payload) { view = payload; },
      async showModal(payload) { modal = payload.toJSON(); },
      async reply(payload) { view = payload; },
      ...extras,
    };
    const handled = await handleAutomationBuilderInteraction(interaction);
    assert.equal(handled, true);
    return { interaction, view, modal };
  }

  async function submit(id, kind, fields) {
    const savedMode = modal?.components?.find(row => row.component?.custom_id === 'scheduleType')
      ?.component?.options?.find(option => option.default)?.value || 'repeat';
    await action(id, 'modal', [], {
      customId: `auto_builder:modal:${id}:${kind}`,
      isModalSubmit: () => true,
      fields: { getTextInputValue: key => fields[key] || '',
        getStringSelectValues: key => key === 'scheduleType'
          ? [fields.scheduleType || savedMode]
          : Array.isArray(fields[key]) ? fields[key] : [],
        getField: key => ({ values: fields[key] ? [fields[key]] : [] }) },
    });
  }

  return { db, client, guild, posts, open, action, submit, base,
    get view() { return view; }, get modal() { return modal; } };
}

test('new /auto giveaway and /auto vote are real subcommands beside existing feed', () => {
  const command = autoCommand.data.toJSON();
  assert.equal(command.name, 'auto');
  assert.deepEqual(command.options.map(option => option.name), ['feed', 'giveaway', 'vote']);
  assert.deepEqual(command.options[1].options, []);
  assert.deepEqual(command.options[2].options, []);
});

test('vote builder has one private dashboard, channel chooser, modal inputs and scheduled control actions', async () => {
  const f = fixture();
  const id = await f.open('vote');
  assert.equal(f.view.components.length, 5);
  assert.equal(f.view.components[2].toJSON().components[0].type, 8);
  assert.deepEqual(f.view.components[4].toJSON().components.map(item => item.label),
    ['Back', 'Add media', 'Clear media']);
  assert.deepEqual(f.view.components[0].toJSON().components.map(item => item.label),
    ['Edit details', 'Schedule', 'Randomize: off']);
  assert.deepEqual(f.view.components[1].toJSON().components.map(item => item.label),
    ['Start', 'Pause', 'Save', 'Delete']);
  assert.equal(f.view.components[1].toJSON().components[0].disabled, true,
    'start cannot run before the automation has been saved');
  assert.match(f.view.embeds[0].toJSON().title, /Auto vote/i);

  await f.action(id, 'channel', [CHANNEL]);
  assert.match(f.view.embeds[0].toJSON().description, new RegExp(CHANNEL));
  await f.action(id, 'details');
  assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
    ['name', 'question', 'option1', 'option2', 'option3']);
  await f.submit(id, 'details', {
    question: 'Best map?', option1: 'First', option2: 'Second', option3: 'Third',
  });
  assert.match(f.view.embeds[0].toJSON().description, /Best map/);

  await f.action(id, 'schedule');
  assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
    ['date', 'time', 'repeat', 'duration']);
  await f.submit(id, 'schedule', {
    date: futureStart.date, time: futureStart.time, repeat: '15m', duration: '5m',
  });
  await f.action(id, 'random');
  assert.match(f.view.embeds[0].toJSON().description, /Randomize:\*\* On/);
  await f.action(id, 'save');
  let saved = (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0];
  assert.equal(saved.state, 'stopped');
  assert.equal(saved.channelId, CHANNEL);
  assert.equal(saved.repeatMinutes, 15);
  assert.equal(saved.durationMinutes, 5);
  assert.equal(saved.startAt, parseAmsterdamStart(futureStart.date, futureStart.time));
  assert.equal(saved.randomize, true);
  assert.equal(f.view.components[1].toJSON().components[0].disabled, false,
    'start becomes available only after saving');

  await f.action(id, 'start');
  saved = (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0];
  assert.equal(saved.state, 'running', f.view.embeds[0].toJSON().description);
  await runWipeAutomationTick(f.client, saved.nextRunAt + 10);
  assert.equal(f.posts.length, 1);
  assert.equal(f.view.components[1].toJSON().components[0].disabled, true,
    'start is disabled while running');
  assert.equal(f.view.components[1].toJSON().components[1].disabled, false,
    'pause is enabled while running');
  await f.action(id, 'pause');
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0].state, 'paused');
  assert.equal(f.view.components[1].toJSON().components[0].label, 'Resume');
  await f.action(id, 'start');
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0].state, 'running');
  await f.action(id, 'delete');
  assert.deepEqual(f.view.components[1].toJSON().components.map(item => item.label),
    ['Start', 'Pause', 'Save', 'Confirm delete']);
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0].state, 'running',
    'first delete press only asks for confirmation');
  await f.action(id, 'delete');
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs.length, 0,
    'second delete press removes the selected automation');
  assert.equal(f.view.embeds[0].toJSON().title, 'Auto vote');
});

test('auto giveaway matches the normal giveaway preview, editing and posting flow', async () => {
  const f = fixture();
  const id = await f.open('giveaway');
  assert.equal(f.view.components.length, 5, 'Discord permits no more than five action rows');
  assert.equal(f.view.embeds.length, 3, 'settings, normal giveaway and claim previews');
  assert.match(f.view.embeds[1].description, /Your prize/);
  assert.match(f.view.embeds[2].description, /Prize conditions/);
  assert.deepEqual(f.view.components[0].toJSON().components.map(b => b.label),
    ['Type', 'Edit text', 'Edit claim', 'Duration & winners']);
  assert.deepEqual(f.view.components[1].toJSON().components.map(b => b.label),
    ['Code', 'Schedule', 'Start', 'Pause']);
  assert.deepEqual(f.view.components[2].toJSON().components.map(b => b.label),
    ['Save', 'Delete', 'Back']);
  assert.equal(f.view.components[3].toJSON().components[0].type, 8,
    'posting channel stays in the fourth row');
  assert.equal(f.view.components[4].toJSON().components[0].type, 3,
    'tag picker stays in the fifth row');
  await f.action(id, 'schedule');
  assert.deepEqual(f.modal.components[0].component.options.map(x => x.value),
    ['repeat', 'once'], 'Standard giveaway scheduling remains unchanged');
  assert.doesNotMatch(JSON.stringify(f.view), /Before a Rust wipe|Connected Rust server name/);

  await f.action(id, 'channel', [CHANNEL]);
  await f.action(id, 'text');
  assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
    ['introTitle', 'description', 'prizes', 'requirements', 'closingText']);
  await f.submit(id, 'text', {
    introTitle: 'Giveaway time!', description: 'Community event',
    prizes: 'Kit A\nKit B', requirements: 'Be a community member',
    closingText: 'Good luck!',
  });
  assert.match(f.view.embeds[1].description, /Community event/);
  assert.match(f.view.embeds[1].description, /Be a community member/);

  await f.action(id, 'claim');
  assert.equal(f.modal.components.length, 5);
  await f.submit(id, 'claim', {
    claimIntroduction: 'Congratulations!', claimConditions: 'One per winner',
    claimHowToGet: 'Speak to staff', claimReview: 'Leave a review',
    claimPleaseNote: 'Closes in 24 hours',
  });
  assert.match(f.view.embeds[2].description, /Speak to staff/);
  await f.action(id, 'timing');
  assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
    ['name', 'duration', 'winners', 'randomize']);
  await f.submit(id, 'timing', { name: 'Community giveaway', duration: '15m',
    winners: '2', randomize: 'yes' });
  await f.action(id, 'schedule');
  assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
    ['scheduleType', 'date', 'time', 'repeat']);
  await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time, repeat: '1h' });
  await f.action(id, 'save');
  await f.action(id, 'start');
  const cfg = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
  assert.equal(cfg.state, 'running');
  assert.deepEqual(cfg.prizes, ['Kit A', 'Kit B']);
  assert.equal(cfg.description, 'Community event');
  assert.equal(cfg.claimHowToGet, 'Speak to staff');
  assert.equal(cfg.durationMinutes, 15);
  await runWipeAutomationTick(f.client, cfg.nextRunAt + 10);
  assert.equal(f.posts.length, 1);
  const posted = f.posts[0];
  const stored = await f.db.get(`guild:${GUILD}:giveaways`);
  const giveaway = stored[posted.id];
  assert.ok(giveaway, 'scheduled giveaway uses the normal persistent giveaway system');
  assert.ok(['Kit A', 'Kit B'].includes(giveaway.prize));
  assert.equal(giveaway.claimHowToGet, 'Speak to staff');
  assert.match(posted.embeds[0].description, /Community event/);
  assert.deepEqual(posted.components[0].toJSON().components.map(b => b.label),
    ['Enter giveaway', 'Leave giveaway']);
});

test('Auto Giveaway can switch to Once directly inside Schedule without a separate menu', async () => {
  const f = fixture();
  const id = await f.open('giveaway');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'text', {
    introTitle: 'Giveaway time!', prizes: 'One-time prize', closingText: 'Good luck!',
  });
  await f.action(id, 'schedule');
  assert.equal(f.modal.components[0].component.options.find(o => o.value === 'repeat').default, true);
  await f.submit(id, 'schedule', {
    scheduleType: 'once', date: futureStart.date, time: futureStart.time, repeat: 'invalid',
  });
  assert.match(f.view.embeds[0].toJSON().description, /Once \(selected date\)/);
  assert.notEqual(f.view.embeds[0].toJSON().title, 'Wrong information',
    'Repeat is ignored for Once');
  await f.action(id, 'save');
  await f.action(id, 'start');
  const config = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
  assert.equal(config.schedule, 'once');
  await runWipeAutomationTick(f.client, config.startAt + 5);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].embeds[0].description, /One-time prize/);
});

test('auto giveaway preserves tag, code and claim options in the posted giveaway', async () => {
  const f = fixture();
  const id = await f.open('giveaway');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'text', { introTitle: 'Giveaway time!', prizes: 'Premium kit',
    closingText: 'Good luck!' });
  await f.action(id, 'tag', ['everyone']);
  assert.match(f.view.embeds[0].toJSON().description, /Tag:\*\* @everyone/);
  await f.action(id, 'code');
  assert.equal(f.modal.title, 'Giveaway code');
  await f.submit(id, 'code', { codeType: ['kit'] });
  await f.action(id, 'mode', ['once']);
  await f.submit(id, 'schedule', { scheduleType: 'once', date: futureStart.date, time: futureStart.time });
  await f.action(id, 'save');
  const cfg = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
  assert.equal(cfg.codeType, 'kit');
  assert.equal(cfg.ping.type, 'everyone');
  await f.action(id, 'start');
  await runWipeAutomationTick(f.client, cfg.startAt + 5);
  const message = f.posts[0];
  assert.equal(message.content, '@everyone');
  assert.deepEqual(message.components[0].toJSON().components.map(x => x.custom_id),
    ['giveaway_enter', 'giveaway_leave']);
  const saved = await f.db.get('guild:' + GUILD + ':giveaways');
  assert.equal(saved[message.id].codeType, 'kit');
});

test('dashboard rejects foreign users and cannot start without a posting channel', async () => {
  const f = fixture();
  const denied = { ...f.base, memberPermissions: { has: () => false },
    async reply(payload) { return payload; } };
  const reply = await openAutomationDashboard(denied, 'vote');
  assert.match(reply.content, /Manage Server/);

  const id = await f.open('vote');
  await f.action(id, 'details');
  await f.submit(id, 'details', { question: 'Test?', option1: 'A', option2: 'B' });
  const result = await f.action(id, 'save');
  assert.match(result.view.embeds[0].toJSON().description, /Select a posting channel first/i);
  assert.equal(result.view.components.length, 5, 'validation must not close the dashboard');
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).vote, null);
});


test('historical Rust wipe auto giveaway opens with kit controls and no claim preview', async () => {
  const f = fixture();
  await configureWipeAutomation(f.client, GUILD, 'giveaway', {
    schedule: 'wipe', server: 'Cloudy Rust', beforeMinutes: 30, durationMinutes: 5,
    kit: 'Original kit', winnerCount: 1, winnerRoleId: '1569000000000000123',
  });
  const original = (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
  const id = await f.open('giveaway', { showList: true });
  await f.action(id, 'select', ['legacy']);
  assert.equal(f.view.embeds.length, 2, 'no claim preview');
  assert.deepEqual(f.view.components[0].toJSON().components.map(x => x.label),
    ['Type', 'Edit text', 'Kit & role', 'Duration & winners']);
  assert.deepEqual(f.view.components[1].toJSON().components.map(x => x.label),
    ['Schedule', 'Start', 'Pause']);
  await f.action(id, 'schedule');
  assert.deepEqual(f.modal.components.map(x => x.label),
    ['Connected Rust server name', 'Before wipe', 'Duration']);
  assert.match(f.view.embeds[0].toJSON().description, /Rust wipe/);
  assert.deepEqual((await getWipeAutomationConfig(f.client, GUILD)).giveaway, original);
});

test('Rust wipe auto giveaway saves as independent no-claim kit job and syncs temporary role', async () => {
  const f = fixture();
  const roleId = '1569000000000000123';
  f.guild.roles.cache.set(roleId, { id: roleId, managed: false });
  const id = await f.open('giveaway');
  await f.action(id, 'type');
  assert.deepEqual(f.modal.components[0].component.options.map(x => x.value),
    ['standard', 'wipe']);
  await f.submit(id, 'type', { giveawayType: ['wipe'] });
  assert.equal(f.view.embeds.length, 2, 'wipe has no claim preview');
  assert.deepEqual(f.view.components[0].toJSON().components.map(x => x.label),
    ['Type', 'Edit text', 'Kit & role', 'Duration & winners']);
  assert.deepEqual(f.view.components[1].toJSON().components.map(x => x.label),
    ['Schedule', 'Start', 'Pause']);
  await f.action(id, 'kit');
  assert.deepEqual(f.modal.components.map(x => (x.component || x.components[0]).custom_id),
    ['kit', 'winnerRole']);
  await f.submit(id, 'kit', { kit: 'Wipe starter kit', winnerRole: roleId });
  await f.action(id, 'text');
  assert.deepEqual(f.modal.components.map(x => (x.component || x.components[0]).custom_id),
    ['introTitle', 'description', 'requirements', 'closingText']);
  await f.submit(id, 'text', { introTitle: 'Giveaway time!',
    description: 'Rust wipe kit', requirements: 'Join the server', closingText: 'Good luck!' });
  await f.action(id, 'timing');
  assert.deepEqual(f.modal.components.map(x => (x.component || x.components[0]).custom_id),
    ['name', 'duration', 'winners']);
  await f.submit(id, 'timing', { name: 'Wipe kit', duration: '5m', winners: '1' });
  await f.action(id, 'channel', [CHANNEL]);
  await f.action(id, 'schedule');
  assert.deepEqual(f.modal.components.map(x => x.label),
    ['Connected Rust server name', 'Before wipe', 'Duration']);
  await f.submit(id, 'schedule', { server: 'Cloudy Rust', before: '20m', duration: '5m' });
  await f.action(id, 'save');
  const config = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
  assert.equal(config.giveawayType, 'wipe');
  assert.equal(config.schedule, 'wipe');
  assert.equal(config.codeType, 'none');
  assert.equal(config.winnerRoleId, roleId);
  assert.equal(config.kit, 'Wipe starter kit');
  await f.action(id, 'start');
  await observeWipeEvent(f.client, f.guild, {
    type: 'status', server: 'Cloudy Rust', nextWipe: Date.now() + 15 * 60_000,
  });
  assert.equal(f.posts.length, 1);
  assert.ok(!JSON.stringify(f.posts[0]).includes('claim'));
  assert.deepEqual(f.posts[0].components[0].toJSON().components.map(x => x.label),
    ['Enter giveaway', 'Leave giveaway']);
  const sessionId = f.posts[0].components[0].toJSON().components[0].custom_id.split(':')[1];
  assert.equal((await changeAutoWipeEntry(f.client, GUILD, sessionId, USER, true)).status, 'entered');
  await runWipeAutomationTick(f.client, Date.now() + 6 * 60_000);
  const assigned = new Set();
  const member = { id: USER, guild: f.guild, roles: {
    cache: { has: role => assigned.has(role) },
    async add(role) { assigned.add(role.id); },
  } };
  assert.equal((await syncWipePrize(f.client, member)).status, 'synced');
  assert.ok(assigned.has(roleId));
  assert.match(f.posts[0].embeds[0].data.description, /\/wipe sync/);
});

test('another user cannot operate someone else’s automation dashboard', async () => {
  const f = fixture();
  const id = await f.open('vote');
  let answer = null;
  await f.action(id, 'random', [], {
    user: { id: '1569000000000000200' },
    async reply(payload) { answer = payload; },
  });
  assert.equal(answer.flags, MessageFlags.Ephemeral);
  assert.match(answer.content, /belongs to another user/i);
  assert.match(f.view.embeds[0].toJSON().description, /Randomize:\*\* Off/);
});

test('Auto Giveaway uses the approved three button rows while vote stays unchanged', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    const rows = f.view.components.slice(0, kind === 'vote' ? 2 : 3)
      .map(row => row.toJSON().components);
    if (kind === 'vote') {
      assert.deepEqual(rows[0].map(item => item.label),
        ['Edit details', 'Schedule', 'Randomize: off']);
      assert.deepEqual(rows[1].map(item => item.label),
        ['Start', 'Pause', 'Save', 'Delete']);
    } else {
      assert.deepEqual(rows[0].map(item => item.label),
        ['Type', 'Edit text', 'Edit claim', 'Duration & winners']);
      assert.deepEqual(rows[1].map(item => item.label),
        ['Code', 'Schedule', 'Start', 'Pause']);
      assert.deepEqual(rows[2].map(item => item.label),
        ['Save', 'Delete', 'Back']);
      assert.equal(rows[1][2].disabled, true, 'Start disabled until saved');
      assert.equal(rows[1][3].disabled, true, 'Pause disabled until running');
      assert.equal(rows[2][0].disabled, false, 'Save available');
      assert.equal(rows[2][1].disabled, true, 'Delete disabled until saved');
    }
    await f.action(id, 'channel', [CHANNEL]);
    if (kind === 'vote') {
      await f.submit(id, 'details', { question: 'Your map?', option1: 'A', option2: 'B' });
    } else {
      await f.submit(id, 'text', { introTitle: 'Giveaway time!', prizes: 'Kit A',
        closingText: 'Good luck!' });
    }
    await f.submit(id, 'schedule', {
      scheduleType: 'repeat', date: futureStart.date, time: futureStart.time,
      repeat: '1d', duration: '1h',
    });
    await f.action(id, 'save');
    const saved = f.view.components.flatMap(row => row.toJSON().components);
    assert.equal(saved.find(item => item.custom_id === `auto_builder:start:${id}`).disabled, false);
    await f.action(id, 'start');
    const started = f.view.components.flatMap(row => row.toJSON().components);
    assert.equal(started.find(item => item.custom_id === `auto_builder:pause:${id}`).disabled, false);
    await f.action(id, 'pause');
    const paused = f.view.components.flatMap(row => row.toJSON().components);
    assert.equal(paused.find(item => item.custom_id === `auto_builder:start:${id}`).label, 'Resume');
    await f.action(id, 'list');
    assert.equal(f.view.embeds[0].toJSON().title, kind === 'vote' ? 'Auto vote' : 'Auto giveaway');
  }
});

test('Save does not stop a running vote and Start never implicitly saves edits', async () => {
  const f = fixture();
  const id = await f.open('vote');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'details', { question: 'Your map?', option1: 'A', option2: 'B' });
  await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time,
    repeat: '1d', duration: '1h' });
  await f.action(id, 'save');
  await f.action(id, 'start');
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0].state, 'running');
  await f.action(id, 'random');
  const buttons = f.view.components[1].toJSON().components;
  assert.equal(buttons[0].disabled, true, 'Start cannot silently save pending edits');
  await f.action(id, 'save');
  const updated = (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0];
  assert.equal(updated.state, 'running', 'saving an active configuration must not stop it');
  assert.equal(updated.randomize, true);
});

test('both dashboards accept an actual Netherlands calendar date and 1d duration', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'channel', [CHANNEL]);
    if (kind === 'vote') {
      await f.submit(id, 'details', { question: 'What next?', option1: 'Option A', option2: 'Option B' });
    } else {
      await f.submit(id, 'text', { introTitle: 'Giveaway time!', prizes: 'Special prize', closingText: 'Good luck!' });
    }
    await f.action(id, 'mode', ['once']);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
      kind === 'vote' ? ['date', 'time', 'duration'] : ['scheduleType', 'date', 'time', 'repeat']);
    await f.submit(id, 'schedule', { scheduleType: 'once', date: futureStart.date, time: futureStart.time, duration: '1d' });
    assert.match(f.view.embeds[0].toJSON().description, /Duration:\*\* 1d/);
    const expected = parseAmsterdamStart(futureStart.date, futureStart.time);
    await f.action(id, 'save');
    const config = kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
    assert.equal(config.schedule, 'once');
    assert.equal(config.startAt, expected);
    assert.equal(config.durationMinutes, 1440);
    await f.action(id, 'start');
    assert.equal((kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0]).state, 'running');
  }
});

test('invalid date does not save or close the automation builder', async () => {
  const f = fixture();
  const id = await f.open('vote');
  await f.action(id, 'mode', ['once']);
  await f.submit(id, 'schedule', { date: '31-02-2027', time: '18:00', duration: '1h' });
  assert.match(f.view.embeds[0].toJSON().description, /valid date/i);
  assert.ok(f.view.components.length, 'builder remains usable after a date validation error');
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).vote, null);
});

test('Auto Giveaway keeps schedule modes inside the Schedule modal', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'schedule');
    assert.equal(f.modal.title, 'Schedule');
    assert.deepEqual(f.modal.components.map(row => row.label),
      kind === 'vote'
        ? ['Date', 'Time (EU)', 'Repeat', 'Duration']
        : ['Schedule type', 'Date', 'Time (EU)', 'Repeat']);
    if (kind === 'giveaway') {
      assert.deepEqual(f.modal.components[0].component.options.map(o => o.value),
        ['repeat', 'once']);
      assert.equal(f.modal.components[0].component.type, 3);
      await f.action(id, 'timing');
      assert.equal(f.modal.title, 'Duration & winners');
      assert.equal(f.modal.components.length, 4);
    } else {
      assert.match(f.modal.components[3].description, /stays open/);
    }
    await f.action(id, 'mode', ['once']);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => row.label),
      kind === 'vote' ? ['Date', 'Time (EU)', 'Duration']
        : ['Schedule type', 'Date', 'Time (EU)', 'Repeat']);
    if (kind === 'vote') {
      await f.action(id, 'mode', ['wipe']);
      await f.action(id, 'schedule');
      assert.deepEqual(f.modal.components.map(row => row.label),
        ['Connected Rust server name', 'Before wipe', 'Duration']);
    } else {
      assert.equal(f.modal.components[0].component.options.find(o => o.value === 'once').default, true);
    }
  }
});

test('/auto vote opens a Feed-style flow and can create, select, edit, and delete votes', async () => {
  const f = fixture();
  const id = await f.open('vote');
  assert.equal(f.view.embeds[0].toJSON().title, 'Auto vote');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'details', {
    name: 'Daily map vote', question: 'First vote question', option1: 'One', option2: 'Two',
  });
  await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time,
    repeat: '1d', duration: '1h' });
  await f.action(id, 'save');
  const first = (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0];
  await f.action(id, 'list');
  assert.match(f.view.embeds[0].toJSON().description, /Daily map vote/);
  assert.match(f.view.embeds[0].toJSON().description, new RegExp(CHANNEL));
  assert.match(f.view.embeds[0].toJSON().description, /stopped/);
  assert.equal(f.view.components[0].toJSON().components[0].options[0].value, first.id);

  await f.action(id, 'back');
  assert.deepEqual(f.view.components[0].toJSON().components.map(x => x.label),
    ['Add vote', 'Manage vote']);
  await f.action(id, 'new');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'details', { question: 'Second vote question', option1: 'A', option2: 'B' });
  await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time,
    repeat: '1d', duration: '1h' });
  await f.action(id, 'save');
  await f.action(id, 'list');
  assert.match(f.view.embeds[0].toJSON().description, /Select the vote you want to manage/);
  assert.equal(f.view.components[0].toJSON().components[0].options.length, 2);

  await f.action(id, 'select', [first.id]);
  assert.match(f.view.embeds[0].toJSON().description, /First vote question/);
  await f.submit(id, 'details', {
    name: 'Daily map vote', question: 'First vote updated', option1: 'Yes', option2: 'No',
  });
  await f.action(id, 'save');
  const votes = (await getWipeAutomationConfig(f.client, GUILD)).voteJobs;
  assert.deepEqual(votes.map(v => v.question), ['First vote updated', 'Second vote question']);
  assert.deepEqual(votes.map(v => v.name), ['Daily map vote', '']);
  assert.equal(votes[0].id, first.id);
  await f.action(id, 'delete');
  assert.match(f.view.embeds[0].toJSON().description, /Confirm delete/);
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs.length, 2);
  await f.action(id, 'delete');
  assert.equal(f.view.embeds[0].toJSON().title, 'Auto vote');
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs.length, 1);
  assert.match(f.view.embeds[0].toJSON().description, /Second vote question/);
});

test('existing legacy vote is visible in the list and its schedule stays intact', async () => {
  const f = fixture();
  await configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 60, durationMinutes: 5,
    question: 'Previously saved vote', maps: ['Map A', 'Map B'], channelId: CHANNEL,
  });
  await setWipeAutomationState(f.client, GUILD, 'vote', 'running');
  const original = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  const id = await f.open('vote', { showList: true });
  assert.match(f.view.embeds[0].toJSON().description, /Previously saved vote/);
  assert.match(f.view.embeds[0].toJSON().description, /running/);
  assert.equal(f.view.components[0].toJSON().components[0].options[0].value, 'legacy');
  await f.action(id, 'select', ['legacy']);
  assert.match(f.view.embeds[0].toJSON().description, /Previously saved vote/);
  assert.equal(f.view.components[1].toJSON().components[2].disabled, false);
  await f.action(id, 'list');
  const current = (await getWipeAutomationConfig(f.client, GUILD)).vote;
  assert.equal(current.question, original.question);
  assert.equal(current.nextRunAt, original.nextRunAt);
  assert.equal(current.state, 'running');
});

test('auto vote list can be reopened and reflects saved statuses without needing a second bot message', async () => {
  const f = fixture();
  const originalId = await f.open('vote');
  await f.action(originalId, 'channel', [CHANNEL]);
  await f.submit(originalId, 'details', {
    question: 'Recurring question', option1: 'Red', option2: 'Blue',
  });
  await f.submit(originalId, 'schedule', { date: futureStart.date, time: futureStart.time,
    repeat: '1d', duration: '1h' });
  await f.action(originalId, 'save');
  await f.action(originalId, 'start');
  const id = await f.open('vote', { showList: true });
  const description = f.view.embeds[0].toJSON().description;
  assert.match(description, /Recurring question/);
  assert.match(description, /running/);
  assert.match(description, /Next:/);
  assert.equal(f.view.embeds[0].toJSON().color, 0xFFFFFF);
  await f.action(id, 'refresh');
  assert.match(f.view.embeds[0].toJSON().description, /Recurring question/);
});

test('older Rust-wipe auto votes without an explicit schedule are listed accurately', async () => {
  const f = fixture();
  await f.db.set(`guild:${GUILD}:wipe-automations:v1`, {
    vote: {
      server: 'Cloudy Rust', question: 'Original Rust wipe vote',
      maps: ['Map A', 'Map B'], beforeMinutes: 45, durationMinutes: 5,
      state: 'running',
    },
    wipes: {},
  });
  const id = await f.open('vote', { showList: true });
  assert.match(f.view.embeds[0].toJSON().description, /Original Rust wipe vote/);
  assert.match(f.view.embeds[0].toJSON().description, /Rust wipe/);
  await f.action(id, 'select', ['legacy']);
  assert.match(f.view.embeds[0].toJSON().description, /45 minutes before the.*Rust.*wipe/i);
  const choices = f.view.components[3].toJSON().components[0].options;
  assert.equal(choices.find(x => x.value === 'wipe').default, true);
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).vote.schedule, undefined);
});

test('auto vote landing page matches the Cloudy feed Add/Manage flow', async () => {
  const f = fixture();
  const initial = await openAutomationDashboard({
    ...f.base, async reply(payload) { return payload; },
  }, 'vote');
  const embed = initial.embeds[0].toJSON();
  assert.equal(embed.title, 'Auto vote');
  assert.equal(embed.color, 0xFFFFFF);
  assert.equal(initial.flags, MessageFlags.Ephemeral);
  assert.deepEqual(initial.components[0].toJSON().components.map(button => button.label),
    ['Add vote', 'Manage vote']);
  assert.equal(initial.components[0].toJSON().components[1].disabled, true,
    'cannot manage votes when none are saved');

  await configureWipeAutomation(f.client, GUILD, 'vote', {
    schedule: 'repeat', repeatMinutes: 60, durationMinutes: 5,
    question: 'Existing map vote', maps: ['Map A', 'Map B'],
  });
  const id = await f.open('vote', { showList: true });
  assert.deepEqual(f.view.components.map(row => row.toJSON().components.map(x => x.type)),
    [[3], [2]], 'manage shows a select and a Back row just like Auto feed');
  await f.action(id, 'back');
  assert.deepEqual(f.view.components[0].toJSON().components.map(button => button.label),
    ['Add vote', 'Manage vote']);
  assert.equal(f.view.components[0].toJSON().components[1].disabled, false);
  await f.action(id, 'manage');
  assert.match(f.view.embeds[0].toJSON().description, /Existing map vote/);
});

test('explicit EU date and time separators save correctly for vote and giveaway', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'channel', [CHANNEL]);
    if (kind === 'vote') {
      await f.submit(id, 'details', { question: 'Test vote?', option1: 'Yes', option2: 'No' });
    } else {
      await f.submit(id, 'text', { introTitle: 'Giveaway time!', prizes: 'A prize', closingText: 'Good luck!' });
      await f.submit(id, 'timing', { name: 'Test', duration: '1m', winners: '1', randomize: 'no' });
    }
    await f.action(id, 'schedule');
    await f.submit(id, 'schedule', {
      date: futureStart.date, time: futureStart.time, repeat: '1d', duration: '1m',
    });
    const expected = parseAmsterdamStart(futureStart.date, futureStart.time);
    assert.match(f.view.embeds[0].toJSON().description, /Duration:\*\* 1m/);
    await f.action(id, 'schedule');
    const values = f.modal.components.map(row => (row.component || row.components[0]).value);
    assert.deepEqual(values, kind === 'vote'
      ? [futureStart.date, futureStart.time, '1d', '1m']
      : [undefined, futureStart.date, futureStart.time, '1d']);
    await f.action(id, 'save');
    const saved = kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
    assert.equal(saved.startAt, expected);
    assert.equal(saved.durationMinutes, 1);
  }
});

test('invalid schedule turns the private dashboard line red, preserves entered fields, and recovers', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    const inputValues = { date: '31112027', time: '1800', repeat: '1d', duration: '1h' };
    await f.submit(id, 'schedule', inputValues);
    assert.equal(f.view.embeds[0].toJSON().color, 0xE53935);
    assert.match(f.view.embeds[0].toJSON().description, /valid date/i);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).value),
      kind === 'vote' ? Object.values(inputValues) : [undefined, inputValues.date, inputValues.time, inputValues.repeat]);
    await f.submit(id, 'schedule', {
      date: futureStart.date, time: futureStart.time, repeat: '1d', duration: '1h',
    });
    assert.notEqual(f.view.embeds[0].toJSON().color, 0xE53935);
    assert.doesNotMatch(f.view.embeds[0].toJSON().description, /valid date/i);
  }
});

test('invalid repeat and duration units are rejected without saving a schedule', async () => {
  const f = fixture();
  const id = await f.open('vote');
  const base = { date: futureStart.date, time: futureStart.time };
  await f.submit(id, 'schedule', { ...base, repeat: '123x', duration: '1h' });
  assert.equal(f.view.embeds[0].toJSON().color, 0xE53935);
  await f.submit(id, 'schedule', { ...base, repeat: '1d', duration: 'abc' });
  assert.equal(f.view.embeds[0].toJSON().color, 0xE53935);
  assert.match(f.view.embeds[0].toJSON().description, /Duration: use/i);
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).voteJobs.length, 0);
});

test('Time rejects letters immediately on submission for both dashboards', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.submit(id, 'schedule', {
      date: futureStart.date, time: 'abcd', repeat: '1d', duration: '1m',
    });
    assert.equal(f.view.embeds[0].toJSON().color, 0xE53935);
    assert.match(f.view.embeds[0].toJSON().description,
      /Invalid Time: use 18:00/i);
    await f.action(id, 'schedule');
    assert.equal(f.modal.components[kind === 'vote' ? 1 : 2].component.value, 'abcd');
    const cfg = await getWipeAutomationConfig(f.client, GUILD);
    assert.equal(kind === 'vote' ? cfg.voteJobs.length : cfg.giveaway, kind === 'vote' ? 0 : null);
  }
});

test('Repeat 1m and Duration 1m are valid with separate giveaway duration controls', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'channel', [CHANNEL]);
    if (kind === 'vote') {
      await f.submit(id, 'details', { question: 'Minute vote?', option1: 'A', option2: 'B' });
    } else {
      await f.submit(id, 'text', { introTitle: 'Giveaway time!', prizes: 'One prize',
        closingText: 'Good luck!' });
      await f.action(id, 'timing');
      await f.submit(id, 'timing', { duration: '1m', winners: '1', randomize: 'no' });
    }
    await f.action(id, 'schedule');
    assert.match(f.modal.components[kind === 'vote' ? 2 : 3].description, /1m.*1d.*1w/);
    if (kind === 'vote') {
      assert.match(f.modal.components[3].description, /How long.*stays open.*1m.*1d.*1w/);
    } else {
      assert.equal(f.modal.components.length, 4);
    }
    await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time,
      repeat: '1m', duration: '1m' });
    assert.notEqual(f.view.embeds[0].toJSON().color, 0xE53935);
    await f.action(id, 'save');
    const saved = kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
    assert.equal(saved.repeatMinutes, 1);
    assert.equal(saved.durationMinutes, 1);
  }
});

test('Schedule modals keep valid Discord Label components for each supported mode', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    const modes = kind === 'vote' ? ['repeat', 'once', 'wipe'] : ['repeat', 'once'];
    for (const mode of modes) {
      await f.action(id, 'mode', [mode]);
      await f.action(id, 'schedule');
      assert.equal(f.modal.title, 'Schedule');
      const expected = kind === 'vote' ? (mode === 'repeat' ? 4 : 3) : 4;
      assert.equal(f.modal.components.length, expected);
      for (const [index, label] of f.modal.components.entries()) {
        assert.equal(label.type, 18);
        assert.equal(label.component.type, kind === 'giveaway' && index === 0 ? 3 : 4);
        assert.ok(label.label);
        assert.ok(label.description);
        assert.equal(Object.hasOwn(label.component, 'label'), false);
      }
    }
    await f.action(id, kind === 'vote' ? 'details' : 'text');
    for (const row of f.modal.components) assert.ok(row.components[0].label);
  }
});

test('changing vote schedule mode never reuses Rust wipe values as Date or Time', async () => {
  const f = fixture();
  const id = await f.open('vote');
  await f.action(id, 'mode', ['wipe']);
  await f.action(id, 'schedule');
  const wipeModal = f.modal;
  assert.deepEqual(wipeModal.components.map(row => row.label),
    ['Connected Rust server name', 'Before wipe', 'Duration']);
  await f.submit(id, 'schedule', { server: 'Cloudy Rust', before: '10m', duration: '20m' });
  assert.equal(f.view.embeds[0].toJSON().color, 0xE53935);
  await f.action(id, 'mode', ['repeat']);
  await f.action(id, 'schedule');
  const datedModal = f.modal;
  assert.notEqual(datedModal.custom_id, wipeModal.custom_id);
  assert.deepEqual(datedModal.components.map(row => row.label),
    ['Date', 'Time (EU)', 'Repeat', 'Duration']);
  assert.equal(datedModal.components[0].component.value, undefined);
  assert.equal(datedModal.components[1].component.value, undefined);
  await f.action(id, 'schedule');
  assert.notEqual(f.modal.custom_id, datedModal.custom_id);
  await f.action(id, 'modal', [], {
    customId: wipeModal.custom_id,
    isModalSubmit: () => true,
    fields: { getTextInputValue: key => ({ server: 'Cloudy Rust', before: '10m', duration: '1m' })[key] || '' },
  });
  assert.match(f.view.embeds[0].toJSON().description, /outdated/i);
});

test('schedule instructions describe only relevant options for each automation type', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'schedule');
    assert.match(f.modal.components[kind === 'vote' ? 2 : 3].description,
      kind === 'vote' ? /new vote starts/ : /Interval between giveaways/);
    if (kind === 'vote') {
      assert.match(f.modal.components[3].description, /stays open/);
      await f.action(id, 'mode', ['wipe']);
      await f.action(id, 'schedule');
      assert.match(f.modal.components[1].description, /starts before the wipe/);
      assert.match(f.modal.components[2].description, /stays open/);
    } else {
      assert.deepEqual(f.modal.components[0].component.options.map(x => x.value),
        ['repeat', 'once']);
      await f.action(id, 'timing');
      assert.equal(f.modal.title, 'Duration & winners');
      assert.equal(f.modal.components[1].components[0].label, 'Duration');
    }
  }
});

test('starting another auto vote clears unsaved Schedule values from the previous vote', async () => {
  const f = fixture();
  const id = await f.open('vote');
  await f.submit(id, 'schedule', {
    date: '31112027', time: '1800', repeat: '1d', duration: '1m',
  });
  assert.equal(f.view.embeds[0].toJSON().color, 0xE53935);
  await f.action(id, 'back');
  await f.action(id, 'new');
  await f.action(id, 'schedule');
  assert.equal(f.modal.components[0].component.value, undefined);
  assert.equal(f.modal.components[1].component.value, undefined);
  assert.notEqual(f.view.embeds[0].toJSON().color, 0xE53935);
});


test('Add media accepts 60 pictures in six uploads and preserves them after Save', async () => {
  const f = fixture();
  const id = await f.open('vote');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'details', { question: 'Media test?', option1: 'A', option2: 'B' });
  await f.submit(id, 'schedule', {
    date: futureStart.date, time: futureStart.time, repeat: '1d', duration: '1h',
  });
  const thread = {
    id: '1569000000000222000',
    async send({ files }) {
      return {
        id: String(1569000000000333000n + BigInt(posted.length)),
        attachments: new Collection(files.map(file =>
          [file.name, { name: file.name, url: `https://cdn.discordapp.com/attachments/111/222/${file.name}` }])),
      };
    },
  };
  const posted = [];
  const originalSend = thread.send;
  thread.send = async data => {
    const message = await originalSend(data);
    posted.push(message);
    return message;
  };
  f.guild.channels.cache.set('1569000000000333444', {
    id: '1569000000000333444', type: ChannelType.GuildText,
    name: 'botlog', threads: { create: async () => thread },
  });
  f.client.channels.fetch = async channelId => channelId === thread.id ? thread : null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, arrayBuffer: async () => Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10).buffer,
  });
  try {
    for (let batch = 0; batch < 6; batch++) {
      await f.action(id, 'media');
      const modalId = f.modal.custom_id;
      const uploads = new Collection(Array.from({ length: 10 }, (_, index) =>
        [String(index), {
          url: `https://cdn.discordapp.com/attachments/test/${batch}/${index}.png`,
          contentType: 'image/png', size: 8,
        }]));
      await f.action(id, 'media', [], {
        customId: modalId, isModalSubmit: () => true,
        fields: { getUploadedFiles: () => uploads },
      });
      assert.match(f.view.embeds[0].toJSON().description,
        new RegExp(`\\*\\*Media:\\*\\* ${(batch + 1) * 10} saved`));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(posted.length, 6);
  await f.action(id, 'save');
  const stored = (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0];
  assert.equal(stored.mediaLibrary.length, 60);
  assert.equal(new Set(stored.mediaLibrary.map(item => item.name)).size, 60);
  await f.action(id, 'clear_media');
  assert.match(f.view.embeds[0].toJSON().description, /Confirm clear/);
  await f.action(id, 'clear_media');
  assert.ok(f.view.embeds[0].toJSON().description.includes('**Media:** 0 saved'));
});


test('invalid schedule blocks Save and Start even after a previously valid schedule', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'channel', [CHANNEL]);
    await f.submit(id, 'details', kind === 'vote'
      ? { question: 'Pick?', option1: 'A', option2: 'B' }
      : { prizes: 'Prize', winners: '1' });
    const valid = { date: futureStart.date, time: futureStart.time, repeat: '1d', duration: '1h' };
    await f.submit(id, 'schedule', valid);
    await f.action(id, 'save');
    const before = await getWipeAutomationConfig(f.client, GUILD);
    await f.submit(id, 'schedule', { ...valid, time: 'wrong' });
    assert.equal(f.view.embeds[0].toJSON().title, 'Wrong information');
    assert.equal(f.view.embeds[0].toJSON().color, 0xE53935);
    const controls = f.view.components.flatMap(row => row.toJSON().components);
    for (const action of ['save', 'start']) {
      assert.equal(controls.find(item => item.custom_id === `auto_builder:${action}:${id}`).disabled, true);
      await f.action(id, action);
      assert.deepEqual(await getWipeAutomationConfig(f.client, GUILD), before);
    }
    await f.submit(id, 'schedule', valid);
    assert.notEqual(f.view.embeds[0].toJSON().title, 'Wrong information');
    assert.equal(f.view.components.flatMap(row => row.toJSON().components)
      .find(item => item.custom_id === `auto_builder:save:${id}`).disabled, false);
  }
});

test('auto giveaway offers Add and Manage with independent saved schedules', async () => {
  const f = fixture();
  const landing = await openAutomationDashboard({ ...f.base, async reply(payload) { return payload; } }, 'giveaway');
  assert.deepEqual(landing.components[0].toJSON().components.map(button => button.label),
    ['Add giveaway', 'Manage giveaway']);
  assert.equal(landing.components[0].toJSON().components[1].disabled, true);

  const id = await f.open('giveaway');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'details', { name: 'Daily kits', prizes: 'Kit A\nKit B', winners: '2' });
  await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time,
    repeat: '1d', duration: '1h' });
  await f.action(id, 'save');
  await f.action(id, 'start');
  const original = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs[0];
  assert.equal(original.name, 'Daily kits');
  assert.equal(original.state, 'running');
  await f.action(id, 'list');
  assert.match(f.view.embeds[0].toJSON().description, /Daily kits/);
  await f.action(id, 'back');
  assert.deepEqual(f.view.components[0].toJSON().components.map(x => x.label),
    ['Add giveaway', 'Manage giveaway']);

  await f.action(id, 'new');
  await f.action(id, 'channel', [CHANNEL]);
  await f.submit(id, 'details', { name: 'Special kit', prizes: 'VIP prize', winners: '1' });
  await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time,
    repeat: '1w', duration: '1d' });
  await f.action(id, 'save');
  let jobs = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs;
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].id, jobs[1].id);
  assert.equal(jobs[1].state, 'stopped');
  await f.action(id, 'list');
  assert.equal(f.view.components[0].toJSON().components[0].options.length, 2);
  assert.match(f.view.embeds[0].toJSON().description, /Special kit/);

  await f.action(id, 'select', [original.id]);
  await f.submit(id, 'details', { name: 'Daily kits updated', prizes: 'Updated kit', winners: '1' });
  await f.action(id, 'save');
  jobs = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs;
  assert.equal(jobs[0].id, original.id);
  assert.equal(jobs[0].state, 'running');
  assert.equal(jobs[0].nextRunAt, original.nextRunAt, 'editing does not reset the next run');
  assert.equal(jobs[1].name, 'Special kit', 'editing one job must not change another');
  await runWipeAutomationTick(f.client, jobs[0].nextRunAt + 10);
  assert.equal(f.posts.length, 1, 'only running giveaways publish');
  assert.match(f.posts[0].embeds[0].description, /Updated kit/);
  await runWipeAutomationTick(f.client, jobs[0].nextRunAt + 10);
  assert.equal(f.posts.length, 1, 'the same scheduled giveaway cannot post twice');

  await f.action(id, 'delete');
  assert.match(f.view.embeds[0].toJSON().description, /Confirm delete/);
  assert.equal((await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs.length, 2);
  await f.action(id, 'delete');
  jobs = (await getWipeAutomationConfig(f.client, GUILD)).giveawayJobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'Special kit');
});