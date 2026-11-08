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
  configureWipeAutomation, setWipeAutomationState,
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
    if (kind === 'vote') await action(id, showList ? 'manage' : 'new');
    return id;
  }

  async function action(id, command, values = [], extras = {}) {
    const interaction = {
      ...base,
      customId: `auto_builder:${command}:${id}`,
      values,
      isChannelSelectMenu: () => command === 'channel',
      isRoleSelectMenu: () => command === 'role',
      isStringSelectMenu: () => command === 'mode',
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
    await action(id, 'modal', [], {
      customId: `auto_builder:modal:${id}:${kind}`,
      isModalSubmit: () => true,
      fields: { getTextInputValue: key => fields[key] || '' },
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

test('giveaway builder supports prizes, role choice, and safe repeated scheduling', async () => {
  const f = fixture();
  const id = await f.open('giveaway');
  assert.equal(f.view.components.length, 5);
  await f.action(id, 'channel', [CHANNEL]);
  await f.action(id, 'details');
  assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
    ['prizes', 'winners', 'description']);
  await f.submit(id, 'details', { prizes: 'Kit A\nKit B', winners: '2', description: 'Community event' });
  await f.action(id, 'schedule');
  await f.submit(id, 'schedule', {
    date: futureStart.date, time: futureStart.time, repeat: '1h', duration: '15m',
  });
  await f.action(id, 'random');
  await f.action(id, 'save');
  await f.action(id, 'start');
  const cfg = (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
  assert.equal(cfg.state, 'running');
  assert.deepEqual(cfg.prizes, ['Kit A', 'Kit B']);
  assert.equal(cfg.description, 'Community event');
  assert.equal(cfg.winnerRoleId, '');
  await runWipeAutomationTick(f.client, cfg.nextRunAt + 10);
  assert.equal(f.posts.length, 1);
  const embed = f.posts[0].embeds[0];
  assert.match(embed.description, /Community event/);
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


test('wipe mode is editable in the dashboard without changing the legacy wipe scheduler', async () => {
  const f = fixture();
  const roleId = '1569000000000000123';
  f.guild.roles.cache.set(roleId, { id: roleId, managed: false });
  const id = await f.open('giveaway');
  await f.action(id, 'channel', [CHANNEL]);
  await f.action(id, 'role', [roleId]);
  await f.action(id, 'mode', ['wipe']);
  await f.action(id, 'details');
  await f.submit(id, 'details', { prizes: 'Wipe kit', winners: '2', description: 'New Rust wipe!' });
  await f.action(id, 'schedule');
  assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
    ['server', 'before', 'duration']);
  await f.submit(id, 'schedule', { server: 'Cloudy Rust', before: '30m', duration: '5m' });
  await f.action(id, 'save');
  await f.action(id, 'start');
  const cfg = (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
  assert.equal(cfg.schedule, 'wipe');
  assert.equal(cfg.server, 'Cloudy Rust');
  assert.equal(cfg.channelId, CHANNEL);
  assert.equal(cfg.winnerRoleId, roleId);
  assert.equal(cfg.state, 'running');
  assert.equal(cfg.beforeMinutes, 30);
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

test('vote and giveaway always use the same compact two-row button layout', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    let rows = f.view.components.slice(0, 2).map(row => row.toJSON().components);
    assert.deepEqual(rows[0].map(item => item.label),
      ['Edit details', 'Schedule', 'Randomize: off']);
    assert.deepEqual(rows[1].map(item => item.label), kind === 'vote'
      ? ['Start', 'Pause', 'Save', 'Delete']
      : ['Save', 'Start', 'Pause', 'Stop', 'Cancel']);
    assert.equal(rows[0].length, 3);
    assert.equal(rows[1].length, kind === 'vote' ? 4 : 5,
      'management controls fit on one Discord action row');
    assert.deepEqual(rows[1].map(item => item.disabled),
      kind === 'vote' ? [true, true, false, true] : [false, true, true, true, false],
      'delete cannot be used until a vote is saved');

    await f.action(id, 'channel', [CHANNEL]);
    if (kind === 'vote') {
      await f.submit(id, 'details', { question: 'Your map?', option1: 'A', option2: 'B' });
    } else {
      await f.submit(id, 'details', { prizes: 'Kit A', winners: '1' });
    }
    await f.submit(id, 'schedule', { date: futureStart.date, time: futureStart.time,
      repeat: '1d', duration: '1h' });
    await f.action(id, 'save');
    rows = f.view.components.slice(0, 2).map(row => row.toJSON().components);
    assert.deepEqual(rows[1].map(item => item.label), kind === 'vote'
      ? ['Start', 'Pause', 'Save', 'Delete']
      : ['Save', 'Start', 'Pause', 'Stop', 'Cancel']);
    assert.deepEqual(rows[1].map(item => item.disabled),
      kind === 'vote' ? [false, true, false, false]
        : [false, false, true, true, false]);

    await f.action(id, 'start');
    rows = f.view.components.slice(0, 2).map(row => row.toJSON().components);
    assert.deepEqual(rows[1].map(item => item.disabled),
      kind === 'vote' ? [true, false, false, false] : [false, true, false, false, false]);

    await f.action(id, 'pause');
    rows = f.view.components.slice(0, 2).map(row => row.toJSON().components);
    assert.deepEqual(rows[1].map(item => item.label), kind === 'vote'
      ? ['Resume', 'Pause', 'Save', 'Delete']
      : ['Save', 'Resume', 'Pause', 'Stop', 'Cancel']);
    assert.deepEqual(rows[1].map(item => item.disabled),
      kind === 'vote' ? [false, true, false, false] : [false, false, true, false, false]);

    if (kind === 'vote') {
      await f.action(id, 'list');
      assert.equal(f.view.embeds[0].toJSON().title, 'Auto vote');
    } else {
      await f.action(id, 'close');
      assert.equal(f.view.content, 'Automation builder closed.');
      assert.deepEqual(f.view.components, []);
    }
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
      await f.submit(id, 'details', { prizes: 'Special prize', winners: '1' });
    }
    await f.action(id, 'mode', ['once']);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).custom_id),
      ['date', 'time', 'duration']);
    await f.submit(id, 'schedule', {
      date: futureStart.date, time: futureStart.time, duration: '1d',
    });
    assert.match(f.view.embeds[0].toJSON().description, /Duration:\*\* 1d/);
    const expected = parseAmsterdamStart(futureStart.date, futureStart.time);
    assert.match(f.view.embeds[0].toJSON().description,
      new RegExp(`Start date:\\*\\* <t:${Math.floor(expected / 1000)}:F>`));
    await f.action(id, 'save');
    let config = kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
    assert.equal(config.schedule, 'once');
    assert.equal(config.startAt, expected);
    assert.equal(config.durationMinutes, 1440);
    await f.action(id, 'start');
    config = kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
    assert.equal(config.nextRunAt, expected);
    assert.equal(config.state, 'running');
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

test('schedule modal keeps short labels and simple examples for auto vote and giveaway', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'schedule');
    assert.equal(f.modal.title, 'Schedule');
    assert.deepEqual(f.modal.components.map(row => row.label || row.components?.[0]?.label),
      ['Date', 'Time (EU)', 'Repeat', 'Duration']);
    assert.deepEqual(f.modal.components.map(row => row.description),
      ['Date: DD-MM-YYYY (future date only).',
        'Time: HH:MM (24-hour clock).',
        `How often a new ${kind} starts. E.g. 1m, 1h, 1d, 1w.`,
        `How long the ${kind} stays open. E.g. 1m, 1h, 1d, 1w.`]);
    assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).placeholder),
      ['DD-MM-YYYY (e.g. 10-11-2027)', 'HH:MM (e.g. 18:00)',
        '1m, 1h, 1d, 1w',
        '1m, 1h, 1d, 1w']);
    await f.action(id, 'mode', ['once']);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => row.label || row.components?.[0]?.label),
      ['Date', 'Time (EU)', 'Duration']);
    await f.action(id, 'mode', ['wipe']);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => row.label || row.components?.[0]?.label),
      ['Connected Rust server name', 'Before wipe', 'Duration']);
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
      await f.submit(id, 'details', { prizes: 'A prize', winners: '1' });
    }
    await f.action(id, 'schedule');
    await f.submit(id, 'schedule', {
      date: futureStart.date, time: futureStart.time, repeat: '1d', duration: '1m',
    });
    const expected = parseAmsterdamStart(futureStart.date, futureStart.time);
    assert.match(f.view.embeds[0].toJSON().description, /Duration:\*\* 1m/);
    await f.action(id, 'schedule');
    const values = f.modal.components.map(row => (row.component || row.components[0]).value);
    assert.deepEqual(values, [futureStart.date, futureStart.time, '1d', '1m'],
      'reopening Schedule shows the validated date and time');
    await f.action(id, 'save');
    const saved = kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
    assert.equal(saved.startAt, expected);
    assert.equal(saved.durationMinutes, 1);
  }
});

test('invalid schedule turns the private dashboard line red, preserves entered fields, and recovers', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    const inputValues = {
      date: '31112027', time: '1800', repeat: '1d', duration: '1h',
    };
    await f.submit(id, 'schedule', inputValues);
    assert.equal(f.view.embeds[0].toJSON().color, 0xE53935,
      'invalid date must produce a red dashboard line');
    assert.match(f.view.embeds[0].toJSON().description, /valid date/i);
    assert.ok(f.view.components.length, 'invalid schedule must not close the controls');
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => (row.component || row.components[0]).value),
      Object.values(inputValues), 'submitted text remains available for correction');
    await f.submit(id, 'schedule', {
      date: futureStart.date,
      time: futureStart.time,
      repeat: '1d', duration: '1h',
    });
    assert.equal(f.view.embeds[0].toJSON().color,
      kind === 'vote' ? 0xFFFFFF : 0xDC2626,
      'valid correction restores the original dashboard line color');
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
      /Invalid Time: use HH:MM/i);
    await f.action(id, 'schedule');
    assert.equal(f.modal.components[1].component.value, 'abcd');
    const cfg = await getWipeAutomationConfig(f.client, GUILD);
    assert.equal(kind === 'vote' ? cfg.voteJobs.length : cfg.giveaway, kind === 'vote' ? 0 : null);
  }
});

test('Repeat 1m and Duration 1m are valid and appear with explanations in the modal', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'channel', [CHANNEL]);
    if (kind === 'vote') {
      await f.submit(id, 'details', { question: 'Minute vote?', option1: 'A', option2: 'B' });
    } else {
      await f.submit(id, 'details', { prizes: 'One prize', winners: '1' });
    }
    await f.action(id, 'schedule');
    assert.match(f.modal.components[2].description, /How often.*1m.*1d.*1w/);
    assert.match(f.modal.components[3].description, /How long.*stays open.*1m.*1d.*1w/);
    await f.submit(id, 'schedule', {
      date: futureStart.date,
      time: futureStart.time,
      repeat: '1m', duration: '1m',
    });
    assert.notEqual(f.view.embeds[0].toJSON().color, 0xE53935);
    await f.action(id, 'save');
    const saved = kind === 'vote'
      ? (await getWipeAutomationConfig(f.client, GUILD)).voteJobs[0]
      : (await getWipeAutomationConfig(f.client, GUILD)).giveaway;
    assert.equal(saved.repeatMinutes, 1);
    assert.equal(saved.durationMinutes, 1);
  }
});

test('Schedule modals are valid Discord Label components without nested text input labels', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    for (const mode of ['repeat', 'once', 'wipe']) {
      await f.action(id, 'mode', [mode]);
      await f.action(id, 'schedule');
      assert.equal(f.modal.title, 'Schedule');
      assert.equal(f.modal.components.length, mode === 'repeat' ? 4 : 3);
      for (const label of f.modal.components) {
        assert.equal(label.type, 18, 'Discord modal must contain a Label component');
        assert.equal(label.component.type, 4, 'the Label must contain a TextInput');
        assert.ok(label.label, 'the outer Label must have a name');
        assert.ok(label.description, 'the help text remains visible');
        assert.equal(Object.hasOwn(label.component, 'label'), false,
          'Discord API 50035 rejects TextInput.label inside a Label component');
      }
    }
    await f.action(id, 'details');
    for (const row of f.modal.components) {
      assert.ok(row.components[0].label, 'existing edit-details fields keep their labels');
    }
  }
});

test('changing schedule mode never reuses Rust wipe values as Date or Time', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'mode', ['wipe']);
    await f.action(id, 'schedule');
    const wipeModal = f.modal;
    assert.deepEqual(wipeModal.components.map(row => row.label),
      ['Connected Rust server name', 'Before wipe', 'Duration']);
    assert.match(wipeModal.components[1].description, /starts before the wipe/);
    assert.match(wipeModal.components[2].description, /stays open/);

    await f.submit(id, 'schedule', {
      server: 'Cloudy Rust', before: '10m', duration: '20m',
    });
    assert.equal(f.view.embeds[0].toJSON().color, 0xE53935,
      'invalid wipe schedule preserves the previous form entries');
    await f.action(id, 'schedule');
    assert.equal(f.modal.components[0].component.value, 'Cloudy Rust');
    assert.equal(f.modal.components[1].component.value, '10m');

    await f.action(id, 'mode', ['repeat']);
    await f.action(id, 'schedule');
    const datedModal = f.modal;
    assert.notEqual(datedModal.custom_id, wipeModal.custom_id,
      'different schedule modes must use different Discord modal IDs');
    assert.deepEqual(datedModal.components.map(row => row.label),
      ['Date', 'Time (EU)', 'Repeat', 'Duration']);
    assert.equal(datedModal.components[0].component.value, undefined,
      'Rust server name must not appear inside Date');
    assert.equal(datedModal.components[1].component.value, undefined,
      'Before wipe must not appear inside Time');
    assert.notEqual(f.view.embeds[0].toJSON().color, 0xE53935,
      'changing schedule mode also clears old validation errors');

    await f.action(id, 'schedule');
    assert.notEqual(f.modal.custom_id, datedModal.custom_id,
      'every Schedule opening uses a fresh modal ID to avoid mobile cached values');

    await f.action(id, 'modal', [], {
      customId: wipeModal.custom_id,
      isModalSubmit: () => true,
      fields: { getTextInputValue: key => ({ server: 'Cloudy Rust', before: '10m', duration: '1m' })[key] || '' },
    });
    assert.match(f.view.embeds[0].toJSON().description, /outdated/i,
      'outdated forms cannot overwrite the selected schedule');
    assert.match(f.view.embeds[0].toJSON().description, /Schedule.*Repeat|Schedule.*1d/i);
  }
});

test('both schedule modes display short explanations of when they start and how long they last', async () => {
  for (const kind of ['vote', 'giveaway']) {
    const f = fixture();
    const id = await f.open(kind);
    await f.action(id, 'schedule');
    assert.match(f.modal.components[2].description, new RegExp(`new ${kind} starts`));
    assert.match(f.modal.components[3].description, new RegExp(`${kind} stays open`));
    await f.action(id, 'mode', ['wipe']);
    await f.action(id, 'schedule');
    assert.match(f.modal.components[1].description, new RegExp(`${kind} starts before the wipe`));
    assert.match(f.modal.components[2].description, new RegExp(`${kind} stays open`));
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
  assert.match(f.view.embeds[0].toJSON().description, /Media:\\*\\* 0 saved/);
});
