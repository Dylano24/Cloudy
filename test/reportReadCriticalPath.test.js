import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField } from 'discord.js';
import { handleReportCaseControl, restoreReportCaseTimers, REPORT_LOG_CHANNEL_ID } from '../src/services/reportCaseLifecycleService.js';
import { logger } from '../src/utils/logger.js';

const settle = () => new Promise(resolve => { setImmediate(resolve); });
const json = embed => embed.toJSON?.() || embed;
let fixtureNumber = 0;

function fixture() {
  const guildId = `report-critical-path-${++fixtureNumber}`;
  const key = `global:report:${guildId}:report`;
  const configKey = `guild:${guildId}:config`;
  const participant = { id: 'target', user: { id: 'target' }, roles: { cache: new Collection() }, permissions: new PermissionsBitField() };
  const record = { guildId, messageId: 'report', number: 1, reporterId: 'reporter', targetId: 'target',
    cases: { target: { channelId: 'case', messageId: 'notice' } } };
  const values = new Map([[key, record], [configKey, { ticketStaffRoleId: 'staff-role' }]]);
  const payloads = [], permissions = [], privateReplies = [], removed = [];
  const storage = { get: async id => structuredClone(values.get(id) || null),
    set: async (id, value) => { values.set(id, structuredClone(value)); return true; } };
  const client = { db: storage, user: { id: 'bot' } };
  const channels = new Collection();
  const guild = { id: guildId, ownerId: 'owner', client, roles: { everyone: { id: 'everyone' },
    cache: new Collection([['staff-role', { id: 'staff-role', name: 'Staff' }]]) },
  members: { cache: new Collection([[participant.id, participant]]), fetch: async id => {
    assert.equal(id, participant.id); return participant;
  } }, channels: { fetch: async id => channels.get(id) } };
  function channel(id) {
    const messages = new Collection();
    const result = { id, guild, messages: { cache: messages, fetch: async messageId => messages.get(messageId) },
      delete: async () => { removed.push(id); },
      permissionOverwrites: { cache: new Collection(), edit: async (member, denied) => {
        permissions.push({ id: member.id, permissions: denied });
      } },
      send: async payload => {
        const message = { id: `message-${payloads.length}`, author: client.user, ...payload,
          edit: async update => { Object.assign(message, update); return message; } };
        payloads.push({ channelId: id, message }); messages.set(message.id, message); return message;
      } };
    channels.set(id, result); return result;
  }
  const caseChannel = channel('case');
  channel(REPORT_LOG_CHANNEL_ID);
  const notice = { id: 'notice', author: client.user, components: [], edit: async payload => {
    Object.assign(notice, payload); return notice;
  } };
  caseChannel.messages.cache.set(notice.id, notice);
  function interaction() {
    const click = { id: '1556344268099166320', createdTimestamp: Date.now(), guildId, guild, channelId: 'case', channel: caseChannel,
      message: notice, user: participant.user, member: participant, inGuild: () => true,
      deferUpdate: async () => { click.deferred = true; },
      deferReply: async () => assert.fail('Read must use a silent component acknowledgement'),
      editReply: async () => assert.fail('Read must never edit the report as a private reply'),
      deleteReply: async () => assert.fail('Read must never delete the original report'),
      followUp: async payload => { privateReplies.push(payload); click.replied = true; return { id: `private-${privateReplies.length}` }; },
      webhook: { deleteMessage: async () => {} } };
    return click;
  }
  return { key, configKey, record, values, storage, client, guild, interaction, notice, caseChannel, payloads, permissions, privateReplies, channels, channel, removed };
}

function deleteFixture() {
  const f = fixture();
  const staff = { id: 'staff', user: { id: 'staff' }, permissions: new PermissionsBitField(), roles: { cache: new Collection([['staff-role', {}]]) } };
  f.guild.members.cache.set(staff.id, staff);
  Object.assign(f.record.cases.target, { closedAt: 1, closedBy: 'target', deletePromptId: 'delete-prompt', closeLogId: 'closed-log' });
  const reporterChannel = f.channel('reporter-case');
  f.record.cases.reporter = { channelId: reporterChannel.id, messageId: 'reporter-notice' };
  f.channel(REPORT_LOG_CHANNEL_ID);
  const deleteClick = () => {
    const click = f.interaction();
    click.user = staff.user; click.member = staff;
    click.message = { id: 'delete-prompt', author: f.client.user };
    return click;
  };
  const reporter = { id: 'reporter', user: { id: 'reporter' }, roles: { cache: new Collection() }, permissions: new PermissionsBitField() };
  f.guild.members.cache.set(reporter.id, reporter);
  const readClick = f.interaction();
  Object.assign(readClick, { user: reporter.user, member: reporter, channel: reporterChannel, channelId: reporterChannel.id,
    message: { id: 'reporter-notice', author: f.client.user, edit: async () => {} } });
  return { ...f, deleteClick, readClick };
}

test('blocked Delete logging releases the report lock before the other audience reads', async () => {
  const f = deleteFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const logs = f.channels.get(REPORT_LOG_CHANNEL_ID), send = logs.send;
  logs.send = async payload => { if (json(payload.embeds[0]).title === 'Report deleted') await gate; return send(payload); };
  const deleting = handleReportCaseControl(f.deleteClick(), f.client, ['delete', 'report', 'target']);
  await settle();
  const reading = handleReportCaseControl(f.readClick, f.client, ['read', 'report', 'reporter']);
  try {
    await settle();
    assert.ok(f.values.get(f.key).cases.target.deletedAt);
    assert.ok(f.values.get(f.key).cases.reporter.closedAt, 'Delete staff-log IO must not hold an independent Read behind the report lock');
    assert.equal(json(f.privateReplies[0]?.embeds?.[0] || {}).title, 'Thank you.');
  } finally {
    release(); await Promise.all([deleting, reading]); await settle();
  }
  assert.ok(f.values.get(f.key).cases.target.deleteLogId);
  assert.ok(f.values.get(f.key).cases.reporter.closeLogId);
});

test('duplicate Delete clicks finish after one durable channel deletion while its one log is pending', async () => {
  const f = deleteFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const logs = f.channels.get(REPORT_LOG_CHANNEL_ID), send = logs.send;
  logs.send = async payload => { if (json(payload.embeds[0]).title === 'Report deleted') await gate; return send(payload); };
  let completed = 0;
  const deletions = Array.from({ length: 5 }, () => handleReportCaseControl(f.deleteClick(), f.client, ['delete', 'report', 'target']).then(() => { completed += 1; }));
  try {
    await settle();
    assert.equal(completed, 5, 'Component handlers must finish without waiting for staff-log REST');
    assert.deepEqual(f.removed, ['case']);
    assert.equal(f.privateReplies.length, 0, 'Already-completed authorized deletion should not create error spam');
  } finally {
    release(); await Promise.all(deletions); await settle();
  }
  assert.equal(f.payloads.filter(payload => json(payload.message.embeds[0]).title === 'Report deleted').length, 1);
  assert.ok(f.values.get(f.key).cases.target.deleteLogId);
});

test('a failed Delete log resumes from its durable deleted state on restore without deleting the channel again', async t => {
  const f = deleteFixture();
  const logs = f.channels.get(REPORT_LOG_CHANNEL_ID), send = logs.send;
  const errors = [];
  t.mock.method(logger, 'error', (message, error) => { if (message.includes('[REPORT_DELETE_PRESENTATION]')) errors.push(error); });
  logs.send = async () => { throw new Error('Report log temporarily unavailable'); };
  await handleReportCaseControl(f.deleteClick(), f.client, ['delete', 'report', 'target']);
  await settle();
  assert.ok(f.values.get(f.key).cases.target.deletedAt);
  assert.equal(f.values.get(f.key).cases.target.deleteLogId, undefined);
  assert.equal(errors.length, 1);
  logs.send = send;
  f.storage.list = async () => [f.key];
  f.client.guilds = { cache: new Collection([[f.guild.id, f.guild]]) };
  f.values.get(f.key).expiresAt = Date.now() + 86_400_000;
  await restoreReportCaseTimers(f.client);
  assert.ok(f.values.get(f.key).cases.target.deleteLogId, 'Restore must deliver the essential deletion log');
  assert.deepEqual(f.removed, ['case']);
  assert.equal(f.payloads.filter(payload => json(payload.message.embeds[0]).title === 'Report deleted').length, 1);
});

test('repeated completed Read does not refetch or repaint its successful private presentation', async () => {
  const f = fixture();
  await handleReportCaseControl(f.interaction(), f.client, ['read', 'report', 'target']);
  await settle();
  const sent = f.payloads.length;
  let edits = 0, fetches = 0;
  f.notice.edit = async () => { edits += 1; };
  f.caseChannel.messages.fetch = async () => { fetches += 1; };
  await handleReportCaseControl(f.interaction(), f.client, ['read', 'report', 'target']);
  await settle();
  assert.equal(f.payloads.length, sent);
  assert.equal(f.permissions.length, 1);
  assert.equal(edits, 0, 'A completed Read must not repaint the notice');
  assert.equal(fetches, 0, 'A completed Read must not fetch its existing Delete prompt');
});

test('Read starts independent cold case and configuration reads together before its durable close', async () => {
  const f = fixture();
  const gates = new Map();
  const get = f.storage.get;
  f.storage.get = id => [f.key, f.configKey].includes(id) && !gates.has(id)
    ? new Promise(resolve => { gates.set(id, resolve); }) : get(id);
  const click = f.interaction();
  const pending = handleReportCaseControl(click, f.client, ['read', 'report', 'target']);
  try {
    await settle();
    assert.equal(click.deferred, true, 'Storage must not delay the component acknowledgement');
    assert.ok(gates.has(f.key));
    assert.ok(gates.has(f.configKey), 'A cold configuration read must not wait for the unrelated case lookup');
    assert.equal(f.permissions.length, 0);
    assert.equal(f.privateReplies.length, 0);
  } finally {
    gates.get(f.key)?.(structuredClone(f.record));
    await settle();
    gates.get(f.configKey)?.({ ticketStaffRoleId: 'staff-role' });
    await pending;
  }
  assert.ok(f.values.get(f.key).cases.target.closedAt);
  assert.equal(json(f.privateReplies[0].embeds[0]).title, 'Thank you.');
});

test('a slow durable Read write acknowledges each concurrent click without sending premature success', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const set = f.storage.set;
  let blocked = false;
  f.storage.set = async (id, value) => {
    if (id === f.key && value.cases.target.closedAt && !blocked) {
      blocked = true; await gate;
    }
    return set(id, value);
  };
  const first = f.interaction(), second = f.interaction();
  const firstRead = handleReportCaseControl(first, f.client, ['read', 'report', 'target']);
  await settle();
  const secondRead = handleReportCaseControl(second, f.client, ['read', 'report', 'target']);
  try {
    await settle();
    assert.equal(first.deferred, true);
    assert.equal(second.deferred, true);
    assert.equal(f.privateReplies.length, 0, 'Success requires a durable close');
    assert.equal(f.values.get(f.key).cases.target.closedAt, undefined);
  } finally {
    release();
    await Promise.all([firstRead, secondRead]);
  }
  await settle();
  assert.equal(f.permissions.length, 1, 'Repeated Read must not repeat access revocation');
  assert.equal(f.privateReplies.filter(payload => json(payload.embeds?.[0] || {}).title === 'Thank you.').length, 2);
  assert.equal(f.payloads.filter(payload => payload.channelId === REPORT_LOG_CHANNEL_ID).length, 1);
  assert.ok(f.values.get(f.key).cases.target.closeLogId);
  assert.ok(f.values.get(f.key).cases.target.deletePromptId);
});

test('a failed Read write never confirms success or creates a completed close log', async () => {
  const f = fixture();
  f.storage.set = async () => false;
  await handleReportCaseControl(f.interaction(), f.client, ['read', 'report', 'target']);
  assert.equal(f.values.get(f.key).cases.target.closedAt, undefined);
  assert.equal(f.privateReplies.length, 1);
  assert.match(f.privateReplies[0].content, /report could not be saved/);
  assert.equal(f.payloads.length, 0);
});

test('Read waits for participant access revocation before its durable close and private success', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const edit = f.caseChannel.permissionOverwrites.edit;
  f.caseChannel.permissionOverwrites.edit = async (...args) => { await gate; return edit(...args); };
  const click = f.interaction();
  const pending = handleReportCaseControl(click, f.client, ['read', 'report', 'target']);
  try {
    await settle();
    assert.equal(click.deferred, true);
    assert.equal(f.privateReplies.length, 0);
    assert.equal(f.values.get(f.key).cases.target.closedAt, undefined);
    assert.equal(f.payloads.length, 0);
  } finally {
    release(); await pending;
  }
  assert.deepEqual(f.permissions, [{ id: 'target', permissions: { ViewChannel: false, SendMessages: false, ReadMessageHistory: false } }]);
  assert.ok(f.values.get(f.key).cases.target.closedAt);
  assert.equal(json(f.privateReplies[0].embeds[0]).title, 'Thank you.');
});

test('a failed participant access revocation leaves Read open without confirming success', async () => {
  const f = fixture();
  f.caseChannel.permissionOverwrites.edit = async () => { throw new Error('Discord permission write failed'); };
  await handleReportCaseControl(f.interaction(), f.client, ['read', 'report', 'target']);
  assert.equal(f.values.get(f.key).cases.target.closedAt, undefined);
  assert.equal(f.privateReplies.length, 1);
  assert.match(f.privateReplies[0].content, /Discord permission write failed/);
  assert.equal(f.payloads.length, 0);
});

test('parallel Read prerequisites never authorize a member outside the report or staff', async () => {
  const f = fixture();
  const outsider = { id: 'outsider', user: { id: 'outsider' }, roles: { cache: new Collection() }, permissions: new PermissionsBitField() };
  f.guild.members.cache.set(outsider.id, outsider);
  const click = f.interaction();
  click.user = outsider.user; click.member = outsider;
  await handleReportCaseControl(click, f.client, ['read', 'report', 'target']);
  assert.equal(f.values.get(f.key).cases.target.closedAt, undefined);
  assert.equal(f.privateReplies.length, 1);
  assert.match(f.privateReplies[0].content, /Only the involved member or staff/);
  assert.equal(f.permissions.length, 0);
  assert.equal(f.payloads.length, 0);
});

test('a blocked private confirmation cannot prevent the persisted Read from finishing its staff presentation', async () => {
  const f = fixture();
  const click = f.interaction();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const followUp = click.followUp;
  click.followUp = async payload => { await gate; return followUp(payload); };
  const pending = handleReportCaseControl(click, f.client, ['read', 'report', 'target']);
  try {
    await settle();
    assert.ok(f.values.get(f.key).cases.target.closedAt);
    assert.ok(f.values.get(f.key).cases.target.closeLogId, 'The private reply must not block the essential staff close log');
    assert.ok(f.values.get(f.key).cases.target.deletePromptId, 'Staff must retain the private Delete prompt');
    assert.equal(f.notice.components[0].toJSON().components[0].disabled, true);
  } finally {
    release(); await pending;
  }
});

test('legacy Read logs a staff presentation failure even while its private confirmation is blocked', async t => {
  const f = fixture();
  const click = f.interaction();
  delete click.deferUpdate;
  delete click.followUp;
  click.deferReply = async () => { click.deferred = true; };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  click.editReply = async payload => { await gate; f.privateReplies.push(payload); };
  const failure = new Error('Staff close log unavailable');
  f.guild.channels.fetch = async id => {
    if (id === REPORT_LOG_CHANNEL_ID) throw failure;
    return f.caseChannel;
  };
  const loggedFailures = [];
  t.mock.method(logger, 'error', (message, error) => {
    if (message.includes('[REPORT_READ_PRESENTATION]')) loggedFailures.push(error);
  });
  const pending = handleReportCaseControl(click, f.client, ['read', 'report', 'target']);
  try {
    await settle();
    assert.ok(f.values.get(f.key).cases.target.closedAt);
    assert.equal(f.privateReplies.length, 0);
    assert.deepEqual(loggedFailures, [failure], 'A blocked legacy reply must not hide the essential staff presentation failure');
  } finally {
    release(); await pending;
  }
});
