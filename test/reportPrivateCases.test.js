import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, OverwriteType, PermissionOverwrites, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { buildReportActions, handleReportAction, handleReportModeration } from '../src/services/reportActionService.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { registerReport, reportKey, REPORT_CATEGORY_ID, REPORT_CASE_MS, REPORT_LOG_CHANNEL_ID, REPORT_COUNTDOWN_REFRESH_MS, restoreReportCaseTimers, handleReportCaseControl, publishReportOutcome, deleteReportCase } from '../src/services/reportCaseService.js';
import { TICKET_EVENT_STYLES } from '../src/utils/ticket/ticketLogging.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';

const settle = async () => { await new Promise(resolve => { setImmediate(resolve); }); };
const json = embed => embed.toJSON?.() || embed;

let fixtureNumber = 0;
function fixture() {
  const values = new Map(), payloads = [], removed = [], dms = [], positions = [];
  const storage = { get: async key => structuredClone(values.get(key) || null), set: async (key, value) => { values.set(key, structuredClone(value)); return true; }, list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const member = id => ({ id, user: { id, tag: id, send: async payload => { dms.push({ id, payload }); } }, permissions: new PermissionsBitField(), roles: { cache: new Collection() } });
  const staff = member('staff'), reporter = member('reporter'), target = member('target'), owner = member('owner');
  staff.roles.cache.set('staff-role', { name: 'Staff' });
  const members = new Collection([staff, reporter, target, owner].map(entry => [entry.id, entry]));
  const client = { db: storage, user: { id: 'bot' }, users: { fetch: async id => members.get(id).user } };
  const channels = new Collection();
  const guild = { id: `private-report-guild-${++fixtureNumber}`, name: 'Cloudy', ownerId: 'owner', client,
    roles: { everyone: { id: 'everyone' }, cache: new Collection([['staff-role', { id: 'staff-role', name: 'Staff' }]]) },
    members: { fetch: async id => members.get(id) }, channels: { cache: channels, fetch: async id => channels.get(id),
      setPositions: async data => { positions.push(data); },
      create: async data => { const ch = channel(`case-${channels.size}`, data.name); ch.creation = data; ch.rawPosition = data.position ?? channels.size; channels.set(ch.id, ch); return ch; } } };
  client.guilds = { cache: new Collection([[guild.id, guild]]) };
  values.set(`guild:${guild.id}:config`, { ticketStaffRoleId: 'staff-role' });
  function channel(id, name = id) {
    const messages = new Collection();
    const ch = { id, name, guild, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => false }),
      overwriteEdits: [], messages: { cache: messages, fetch: async id => messages.get(id) },
      permissionOverwrites: { edit: async (id, permissions) => { ch.overwriteEdits.push({ id, permissions }); }, set: async overwrites => { ch.resetOverwrites = overwrites; } },
      delete: async () => { removed.push(id); channels.delete(id); },
      send: async payload => {
        const msg = { id: `sent-${payloads.length}`, author: client.user, channelId: id, channel: ch, ...payload, sentPayload: payload,
          edit: async update => Object.assign(msg, update), delete: async () => { removed.push(msg.id); messages.delete(msg.id); } };
        payloads.push(msg); messages.set(msg.id, msg); return msg;
      } };
    return ch;
  }
  const reports = channel('reports'), logs = channel(REPORT_LOG_CHANNEL_ID), originalChannel = channel('original');
  originalChannel.messages.fetch = async id => ({ id, guild, delete: async () => { removed.push(id); } });
  for (const ch of [reports, logs, originalChannel]) channels.set(ch.id, ch);
  channels.set(REPORT_CATEGORY_ID, { id: REPORT_CATEGORY_ID, type: ChannelType.GuildCategory });
  const report = { id: 'report', author: client.user, channelId: reports.id, channel: reports,
    embeds: [{ title: 'New report', fields: [{ name: 'Reported member', value: '<@target>' }, { name: 'Reported by', value: '<@reporter>' }, { name: 'Reason', value: 'TEST!' }] }],
    components: buildReportActions('target').map(row => ({ components: row.toJSON().components.map(button => ({ customId: button.custom_id, ...button })) })),
    edit: async payload => { Object.assign(report, payload); return report; } };
  reports.messages.cache.set(report.id, report);
  function interaction(user = staff.user, message = report, channelId = reports.id) {
    const result = { id: '1556344268099166320', createdTimestamp: Date.now(), guild, guildId: guild.id, channel: channels.get(channelId), channelId, member: members.get(user.id), user, message,
      inGuild: () => true, deferReply: async () => { result.deferred = true; }, deleteReply: async () => {}, editReply: async payload => { result.error = payload; },
      showModal: async modal => { result.modal = modal.toJSON(); }, fields: { getTextInputValue: field => field === 'minutes' ? '10' : 'Private action reason' } };
    return result;
  }
  async function submit(action = 'delete', user = staff.user) {
    const click = interaction(user);
    await handleReportAction(click, client, [action, target.id]);
    assert.ok(click.modal);
    const form = interaction(user);
    await handleReportModeration(form, client, [action, target.id, report.id]);
    return storage.get(reportKey(guild.id, report.id));
  }
  async function register() { await registerReport(client, report, { guildId: guild.id, reporterId: reporter.id, targetId: target.id, sourceChannelId: originalChannel.id, sourceMessageId: 'original-message' }); }
  return { values, client, guild, staff, reporter, target, owner, reports, logs, channels, report, interaction, payloads, removed, dms, positions, submit, register };
}

test('Delete asks for a required reason before acting; two adjacent private cases keep the New report intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const snapshot = structuredClone({ embeds: f.report.embeds });
  const click = f.interaction();
  await handleReportAction(click, f.client, ['delete', 'target']);
  assert.deepEqual(f.removed, []);
  assert.equal(click.modal.components[0].components[0].required, true);
  assert.equal(click.modal.components[0].components[0].custom_id, 'reason');
  const record = await f.submit();
  assert.deepEqual(f.removed, ['original-message']);
  assert.equal(record.expiresAt - Date.now(), REPORT_CASE_MS);
  const reporter = f.channels.get(record.cases.reporter.channelId), target = f.channels.get(record.cases.target.channelId);
  assert.equal(reporter.name, 'report-1'); assert.equal(target.name, 'report-1');
  assert.equal(reporter.creation.parent, REPORT_CATEGORY_ID); assert.equal(target.creation.parent, REPORT_CATEGORY_ID);
  assert.equal(f.positions[0][1].position, f.positions[0][0].position + 1);
  assert.ok(reporter.creation.permissionOverwrites.some(entry => entry.id === 'reporter' && entry.allow));
  assert.ok(!reporter.creation.permissionOverwrites.some(entry => entry.id === 'target'));
  assert.ok(target.creation.permissionOverwrites.some(entry => entry.id === 'target' && entry.allow));
  assert.ok(target.creation.permissionOverwrites.every(entry => entry.type === (entry.id === 'everyone' || entry.id === 'staff-role' ? OverwriteType.Role : OverwriteType.Member)));
  // Discord must resolve banned/uncached users without looking up cached structures.
  for (const entry of target.creation.permissionOverwrites) assert.equal(PermissionOverwrites.resolve(entry, {}).id, entry.id);
  assert.ok(!target.creation.permissionOverwrites.some(entry => entry.id === 'reporter'));
  const reporterNotice = reporter.messages.cache.get(record.cases.reporter.messageId), targetNotice = target.messages.cache.get(record.cases.target.messageId);
  assert.equal(reporterNotice.content, '<@reporter> <@&staff-role>');
  assert.deepEqual(reporterNotice.allowedMentions, { parse: [], users: ['reporter'], roles: ['staff-role'] });
  assert.doesNotMatch(JSON.stringify(json(reporterNotice.embeds[0])), /Private action reason|Reason|staff/);
  assert.equal(targetNotice.content, '<@target> <@&staff-role>');
  assert.match(JSON.stringify(json(targetNotice.embeds[0])), /Private action reason/);
  assert.equal(json(targetNotice.embeds[0]).description, undefined);
  assert.equal(json(reporterNotice.embeds[0]).description, 'The reported message has been deleted.');
  assert.deepEqual(targetNotice.components[0].toJSON().components.map(button => button.label), ['Close']);
  assert.equal(f.payloads.filter(message => message.channelId === 'reports').length, 0);
  assert.deepEqual(f.report.embeds, snapshot.embeds);
  assert.deepEqual(f.report.components, []);
  for (const entry of Object.values(record.cases)) {
    assert.deepEqual(f.logs.messages.cache.get(entry.createdLogId).components, []);
  }
  assert.equal(f.dms.length, 0);
});

test('empty reason, invalid duration and unauthorized submissions cannot perform actions or create cases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.register();
  const empty = f.interaction(); empty.fields.getTextInputValue = () => '  ';
  await handleReportModeration(empty, f.client, ['delete', 'target', 'report']);
  assert.deepEqual(f.removed, []); assert.equal(f.payloads.length, 0);
  const outsider = f.interaction(f.target.user);
  await handleReportModeration(outsider, f.client, ['delete', 'target', 'report']);
  assert.deepEqual(f.removed, []); assert.equal(f.payloads.length, 0);
  const timeout = f.interaction(); timeout.fields.getTextInputValue = field => field === 'minutes' ? '0' : 'Reason';
  await assert.rejects(handleReportModeration(timeout, f.client, ['timeout', 'target', 'report']), /Timeout must/);
});

test('target Close hides only their own case, notifies Staff once in ticket orange, and Staff Delete uses ticket red', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  const channel = f.channels.get(record.cases.target.channelId), notice = channel.messages.cache.get(record.cases.target.messageId);
  const forged = f.interaction(f.reporter.user, notice, channel.id);
  await handleReportCaseControl(forged, f.client, ['close', 'report', 'target']);
  assert.equal(channel.overwriteEdits.length, 0);
  const close = f.interaction(f.target.user, notice, channel.id);
  await handleReportCaseControl(close, f.client, ['close', 'report', 'target']);
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.cases.target.closedAt); assert.equal(record.closedAt, undefined);
  assert.deepEqual(channel.overwriteEdits, [{ id: 'target', permissions: { ViewChannel: false, SendMessages: false, ReadMessageHistory: false } }]);
  assert.deepEqual(f.removed, ['original-message']);
  const log = f.logs.messages.cache.get(record.cases.target.closeLogId);
  assert.equal(json(log.embeds[0]).color, TICKET_EVENT_STYLES.close.color);
  assert.equal(json(log.embeds[0]).title, 'Report case closed');
  assert.equal(log.content, '<@&staff-role>');
  assert.deepEqual(log.sentPayload.allowedMentions.roles, ['staff-role']);
  assert.deepEqual(log.components[0].toJSON().components.map(button => [button.label, button.disabled]), [['Delete', false]]);
  const count = f.payloads.length;
  await handleReportCaseControl(close, f.client, ['close', 'report', 'target']);
  assert.equal(f.payloads.length, count);
  await handleReportCaseControl(f.interaction(f.target.user, log, REPORT_LOG_CHANNEL_ID), f.client, ['delete', 'report', 'target']);
  assert.deepEqual(f.removed, ['original-message']);
  await handleReportCaseControl(f.interaction(f.staff.user, log, REPORT_LOG_CHANNEL_ID), f.client, ['delete', 'report', 'target']);
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.cases.target.deletedAt); assert.equal(record.cases.reporter.deletedAt, undefined);
  assert.deepEqual(log.components, []);
  assert.deepEqual(f.logs.messages.cache.get(record.cases.target.createdLogId).components, []);
  assert.ok(f.channels.has(record.cases.reporter.channelId));
  const deleted = f.logs.messages.cache.get(record.cases.target.deleteLogId);
  assert.equal(json(deleted.embeds[0]).color, TICKET_EVENT_STYLES.delete.color);
  assert.match(JSON.stringify(json(deleted.embeds[0])), /Deleted by.*staff/);
});

test('reporter Close removes only reporter access; Staff can also Close and delete that case', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  const entry = record.cases.reporter, channel = f.channels.get(entry.channelId), notice = channel.messages.cache.get(entry.messageId);
  await handleReportCaseControl(f.interaction(f.reporter.user, notice, channel.id), f.client, ['close', 'report', 'reporter']);
  assert.equal(channel.overwriteEdits[0].id, 'reporter');
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.equal(record.cases.target.closedAt, undefined);
  assert.equal(f.logs.messages.cache.get(record.cases.reporter.closeLogId).content, null);
  const target = record.cases.target, targetChannel = f.channels.get(target.channelId);
  await handleReportCaseControl(f.interaction(f.staff.user, targetChannel.messages.cache.get(target.messageId), target.channelId), f.client, ['close', 'report', 'target']);
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.equal(record.cases.target.closedBy, 'staff');
  assert.equal(targetChannel.overwriteEdits[0].id, 'target');
  const log = f.logs.messages.cache.get(record.cases.reporter.closeLogId);
  await handleReportCaseControl(f.interaction(f.staff.user, log, REPORT_LOG_CHANNEL_ID), f.client, ['delete', 'report', 'reporter']);
  assert.ok(f.channels.has(target.channelId));
  assert.deepEqual(log.components, []);
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  const targetLog = f.logs.messages.cache.get(record.cases.target.closeLogId);
  assert.deepEqual(targetLog.components[0].toJSON().components.map(button => button.label), ['Delete']);
  await handleReportCaseControl(f.interaction(f.staff.user, targetLog, REPORT_LOG_CHANNEL_ID), f.client, ['delete', 'report', 'target']);
  assert.deepEqual(targetLog.components, []);
  assert.deepEqual(log.components, []);
});

test('24-hour countdown updates both notices without new messages, survives restart and expires both channels with red logs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  const notices = Object.values(record.cases).map(entry => f.channels.get(entry.channelId).messages.cache.get(entry.messageId));
  assert.ok(notices.every(notice => JSON.stringify(json(notice.embeds[0])).includes('24:00:00')));
  const count = f.payloads.length;
  t.mock.timers.tick(REPORT_COUNTDOWN_REFRESH_MS); await settle();
  assert.ok(notices.every(notice => JSON.stringify(json(notice.embeds[0])).includes('23:59:30')));
  assert.equal(f.payloads.length, count);
  await restoreReportCaseTimers(f.client);
  t.mock.timers.tick(REPORT_CASE_MS - REPORT_COUNTDOWN_REFRESH_MS - 1); await settle();
  assert.deepEqual(f.removed, ['original-message']);
  t.mock.timers.tick(1); await settle(); await settle();
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.closedAt);
  assert.deepEqual(new Set(f.removed), new Set(['original-message', record.cases.reporter.channelId, record.cases.target.channelId]));
  for (const entry of Object.values(record.cases)) {
    const deleted = f.logs.messages.cache.get(entry.deleteLogId);
    assert.equal(json(deleted.embeds[0]).color, TICKET_EVENT_STYLES.delete.color);
    assert.match(JSON.stringify(json(deleted.embeds[0])), /Automatic.*24-hour expiry/);
  }
  await deleteReportCase(f.client, f.guild, record);
  assert.equal(f.removed.length, 3);
});

test('later outcomes reuse the same pair and deadline without exposing a new reason to the reporter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const record = await f.submit(); const count = f.payloads.length;
  t.mock.timers.tick(60_000); await settle();
  const updated = await publishReportOutcome(f.client, f.guild, f.report, record, 'timeout', 'staff', 'Another private reason');
  assert.equal(updated.expiresAt, record.expiresAt);
  assert.equal(f.payloads.length, count);
  assert.equal(updated.cases.reporter.channelId, record.cases.reporter.channelId);
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  const target = f.channels.get(record.cases.target.channelId).messages.cache.get(record.cases.target.messageId);
  assert.match(JSON.stringify(json(reporter.embeds[0])), /timed out/);
  assert.doesNotMatch(JSON.stringify(json(reporter.embeds[0])), /Another private reason/);
  assert.match(JSON.stringify(json(target.embeds[0])), /Another private reason/);
  await assert.rejects(f.submit(), /already been completed/);
  assert.equal(f.removed.filter(id => id === 'original-message').length, 1);
});

test('Timeout passes the required reason and duration, sends no DM, and consumes the report controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.register();
  const timedOut = [];
  t.mock.method(ModerationService, 'timeoutUser', async data => { timedOut.push(data); });
  const timeoutClick = f.interaction(); await handleReportAction(timeoutClick, f.client, ['timeout', 'target']);
  assert.deepEqual(timeoutClick.modal.components.map(row => [row.components[0].custom_id, row.components[0].required]), [['minutes', true], ['reason', true]]);
  await f.submit('timeout');
  assert.equal(timedOut[0].reason, 'Private action reason'); assert.equal(timedOut[0].durationMs, 600_000);
  assert.equal(f.dms.length, 0);
  assert.deepEqual(f.report.components, []);
});

test('Ban keeps the existing ban-only DM path and consumes the report controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.register();
  const banned = [];
  t.mock.method(ModerationService, 'banUser', async data => { banned.push(data); });
  const record = await f.submit('ban', f.owner.user);
  assert.equal(banned[0].reason, 'Private action reason'); assert.equal(banned[0].notifyBeforeBan, true);
  assert.deepEqual(f.report.components, []);
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  assert.match(JSON.stringify(json(reporter.embeds[0])), /banned/);
  assert.doesNotMatch(JSON.stringify(json(reporter.embeds[0])), /Private action reason/);
});

test('legacy shared case upgrades on restart without repeating moderation or changing the original New report', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const original = structuredClone(f.report.embeds);
  const shared = await f.guild.channels.create({ name: 'report-5', parent: REPORT_CATEGORY_ID });
  const oldNotice = await shared.send({ content: '<@reporter> <@target>', embeds: [{ title: 'Report case notification', description: 'Private reason' }] });
  const oldLog = await f.reports.send({ embeds: [{ title: 'Report action log' }] });
  const legacy = { ...await f.client.db.get(reportKey(f.guild.id, 'report')), number: 5, caseChannelId: shared.id, memberMessageIds: [oldNotice.id], staffMessageIds: [oldLog.id], expiresAt: Date.now() + REPORT_CASE_MS, actions: { ban: { status: 'completed', notified: true, actorId: 'owner', reason: 'Legacy private reason' } } };
  await f.client.db.set(reportKey(f.guild.id, 'report'), legacy);
  await restoreReportCaseTimers(f.client);
  const record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.equal(record.cases.target.channelId, shared.id);
  assert.ok(!shared.resetOverwrites.some(entry => entry.id === 'reporter'));
  assert.equal(oldNotice.content, '<@target> <@&staff-role>');
  assert.ok(f.removed.includes(oldLog.id));
  assert.deepEqual(f.report.embeds, original);
  assert.equal(f.dms.length, 0);
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  assert.doesNotMatch(JSON.stringify(json(reporter.embeds[0])), /Legacy private reason/);
});

test('saved shared notification templates cannot leak private reasons or overwrite countdown and ticket colors', async () => {
  const f = fixture();
  await saveEmbedTemplateDecoration(f.guild.id, 'shared', ['Report case notification'], { title: 'Report case notification', description: 'Leaked reason', fields: [{ name: 'Reason', value: 'Private secret' }], color: 0xFFFFFF }, { sharedScope: true, applyFields: true });
  const payload = { embeds: [{ title: 'Report case notification', description: 'The reported member has been banned.', fields: [{ name: 'Time remaining', value: '23:59:30' }] }] };
  assert.deepEqual(await applySavedResponsePayloadTemplates(payload, { guildId: f.guild.id, channelId: 'reporter' }), payload);
});
