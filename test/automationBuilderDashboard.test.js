import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags, PermissionFlagsBits } from 'discord.js';
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
    ['Back']);
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
  assert.deepEqual(f.modal.components.map(row => row.components[0].custom_id),
    ['name', 'question', 'option1', 'option2', 'option3']);
  await f.submit(id, 'details', {
    question: 'Best map?', option1: 'First', option2: 'Second', option3: 'Third',
  });
  assert.match(f.view.embeds[0].toJSON().description, /Best map/);

  await f.action(id, 'schedule');
  assert.deepEqual(f.modal.components.map(row => row.components[0].custom_id),
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
  assert.deepEqual(f.modal.components.map(row => row.components[0].custom_id),
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
  assert.deepEqual(f.modal.components.map(row => row.components[0].custom_id),
    ['server', 'before', 'duration']);
  await f.submit(id, 'schedule', { server: 'Cloudy Rust', before: '30', duration: '5' });
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
    assert.deepEqual(f.modal.components.map(row => row.components[0].custom_id),
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
    assert.deepEqual(f.modal.components.map(row => row.components[0].label),
      ['Date', 'Time (EU)', 'Repeat', 'Duration']);
    assert.deepEqual(f.modal.components.map(row => row.components[0].placeholder),
      ['10-11-2026', '18:00', '1d', '1m']);
    await f.action(id, 'mode', ['once']);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => row.components[0].label),
      ['Date', 'Time (EU)', 'Duration']);
    await f.action(id, 'mode', ['wipe']);
    await f.action(id, 'schedule');
    assert.deepEqual(f.modal.components.map(row => row.components[0].label),
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
