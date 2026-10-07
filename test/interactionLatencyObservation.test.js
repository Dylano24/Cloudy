import test from 'node:test';
import assert from 'node:assert/strict';
import { observeInteractionLatency } from '../src/utils/interactionLatency.js';
import { logger } from '../src/utils/logger.js';

test('slow component console logs include timings and action without report IDs', async t => {
  const messages = [];
  t.mock.method(logger, 'warn', message => { messages.push(message); });
  let now = 0;
  const interaction = { customId: 'report_case:read:123456789012345678:target', reply: async () => true };
  observeInteractionLatency(interaction, { now: () => now });
  now = 1500;
  await interaction.reply({});
  assert.ok(messages.some(message => message.includes('"elapsedMs":1500') && message.includes('"action":"read"')));
  assert.ok(messages.every(message => !message.includes('123456789012345678')));
});

test('latency observation preserves arguments, receiver and results and separates defer from visible content', async () => {
  let now = 0;
  const reports = [];
  const result = { resource: { message: { id: 'original' } } };
  const payload = { embeds: [{ title: 'Do not change me' }] };
  const interaction = {
    commandName: 'report',
    deferReply: async function (options) { assert.equal(this, interaction); assert.equal(options, payload); },
    editReply: async function (options) { assert.equal(this, interaction); assert.equal(options, payload); return result; },
  };
  observeInteractionLatency(interaction, { now: () => now, report: data => reports.push(data) });
  observeInteractionLatency(interaction, { now: () => now, report: () => assert.fail('wrapped twice') });
  now = 20;
  await interaction.deferReply(payload);
  now = 1200;
  assert.equal(await interaction.editReply(payload), result);
  assert.deepEqual(reports, [{ event: 'interaction.latency', command: 'report', phase: 'visible', elapsedMs: 1200, thinkingMs: 1180 }]);
  now = 4000;
  await interaction.editReply(payload);
  assert.equal(reports.length, 1, 'later edits are not initial-response latency');
});

test('silent component acknowledgement never reports visible thinking time', async () => {
  let now = 0;
  const reports = [];
  const interaction = {
    customId: 'report_case:read:case:target',
    deferUpdate: async () => {},
    followUp: async payload => payload,
  };
  observeInteractionLatency(interaction, { now: () => now, report: data => reports.push(data) });
  now = 100;
  await interaction.deferUpdate();
  now = 1500;
  await interaction.followUp({ flags: 64 });
  assert.deepEqual(reports, [{
    event: 'interaction.latency',
    command: 'report_case',
    action: 'read',
    phase: 'visible',
    elapsedMs: 1500,
  }]);
});

test('fast replies stay quiet and rejected responses retain the exact error', async () => {
  const failure = new Error('Discord unavailable');
  let now = 0;
  const interaction = { reply: async () => { throw failure; } };
  observeInteractionLatency(interaction, { now: () => now, report: () => assert.fail('failure is not a successful paint') });
  now = 100;
  await assert.rejects(interaction.reply({}), error => error === failure);
});

test('global 0.5–1s target flags 750ms reactions except FAQ AI', async () => {
  let now = 0;
  const slow = [];
  const ordinary = {
    customId: 'ticket_claim',
    deferUpdate: async () => true,
  };
  observeInteractionLatency(ordinary, { now: () => now, report: data => slow.push(data) });
  now = 810;
  await ordinary.deferUpdate();
  assert.deepEqual(slow.map(x => ({ phase: x.phase, ms: x.elapsedMs })), [{ phase: 'ack', ms: 810 }]);

  const faq = {
    customId: 'faq_ai_question_modal',
    deferReply: async () => true,
    editReply: async () => true,
  };
  const faqReports = [];
  observeInteractionLatency(faq, { now: () => now, report: data => faqReports.push(data) });
  now = 12000;
  await faq.deferReply({});
  await faq.editReply({});
  assert.deepEqual(faqReports, [], 'FAQ assistant is excluded from the one-second target');
});

test('slow modal acknowledgement is measured without changing the modal flow', async () => {
  let now = 0;
  const reports = [];
  const interaction = { showModal: async payload => payload };
  observeInteractionLatency(interaction, { now: () => now, report: data => reports.push(data) });
  now = 1500;
  const modal = { title: 'Original modal' };
  assert.equal(await interaction.showModal(modal), modal);
  assert.deepEqual(reports.map(({ phase, elapsedMs }) => ({ phase, elapsedMs })), [
    { phase: 'ack', elapsedMs: 1500 }, { phase: 'visible', elapsedMs: 1500 },
  ]);
});
