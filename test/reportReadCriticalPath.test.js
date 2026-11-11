import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField } from 'discord.js';
import { handleReportCaseControl, restoreReportCaseTimers, REPORT_LOG_CHANNEL_ID } from '../src/services/reportCaseLifecycleService.js';
import { logger } from '../src/utils/logger.js';

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

test('Close acknowledges silently and logs once when clicked concurrently', async () => {
  const f = fixture();
  const close = () => handleReportCaseControl(f.interaction(), f.client, ['close', 'report', 'target']);
  await Promise.all([close(), close()]);
  assert.deepEqual(f.removed, ['case']);
  assert.deepEqual(f.privateReplies, []);
  assert.equal(f.payloads.length, 1);
  // The six report staff logs have fixed titles since 41f80c1; the report
  // number is in the log's Report field, not in the title.
  assert.equal(json(f.payloads[0].message.embeds[0]).title, 'Moderation update closed');
  assert.deepEqual(json(f.payloads[0].message.embeds[0]).fields.find(field => field.name === 'Report'),
    { name: 'Report', value: '#1', inline: true });
  assert.ok(f.values.get(f.key).cases.target.closeLogId);
});

test('legacy Read closes the channel and a failed close log resumes after restart', async t => {
  const f = fixture();
  t.mock.method(logger, 'error', () => {});
  const logs = f.channels.get(REPORT_LOG_CHANNEL_ID);
  const send = logs.send;
  logs.send = async () => { throw new Error('Log unavailable'); };
  await handleReportCaseControl(f.interaction(), f.client, ['read', 'report', 'target']);
  assert.deepEqual(f.removed, ['case']);
  assert.ok(f.values.get(f.key).cases.target.deletedAt);
  assert.equal(f.values.get(f.key).cases.target.closeLogId, undefined);
  logs.send = send;
  f.storage.list = async () => [f.key];
  f.client.guilds = { cache: new Collection([[f.guild.id, f.guild]]) };
  await restoreReportCaseTimers(f.client);
  assert.deepEqual(f.removed, ['case']);
  assert.ok(f.values.get(f.key).cases.target.closeLogId);
  assert.equal(json(f.payloads[0].message.embeds[0]).title, 'Moderation update closed');
});

test('failed channel deletion leaves the case open', async t => {
  const f = fixture();
  t.mock.method(logger, 'error', () => {});
  f.caseChannel.delete = async () => { throw new Error('Missing permissions'); };
  await handleReportCaseControl(f.interaction(), f.client, ['close', 'report', 'target']);
  assert.equal(f.values.get(f.key).cases.target.deletedAt, undefined);
  assert.equal(f.payloads.length, 0);
  assert.match(f.privateReplies[0].content, /Missing permissions/);
});

test('restore cleans legacy report-log controls once and skips them on later starts', async () => {
  const f = deleteFixture();
  const logs = f.channels.get(REPORT_LOG_CHANNEL_ID);
  let edits = 0;
  const created = { id: 'created-log', author: f.client.user, content: '<#case>', components: [{ type: 1 }],
    edit: async update => { edits += 1; Object.assign(created, update); return created; } };
  logs.messages.cache.set(created.id, created);
  f.record.cases.target.createdLogId = created.id;
  f.record.closedAt = 1;
  f.storage.list = async () => [f.key];
  f.client.guilds = { cache: new Collection([[f.guild.id, f.guild]]) };

  await restoreReportCaseTimers(f.client);
  assert.equal(edits, 1);
  assert.deepEqual(created.components, []);
  assert.equal(f.values.get(f.key).cases.target.logControlsCleaned, true);

  await restoreReportCaseTimers(f.client);
  assert.equal(edits, 1, 'a second start must not edit the same old log again');
});

test('restore stops quietly once the client was destroyed during a deploy', async t => {
  const f = deleteFixture();
  const warnings = [];
  t.mock.method(logger, 'warn', message => { warnings.push(message); });
  let listed = false;
  f.storage.list = async () => { listed = true; return [f.key]; };
  f.client.guilds = { cache: new Collection([[f.guild.id, f.guild]]) };
  f.client.token = null;
  f.storage.get = async () => assert.fail('no case may be read after the client was destroyed');
  await restoreReportCaseTimers(f.client);
  assert.equal(listed, true);
  assert.deepEqual(warnings, []);
});
