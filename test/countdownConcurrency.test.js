import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  cleanupCountdown,
  countdownButtonHandler,
  createControlButtons,
  startCountdown,
} from '../src/handlers/countdownButtons.js';
import { activeCountdowns } from '../src/commands/Tools/countdown.js';

const settle = () => new Promise(resolve => { setImmediate(resolve); });
const embedData = embed => embed?.toJSON ? embed.toJSON() : embed;
const buttonLabels = payload => payload.components.flatMap(row => row.toJSON().components.map(button => button.label));

function fixture(t, durationMs = 3000) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100_000 });
  const countdownId = `countdown-${t.name.slice(0, 60)}`;
  const startedEdits = [];
  const finishedEdits = [];
  let nextGate = null;
  const message = {
    embeds: [{ title: 'Timer', description: 'Initial timer' }],
    components: [createControlButtons(countdownId)],
    edit: async payload => {
      startedEdits.push(payload);
      const gate = nextGate;
      nextGate = null;
      if (gate) await gate;
      message.embeds = payload.embeds.map(embedData);
      message.components = payload.components;
      finishedEdits.push(payload);
      return message;
    },
  };
  const data = {
    message,
    endTime: Date.now() + durationMs,
    remainingTime: durationMs,
    isPaused: false,
    title: 'Timer',
    lastUpdate: Date.now(),
    interval: null,
  };
  activeCountdowns.set(countdownId, data);
  t.after(() => cleanupCountdown(countdownId, activeCountdowns));
  const gateNextEdit = () => {
    let release;
    nextGate = new Promise(resolve => { release = resolve; });
    return release;
  };
  const interaction = (authorized = true) => {
    const replies = [];
    const acknowledgements = [];
    return {
      replies,
      acknowledgements,
      member: { permissions: { has: permission => authorized && permission === PermissionFlagsBits.ManageMessages } },
      reply: async payload => { replies.push(payload); },
      deferReply: async payload => { acknowledgements.push(payload); },
      editReply: async payload => { replies.push(payload); },
    };
  };
  startCountdown(countdownId, data, activeCountdowns);
  return { countdownId, data, message, startedEdits, finishedEdits, gateNextEdit, interaction };
}

test('slow countdown edits cannot queue more ticks, and the next tick finishes once', async t => {
  const f = fixture(t);
  const release = f.gateNextEdit();
  t.mock.timers.tick(900);
  await settle();
  assert.equal(f.startedEdits.length, 0);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(f.startedEdits.length, 1);
  assert.match(embedData(f.startedEdits[0].embeds[0]).description, /00:02/);

  t.mock.timers.tick(2000);
  await settle();
  assert.equal(f.startedEdits.length, 1);
  release();
  await settle();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(f.startedEdits.length, 2);
  assert.match(f.message.embeds[0].title, /\(Finished!\)/);
  assert.deepEqual(f.message.components, []);
  assert.equal(activeCountdowns.has(f.countdownId), false);
});

test('a delayed final edit is sent once and removes the countdown only after completion', async t => {
  const f = fixture(t, 1000);
  const release = f.gateNextEdit();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(f.startedEdits.length, 1);
  assert.match(embedData(f.startedEdits[0].embeds[0]).title, /\(Finished!\)/);
  assert.deepEqual(f.startedEdits[0].components, []);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(f.startedEdits.length, 1);
  assert.equal(activeCountdowns.has(f.countdownId), true);
  release();
  await settle();
  assert.equal(activeCountdowns.has(f.countdownId), false);
  assert.equal(f.finishedEdits.length, 1);
});

test('pause waits for the active edit and retains Resume controls after its old deadline', async t => {
  const f = fixture(t);
  const release = f.gateNextEdit();
  t.mock.timers.tick(1000);
  await settle();
  const interaction = f.interaction();
  const control = countdownButtonHandler(interaction, {}, ['pause', f.countdownId]);
  await settle();
  assert.equal(f.data.isPaused, true);
  assert.deepEqual(interaction.acknowledgements, [{ flags: ['Ephemeral'] }]);
  assert.equal(interaction.replies.length, 0);
  assert.equal(f.data.remainingTime, 2000);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(f.startedEdits.length, 1);
  release();
  await control;
  assert.deepEqual(buttonLabels(f.finishedEdits.at(-1)), ['▶️ Resume', '❌ Cancel']);
  assert.equal(activeCountdowns.has(f.countdownId), true);
  assert.equal(interaction.replies[0].content, '⏸️ Countdown paused!');
  assert.equal(f.finishedEdits.some(payload => /\(Finished!\)/.test(embedData(payload.embeds[0]).title)), false);

  const resume = f.interaction();
  await countdownButtonHandler(resume, {}, ['pause', f.countdownId]);
  assert.equal(f.data.endTime, Date.now() + 2000);
  assert.deepEqual(buttonLabels(f.finishedEdits.at(-1)), ['⏸️ Pause', '❌ Cancel']);
  assert.equal(resume.replies[0].content, '▶️ Countdown resumed!');
  t.mock.timers.tick(1000);
  await settle();
  assert.match(f.message.embeds[0].description, /00:01/);
  t.mock.timers.tick(1000);
  await settle();
  assert.match(f.message.embeds[0].title, /\(Finished!\)/);
});

test('cancel waits for a delayed tick then keeps the cancelled embed without buttons', async t => {
  const f = fixture(t);
  const release = f.gateNextEdit();
  t.mock.timers.tick(1000);
  await settle();
  const interaction = f.interaction();
  const control = countdownButtonHandler(interaction, {}, ['cancel', f.countdownId]);
  await settle();
  assert.deepEqual(interaction.acknowledgements, [{ flags: ['Ephemeral'] }]);
  assert.equal(interaction.replies.length, 0);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(f.startedEdits.length, 1);
  release();
  await control;
  assert.match(f.message.embeds[0].title, /\(Cancelled\)/);
  assert.deepEqual(f.message.components, []);
  assert.equal(activeCountdowns.has(f.countdownId), false);
  assert.equal(interaction.replies[0].content, '❌ Countdown cancelled!');
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(f.startedEdits.length, 2);
});

test('cancel during a pending final edit cannot replace a completed countdown', async t => {
  const f = fixture(t, 1000);
  const release = f.gateNextEdit();
  t.mock.timers.tick(1000);
  await settle();
  const interaction = f.interaction();
  const control = countdownButtonHandler(interaction, {}, ['cancel', f.countdownId]);
  await settle();
  release();
  await control;
  assert.match(f.message.embeds[0].title, /\(Finished!\)/);
  assert.deepEqual(f.message.components, []);
  assert.equal(activeCountdowns.has(f.countdownId), false);
  assert.equal(f.finishedEdits.length, 1);
  assert.equal(interaction.replies[0].content, 'This countdown has expired or was cancelled.');
});

test('pause during a pending final edit cannot restore controls or retain finished state', async t => {
  const f = fixture(t, 1000);
  const release = f.gateNextEdit();
  t.mock.timers.tick(1000);
  await settle();
  const interaction = f.interaction();
  const control = countdownButtonHandler(interaction, {}, ['pause', f.countdownId]);
  await settle();
  assert.deepEqual(interaction.acknowledgements, [{ flags: ['Ephemeral'] }]);
  assert.equal(f.data.isPaused, false);
  release();
  await control;
  assert.match(f.message.embeds[0].title, /\(Finished!\)/);
  assert.deepEqual(f.message.components, []);
  assert.equal(activeCountdowns.has(f.countdownId), false);
  assert.equal(f.finishedEdits.length, 1);
  assert.equal(interaction.replies[0].content, 'This countdown has expired or was cancelled.');
});

test('rapid pause and resume serialize their control edits after the active tick', async t => {
  const f = fixture(t, 10_000);
  const release = f.gateNextEdit();
  t.mock.timers.tick(1000);
  await settle();
  const pause = f.interaction();
  const paused = countdownButtonHandler(pause, {}, ['pause', f.countdownId]);
  await settle();
  const resume = f.interaction();
  const resumed = countdownButtonHandler(resume, {}, ['pause', f.countdownId]);
  await settle();
  release();
  await Promise.all([paused, resumed]);
  assert.equal(f.finishedEdits.length, 3);
  assert.deepEqual(buttonLabels(f.finishedEdits[1]), ['▶️ Resume', '❌ Cancel']);
  assert.deepEqual(buttonLabels(f.finishedEdits[2]), ['⏸️ Pause', '❌ Cancel']);
  assert.equal(f.data.isPaused, false);
  assert.equal(f.data.endTime, Date.now() + 9000);
});

test('countdown controls retain their Manage Messages authorization', async t => {
  const f = fixture(t);
  const interaction = f.interaction(false);
  await countdownButtonHandler(interaction, {}, ['cancel', f.countdownId]);
  assert.equal(interaction.replies[0].content, 'You need the "Manage Messages" permission to control countdowns.');
  assert.equal(f.startedEdits.length, 0);
  assert.equal(activeCountdowns.has(f.countdownId), true);
  assert.equal(f.data.isPaused, false);
  assert.deepEqual(interaction.acknowledgements, []);
});
