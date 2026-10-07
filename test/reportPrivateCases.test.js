import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, OverwriteType, PermissionOverwrites, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { buildReportActions, handleReportAction, handleReportModeration, reportActionAllowed } from '../src/services/reportActionService.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { registerReport, reportKey, REPORT_CATEGORY_ID, REPORT_CASE_MS, REPORT_LOG_CHANNEL_ID, restoreReportCaseTimers, handleReportCaseControl, publishReportOutcome, deleteReportCase } from '../src/services/reportCaseService.js';
import { TICKET_EVENT_STYLES } from '../src/utils/ticket/ticketLogging.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { CLOUDY_GREEN_COLOR, CLOUDY_RED_COLOR } from '../src/utils/embedColorPolicy.js';

const settle = async () => { await new Promise(resolve => { setImmediate(resolve); }); };
const json = embed => embed.toJSON?.() || embed;

let fixtureNumber = 0;
function fixture() {
  const values = new Map(), payloads = [], removed = [], dms = [], positions = [], replyDeletes = [];
  const storage = { get: async key => structuredClone(values.get(key) || null), set: async (key, value) => { values.set(key, structuredClone(value)); return true; }, list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const member = id => ({ id, user: { id, tag: id, send: async payload => { dms.push({ id, payload }); } }, permissions: new PermissionsBitField(), roles: { cache: new Collection() } });
  const staff = member('staff'), reporter = member('reporter'), target = member('target'), owner = member('owner'), roleOwner = member('role-owner');
  staff.roles.cache.set('staff-role', { id: 'staff-role', name: 'Staff' });
  roleOwner.roles.cache.set('owner-role', { id: 'owner-role', name: 'Owner' });
  const members = new Collection([staff, reporter, target, owner, roleOwner].map(entry => [entry.id, entry]));
  const client = { db: storage, user: { id: 'bot' }, users: { fetch: async id => members.get(id).user } };
  const channels = new Collection();
  const guild = { id: `private-report-guild-${++fixtureNumber}`, name: 'Cloudy', ownerId: 'owner', client,
    roles: { everyone: { id: 'everyone' }, cache: new Collection([
      ['staff-role', { id: 'staff-role', name: 'Staff' }],
      ['owner-role', { id: 'owner-role', name: 'Owner' }],
    ]) },
    members: { fetch: async id => members.get(id) }, channels: { cache: channels, fetch: async id => channels.get(id),
      setPositions: async data => { positions.push(data); },
      create: async data => { const ch = channel(`case-${channels.size}`, data.name); ch.creation = data; ch.rawPosition = data.position ?? channels.size; channels.set(ch.id, ch); return ch; } } };
  client.guilds = { cache: new Collection([[guild.id, guild]]) };
  values.set(`guild:${guild.id}:config`, { ticketStaffRoleId: 'staff-role' });
  function channel(id, name = id) {
    const messages = new Collection();
    const ch = { id, name, guild, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => false }),
      overwriteEdits: [], messages: { cache: messages, fetch: async id => messages.get(id) },
      permissionOverwrites: {
        cache: new Collection(),
        edit: async (subject, permissions) => {
          ch.overwriteEdits.push({ id: subject?.id || subject, permissions });
        },
        set: async overwrites => { ch.resetOverwrites = overwrites; },
      },
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
      inGuild: () => true,
      deferReply: async () => { result.deferred = true; },
      deferUpdate: async () => { result.deferred = true; result.silentDeferred = true; },
      deleteReply: async () => { replyDeletes.push(result.id); },
      editReply: async payload => { result.error = payload; },
      followUp: async payload => { result.error = payload; return { id: `followup-${result.id}` }; },
      webhook: { deleteMessage: async id => { replyDeletes.push(id); } },
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
  return { values, client, guild, staff, reporter, target, owner, roleOwner, reports, logs, channels, report, interaction, payloads, removed, dms, positions, replyDeletes, submit, register };
}

test('Read confirms its durable close before waiting for staff log delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.register();
  const record = await f.submit('no_sanction');
  const entry = record.cases.target;
  const channel = f.channels.get(entry.channelId);
  const notice = channel.messages.cache.get(entry.messageId);
  const read = f.interaction(f.target.user, notice, channel.id);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = f.logs.send;
  f.logs.send = async payload => { await gate; return send(payload); };
  const pending = handleReportCaseControl(read, f.client, ['read', record.messageId, 'target']);
  try {
    await settle();
    assert.ok(f.values.get(reportKey(f.guild.id, record.messageId)).cases.target.closedAt, 'Read must be persisted before confirmation');
    assert.ok(channel.overwriteEdits.length, 'Participant access must be revoked before confirmation');
    assert.equal(read.silentDeferred, true, 'Read must acknowledge without showing a thinking reply');
    assert.equal(read.error?.flags, 64);
    assert.equal(read.error?.embeds?.[0] && json(read.error.embeds[0]).title, 'Thank you.');
  } finally {
    release();
    await pending;
  }
});

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
  assert.ok(target.creation.permissionOverwrites.every(entry => entry.type === (['everyone', 'staff-role', 'owner-role'].includes(entry.id) ? OverwriteType.Role : OverwriteType.Member)));
  // Discord must resolve banned/uncached users without looking up cached structures.
  for (const entry of target.creation.permissionOverwrites) assert.equal(PermissionOverwrites.resolve(entry, {}).id, entry.id);
  assert.ok(!target.creation.permissionOverwrites.some(entry => entry.id === 'reporter'));
  const reporterNotice = reporter.messages.cache.get(record.cases.reporter.messageId), targetNotice = target.messages.cache.get(record.cases.target.messageId);
  assert.equal(reporterNotice.content, '<@reporter>');
  assert.deepEqual(reporterNotice.allowedMentions, { parse: [], users: ['reporter'], roles: [] });
  assert.doesNotMatch(JSON.stringify(json(reporterNotice.embeds[0])), /Private action reason|Reason|staff/);
  assert.equal(targetNotice.content, '<@target>');
  assert.match(JSON.stringify(json(targetNotice.embeds[0])), /Private action reason/);
  assert.equal(json(targetNotice.embeds[0]).title, 'Report notification');
  assert.equal(json(targetNotice.embeds[0]).description, 'A message you sent was reported and has been removed by our staff.');
  assert.ok(json(targetNotice.embeds[0]).fields.some(field => field.name === 'Automatic deletion'
    && field.value === 'This report notification will be automatically deleted after 24 hours.'));
  assert.equal(json(reporterNotice.embeds[0]).title, 'Report notification');
  assert.equal(json(reporterNotice.embeds[0]).description, 'The reported message has been deleted.');
  assert.deepEqual(targetNotice.components[0].toJSON().components.map(button => button.label), ['Read']);
  const publicSuccess = f.payloads.filter(message => message.channelId === 'reports');
  assert.equal(publicSuccess.length, 1);
  const successData = json(publicSuccess[0].embeds[0]);
  assert.equal(successData.title, 'Report handled');
  assert.equal(successData.description, 'The reported message has been deleted.');
  assert.equal(successData.color, CLOUDY_GREEN_COLOR);
  assert.ok(successData.fields.some(field => field.name === 'Report #1' && field.value === '\u200B'));
  assert.ok(successData.fields.some(field => field.name === 'Handled by' && field.value === '<@staff>'));
  assert.ok(successData.fields.some(field => field.name === 'Handled at'));
  assert.deepEqual(publicSuccess[0].allowedMentions, { parse: [] });
  assert.equal(publicSuccess[0].flags, undefined);
  t.mock.timers.tick(10_000); await settle();
  assert.ok(f.reports.messages.cache.has(publicSuccess[0].id));
  assert.deepEqual(f.report.embeds, snapshot.embeds);
  assert.deepEqual(f.report.components, []);
  for (const entry of Object.values(record.cases)) {
    assert.ok(entry.createdLogId);
    const created = f.logs.messages.cache.get(entry.createdLogId);
    assert.equal(json(created.embeds[0]).title, 'Report created');
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

test('target Read creates a private red Delete report prompt while report logs stay informational', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  const channel = f.channels.get(record.cases.target.channelId);
  const notice = channel.messages.cache.get(record.cases.target.messageId);

  const forged = f.interaction(f.reporter.user, notice, channel.id);
  await handleReportCaseControl(forged, f.client, ['read', 'report', 'target']);
  assert.equal(channel.overwriteEdits.length, 0);

  const close = f.interaction(f.target.user, notice, channel.id);
  await handleReportCaseControl(close, f.client, ['read', 'report', 'target']);
  assert.equal(close.error.content, null);
  const readConfirmation = json(close.error.embeds[0]);
  assert.equal(readConfirmation.title, 'Thank you.');
  assert.equal(readConfirmation.description, 'We have been informed that you have read this report.');
  assert.equal(readConfirmation.color, CLOUDY_GREEN_COLOR);
  assert.ok(readConfirmation.thumbnail?.url);
  assert.equal(readConfirmation.footer?.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  const confirmationDeletesBefore = f.replyDeletes.length;
  t.mock.timers.tick(9_999);
  assert.equal(f.replyDeletes.length, confirmationDeletesBefore);
  t.mock.timers.tick(1);
  assert.equal(f.replyDeletes.length, confirmationDeletesBefore + 1);

  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.cases.target.closedAt);
  assert.equal(record.closedAt, undefined);
  assert.deepEqual(channel.overwriteEdits, [{ id: 'target', permissions: { ViewChannel: false, SendMessages: false, ReadMessageHistory: false } }]);
  const noticeButtons = notice.components[0].toJSON().components;
  assert.deepEqual(noticeButtons.map(button => button.label), ['Read']);
  assert.equal(noticeButtons[0].disabled, true);

  const prompt = channel.messages.cache.get(record.cases.target.deletePromptId);
  const promptData = json(prompt.embeds[0]);
  assert.equal(promptData.title, 'Delete report');
  assert.equal(promptData.description, 'This report has been read by <@target>.');
  assert.equal(promptData.color, CLOUDY_RED_COLOR);
  assert.ok(promptData.thumbnail?.url);
  assert.deepEqual(prompt.components[0].toJSON().components.map(button => button.label), ['Delete']);

  const log = f.logs.messages.cache.get(record.cases.target.closeLogId);
  const logData = json(log.embeds[0]);
  assert.equal(logData.color, TICKET_EVENT_STYLES.close.color);
  assert.equal(logData.title, 'Report closed');
  assert.equal(log.content, null);
  assert.deepEqual(log.components, []);
  assert.ok(!logData.fields.some(field => field.name === 'Channel'));

  const promptId = record.cases.target.deletePromptId;
  await handleReportCaseControl(close, f.client, ['read', 'report', 'target']);
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.equal(record.cases.target.deletePromptId, promptId);

  const beforeDeniedDeletes = f.replyDeletes.length;
  const denied = f.interaction(f.target.user, prompt, channel.id);
  await handleReportCaseControl(denied, f.client, ['delete', 'report', 'target']);
  assert.deepEqual(f.removed, ['original-message']);
  const deniedData = json(denied.error.embeds[0]);
  assert.equal(deniedData.title, 'Permission denied');
  assert.equal(deniedData.description, 'Only the staff can delete this report.');
  assert.equal(deniedData.color, CLOUDY_RED_COLOR);
  assert.ok(deniedData.thumbnail?.url);
  t.mock.timers.tick(9_999);
  assert.equal(f.replyDeletes.length, beforeDeniedDeletes);
  t.mock.timers.tick(1);
  assert.equal(f.replyDeletes.length, beforeDeniedDeletes + 1);

  await handleReportCaseControl(f.interaction(f.staff.user, prompt, channel.id), f.client, ['delete', 'report', 'target']);
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.cases.target.deletedAt);
  assert.equal(record.cases.reporter.deletedAt, undefined);
  assert.ok(record.cases.target.createdLogId);
  assert.equal(json(f.logs.messages.cache.get(record.cases.target.createdLogId).embeds[0]).title, 'Report created');
  assert.ok(f.channels.has(record.cases.reporter.channelId));

  const deleted = f.logs.messages.cache.get(record.cases.target.deleteLogId);
  const deletedData = json(deleted.embeds[0]);
  assert.equal(deletedData.color, TICKET_EVENT_STYLES.delete.color);
  assert.equal(deletedData.title, 'Report deleted');
  assert.match(JSON.stringify(deletedData), /Deleted by.*staff/);
  assert.ok(!deletedData.fields.some(field => field.name === 'Channel'));
  assert.deepEqual(deleted.components, []);
});

test('Close survives an old participant overwrite when the member is no longer in the guild', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();

  const entry = record.cases.target;
  const channel = f.channels.get(entry.channelId);
  const notice = channel.messages.cache.get(entry.messageId);
  const originalFetch = f.guild.members.fetch;
  f.guild.members.fetch = async id => id === 'target' ? null : originalFetch(id);

  let edited = null;
  channel.permissionOverwrites.cache.set('target', {
    id: 'target',
    edit: async permissions => { edited = permissions; },
  });

  const close = f.interaction(f.staff.user, notice, channel.id);
  await handleReportCaseControl(close, f.client, ['read', 'report', 'target']);

  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.cases.target.closedAt);
  assert.deepEqual(edited, {
    ViewChannel: false,
    SendMessages: false,
    ReadMessageHistory: false,
  });
});

test('reporter Read removes only reporter access; Staff deletes each acknowledged report from its private prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();

  const reporterEntry = record.cases.reporter;
  const reporterChannel = f.channels.get(reporterEntry.channelId);
  const reporterNotice = reporterChannel.messages.cache.get(reporterEntry.messageId);
  await handleReportCaseControl(f.interaction(f.reporter.user, reporterNotice, reporterChannel.id), f.client, ['read', 'report', 'reporter']);
  assert.equal(reporterChannel.overwriteEdits[0].id, 'reporter');

  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.equal(record.cases.target.closedAt, undefined);
  const reporterLog = f.logs.messages.cache.get(record.cases.reporter.closeLogId);
  assert.equal(json(reporterLog.embeds[0]).title, 'Report closed');
  assert.deepEqual(reporterLog.components, []);
  assert.ok(!json(reporterLog.embeds[0]).fields.some(field => field.name === 'Channel'));

  const targetEntry = record.cases.target;
  const targetChannel = f.channels.get(targetEntry.channelId);
  const targetNotice = targetChannel.messages.cache.get(targetEntry.messageId);
  await handleReportCaseControl(f.interaction(f.staff.user, targetNotice, targetChannel.id), f.client, ['read', 'report', 'target']);

  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.equal(record.cases.target.closedBy, 'staff');
  assert.equal(targetChannel.overwriteEdits[0].id, 'target');

  const reporterPrompt = reporterChannel.messages.cache.get(record.cases.reporter.deletePromptId);
  const targetPrompt = targetChannel.messages.cache.get(record.cases.target.deletePromptId);
  assert.deepEqual(reporterPrompt.components[0].toJSON().components.map(button => button.label), ['Delete']);
  assert.deepEqual(targetPrompt.components[0].toJSON().components.map(button => button.label), ['Delete']);

  await handleReportCaseControl(f.interaction(f.staff.user, reporterPrompt, reporterChannel.id), f.client, ['delete', 'report', 'reporter']);
  assert.ok(f.channels.has(targetChannel.id));

  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  await handleReportCaseControl(f.interaction(f.staff.user, targetPrompt, targetChannel.id), f.client, ['delete', 'report', 'target']);
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.closedAt);

  const targetLog = f.logs.messages.cache.get(record.cases.target.closeLogId);
  assert.deepEqual(targetLog.components, []);
  assert.deepEqual(reporterLog.components, []);
});

test('both notices show a static 24-hour deletion message, survive restart and expire both channels with red logs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  const notices = Object.values(record.cases).map(entry => f.channels.get(entry.channelId).messages.cache.get(entry.messageId));
  for (const notice of notices) {
    const data = JSON.stringify(json(notice.embeds[0]));
    assert.match(data, /Automatic deletion/);
    assert.match(data, /automatically deleted after 24 hours/);
    assert.doesNotMatch(data, /Time remaining|24:00:00|23:59/);
  }
  await restoreReportCaseTimers(f.client);
  t.mock.timers.tick(REPORT_CASE_MS - 1); await settle();
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
  const actionsBeforeStaleSubmit = structuredClone((await f.client.db.get(reportKey(f.guild.id, 'report'))).actions);
  await f.submit();
  assert.deepEqual((await f.client.db.get(reportKey(f.guild.id, 'report'))).actions, actionsBeforeStaleSubmit);
  assert.deepEqual(f.report.components, []);
  assert.equal(f.removed.filter(id => id === 'original-message').length, 1);
});

test('report permissions reserve Ban for the Owner role while Staff keeps Delete and Timeout', () => {
  const f = fixture();
  assert.equal(reportActionAllowed({ guild: f.guild, user: f.owner.user, member: f.owner }, 'ban'), false);
  assert.equal(reportActionAllowed({ guild: f.guild, user: f.staff.user, member: f.staff }, 'ban'), false);
  assert.equal(reportActionAllowed({ guild: f.guild, user: f.roleOwner.user, member: f.roleOwner }, 'ban'), true);
  assert.equal(reportActionAllowed({ guild: f.guild, user: f.staff.user, member: f.staff }, 'delete'), true);
  assert.equal(reportActionAllowed({ guild: f.guild, user: f.staff.user, member: f.staff }, 'timeout'), true);
});

test('Timeout passes the required reason and duration, sends no DM, consumes controls and posts persistent public success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.register();
  const timedOut = [];
  t.mock.method(ModerationService, 'timeoutUser', async data => { timedOut.push(data); });
  const timeoutClick = f.interaction(); await handleReportAction(timeoutClick, f.client, ['timeout', 'target']);
  assert.deepEqual(timeoutClick.modal.components.map(row => [row.components[0].custom_id, row.components[0].required]), [['minutes', true], ['reason', true]]);
  const record = await f.submit('timeout');
  assert.equal(timedOut[0].reason, 'Private action reason'); assert.equal(timedOut[0].durationMs, 600_000);
  assert.equal(f.dms.length, 0);
  const targetNotice = f.channels.get(record.cases.target.channelId).messages.cache.get(record.cases.target.messageId);
  const reporterNotice = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  assert.equal(json(targetNotice.embeds[0]).title, 'Report notification');
  assert.equal(json(targetNotice.embeds[0]).description, 'A report involving you has been reviewed by our staff and you have been timed out.');
  assert.match(JSON.stringify(json(targetNotice.embeds[0])), /Private action reason/);
  assert.equal(json(reporterNotice.embeds[0]).title, 'Report notification');
  assert.equal(json(reporterNotice.embeds[0]).description, 'The reported member has been timed out.');
  assert.deepEqual(f.report.components, []);
  const success = f.payloads.find(message => message.channelId === 'reports');
  const data = json(success.embeds[0]);
  assert.equal(data.title, 'Report handled');
  assert.equal(data.description, 'The reported member has been timed out.');
  assert.equal(data.color, CLOUDY_GREEN_COLOR);
  assert.ok(data.fields.some(field => field.name === 'Report #1' && field.value === '\u200B'));
  assert.ok(data.fields.some(field => field.name === 'Handled by' && field.value === '<@staff>'));
  t.mock.timers.tick(10_000); await settle();
  assert.ok(f.reports.messages.cache.has(success.id));
});

test('Ban keeps the existing ban-only DM path, creates only the reporter case and consumes the report controls', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.register();
  const banned = [];
  t.mock.method(ModerationService, 'banUser', async data => { banned.push(data); });
  const record = await f.submit('ban', f.roleOwner.user);
  assert.equal(banned[0].reason, 'Private action reason'); assert.equal(banned[0].notifyBeforeBan, true);
  const banDm = banned[0].notificationPayload;
  assert.deepEqual(banDm.allowedMentions, { parse: [] });
  const banEmbed = json(banDm.embeds[0]);
  assert.equal(banEmbed.title, 'You have been banned');
  assert.match(banEmbed.description, /\*\*Reason\*\*\nPrivate action reason/);
  assert.match(banEmbed.description, /https:\/\/cloudy-store-vert\.vercel\.app\/appeal/);
  assert.ok(banEmbed.thumbnail?.url || banEmbed.footer?.text, 'Ban DM retains its existing logo or footer');
  assert.deepEqual(f.report.components, []);
  const success = f.payloads.find(message => message.channelId === 'reports');
  const successData = json(success.embeds[0]);
  assert.equal(successData.title, 'Report handled');
  assert.equal(successData.description, 'The reported member has been banned.');
  assert.equal(successData.color, CLOUDY_GREEN_COLOR);
  assert.ok(successData.fields.some(field => field.name === 'Report #1' && field.value === '\u200B'));
  assert.ok(successData.fields.some(field => field.name === 'Handled by' && field.value === '<@role-owner>'));
  t.mock.timers.tick(10_000); await settle();
  assert.ok(f.reports.messages.cache.has(success.id));
  assert.ok(record.cases.reporter);
  assert.equal(record.cases.target, undefined);
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  assert.match(JSON.stringify(json(reporter.embeds[0])), /banned/);
  assert.doesNotMatch(JSON.stringify(json(reporter.embeds[0])), /Private action reason/);
  assert.deepEqual(reporter.components[0].toJSON().components.map(button => button.label), ['Read']);
  assert.equal(
    f.payloads.filter(message => message.channelId === REPORT_LOG_CHANNEL_ID
      && JSON.stringify(message.embeds).includes('Reported member case')).length,
    0,
  );
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
  assert.equal(record.cases.target, undefined);
  assert.ok(f.removed.includes(shared.id));
  assert.ok(f.removed.includes(oldLog.id));
  assert.deepEqual(f.report.embeds, original);
  assert.equal(f.dms.length, 0);
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  assert.doesNotMatch(JSON.stringify(json(reporter.embeds[0])), /Legacy private reason/);
});

test('No sanction closes the report without moderation and notifies both members without Staff tags', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const record = await f.submit('no_sanction');
  assert.deepEqual(f.removed, []);
  assert.equal(record.actions.no_sanction.status, 'completed');
  assert.equal(record.actions.no_sanction.notified, true);
  for (const [audience, entry] of Object.entries(record.cases)) {
    const notice = f.channels.get(entry.channelId).messages.cache.get(entry.messageId);
    const participant = audience === 'reporter' ? 'reporter' : 'target';
    assert.equal(notice.content, `<@${participant}>`);
    assert.deepEqual(notice.allowedMentions, { parse: [], users: [participant], roles: [] });
    if (audience === 'target') {
      assert.equal(json(notice.embeds[0]).description, 'A report about you has been reviewed by our staff, and no sanction was applied.');
    } else {
      assert.match(json(notice.embeds[0]).description, /no sanction was applied/i);
    }
    assert.doesNotMatch(JSON.stringify(json(notice.embeds[0])), /Handled by|Private action reason/);
  }
  const handled = f.payloads.find(message => message.channelId === 'reports');
  assert.equal(json(handled.embeds[0]).title, 'Report handled');
  assert.match(json(handled.embeds[0]).description, /no sanction was applied/i);
});

test('failed Delete + timeout performs no partial delete and still allows No sanction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const originalFetch = f.guild.members.fetch;
  f.guild.members.fetch = async id => id === 'target' ? null : originalFetch(id);

  const timedOut = [];
  t.mock.method(ModerationService, 'timeoutUser', async data => { timedOut.push(data); });

  await assert.rejects(f.submit('delete_timeout'), /no longer in this server/);
  assert.deepEqual(f.removed, []);
  assert.equal(timedOut.length, 0);

  let record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.equal(record.actions?.delete?.status, undefined);
  assert.equal(record.actions?.timeout?.status, undefined);
  assert.ok(f.report.components.length > 0);

  record = await f.submit('no_sanction');
  assert.equal(record.actions.no_sanction.status, 'completed');
  assert.equal(record.actions.no_sanction.notified, true);
  assert.deepEqual(f.report.components, []);
});

test('No sanction can recover an old partial Delete + timeout report', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();

  let record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  record.actions = {
    delete: { status: 'completed', actorId: 'staff', reason: 'Old partial action', completedAt: Date.now() - 1000 },
    timeout: { status: 'failed', actorId: 'staff', reason: 'Old partial action', durationMs: 600_000 },
  };
  await f.client.db.set(reportKey(f.guild.id, 'report'), record);

  record = await f.submit('no_sanction');
  assert.equal(record.actions.delete.notified, true);
  assert.equal(record.actions.no_sanction.notified, true);
  assert.deepEqual(record.handledActions, ['delete', 'no_sanction']);

  const handled = f.payloads.find(message => message.channelId === 'reports');
  const data = json(handled.embeds[0]);
  assert.match(data.description, /reported message has been deleted/i);
  assert.match(data.description, /no sanction was applied/i);
});

test('Delete + timeout performs both actions once and explains both outcomes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const timedOut = [];
  t.mock.method(ModerationService, 'timeoutUser', async data => { timedOut.push(data); });
  const record = await f.submit('delete_timeout');
  assert.equal(timedOut.length, 1);
  assert.deepEqual(f.removed, ['original-message']);
  assert.equal(record.actions.delete.notified, true);
  assert.equal(record.actions.timeout.notified, true);
  const handled = f.payloads.find(message => message.channelId === 'reports');
  const data = json(handled.embeds[0]);
  assert.match(data.description, /reported message has been deleted/i);
  assert.match(data.description, /reported member has been timed out/i);
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  const target = f.channels.get(record.cases.target.channelId).messages.cache.get(record.cases.target.messageId);
  assert.equal(json(target.embeds[0]).title, 'Report notification');
  assert.equal(json(target.embeds[0]).description, 'A message you sent was reported and has been removed by our staff. You have also been timed out.');
  assert.match(JSON.stringify(json(target.embeds[0])), /Private action reason/);
  assert.equal(json(reporter.embeds[0]).title, 'Report notification');
  assert.match(json(reporter.embeds[0]).description, /deleted/i);
  assert.match(json(reporter.embeds[0]).description, /timed out/i);
});

test('Delete + ban performs both actions and keeps only the reporter case after the ban', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const banned = [];
  t.mock.method(ModerationService, 'banUser', async data => { banned.push(data); });
  const record = await f.submit('delete_ban', f.roleOwner.user);
  assert.equal(banned.length, 1);
  assert.deepEqual(f.removed, ['original-message']);
  assert.equal(record.actions.delete.notified, true);
  assert.equal(record.actions.ban.notified, true);
  assert.ok(record.cases.reporter);
  assert.equal(record.cases.target, undefined);
  const handled = f.payloads.find(message => message.channelId === 'reports');
  const data = json(handled.embeds[0]);
  assert.match(data.description, /reported message has been deleted/i);
  assert.match(data.description, /reported member has been banned/i);
});

test('saved shared notification templates cannot leak private reasons or overwrite report notification presentation', async () => {
  const f = fixture();
  await saveEmbedTemplateDecoration(f.guild.id, 'shared', ['Report notification'], { title: 'Report notification', description: 'Leaked reason', fields: [{ name: 'Reason', value: 'Private secret' }], color: 0xFFFFFF }, { sharedScope: true, applyFields: true });
  const payload = { embeds: [{ title: 'Report notification', description: 'The reported member has been banned.', fields: [{ name: 'Automatic deletion', value: 'This report notification will be automatically deleted after 24 hours.' }] }] };
  assert.deepEqual(await applySavedResponsePayloadTemplates(payload, { guildId: f.guild.id, channelId: 'reporter' }), payload);
});
