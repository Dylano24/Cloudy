import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, OverwriteType, PermissionOverwrites, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { buildReportActions, handleReportAction, handleReportModeration, reportActionAllowed } from '../src/services/reportActionService.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { registerReport, reportKey, REPORT_CATEGORY_ID, REPORT_CASE_MS, REPORT_LOG_CHANNEL_ID, restoreReportCaseTimers, handleReportCaseControl, publishReportOutcome, deleteReportCase } from '../src/services/reportCaseService.js';
import { TICKET_EVENT_STYLES } from '../src/utils/ticket/ticketLogging.js';
import { feedEmoji } from '../src/services/feedEmojiService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { CLOUDY_GREEN_COLOR } from '../src/utils/embedColorPolicy.js';

const settle = async () => { await new Promise(resolve => { setImmediate(resolve); }); };
const json = embed => embed.toJSON?.() || embed;
const outcome = notice => json(notice.embeds[0]).fields.find(field => /outcome/i.test(field.name)).value;
// A handled report is marked in place (as appeals are): no separate message,
// green side line, Handled by + Handled at where Submitted was, no buttons.
function assertHandledInPlace(f, actorId, outcome) {
  assert.equal(f.payloads.filter(message => message.channelId === 'reports').length, 0);
  assert.deepEqual(f.report.components, []);
  const data = json(f.report.embeds[0]);
  assert.equal(data.title, 'New report');
  assert.equal(data.color, CLOUDY_GREEN_COLOR);
  assert.deepEqual(data.fields.map(field => field.name), ['Reported member', 'Reported by', 'Reason', 'Report handled', 'Handled by', 'Handled at']);
  assert.equal(data.fields[3].value, outcome);
  assert.equal(data.fields[4].value, `<@${actorId}>`);
  assert.match(data.fields[5].value, /^<t:\d+:F>$/);
  return data;
}

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
      inGuild: () => true, deferReply: async () => { result.deferred = true; }, deleteReply: async () => { replyDeletes.push(result.id); }, editReply: async payload => { result.error = payload; },
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
  async function register() { await registerReport(client, report, { guildId: guild.id, reporterId: reporter.id, targetId: target.id, sourceChannelId: originalChannel.id, sourceMessageId: 'original-message', reportedMessageText: 'Original message text' }); }
  return { values, client, guild, staff, reporter, target, owner, roleOwner, reports, logs, channels, report, interaction, payloads, removed, dms, positions, replyDeletes, submit, register };
}

test('Delete asks for a required reason before acting; two adjacent private cases keep the New report intact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  f.report.embeds[0].fields.push({ name: 'Submitted', value: '<t:1799999000:F>' });
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
  assert.equal(json(targetNotice.embeds[0]).fields.find(field => field.name === 'Reason').value, 'Private action reason');
  assert.equal(json(targetNotice.embeds[0]).title, 'Moderation n•1 update');
  assert.equal(json(reporterNotice.embeds[0]).title, 'Report n•1 update');
  assert.deepEqual(json(reporterNotice.embeds[0]).fields.map(field => field.name), ['Reported member', 'Reported message', 'Review outcome', 'Auto-close']);
  assert.deepEqual(json(targetNotice.embeds[0]).fields.map(field => field.name), ['Reported message', 'Review outcome', 'Moderation action', 'Reason', 'Auto-close']);
  assert.match(outcome(reporterNotice), /Appropriate action has been taken/);
  assert.match(outcome(targetNotice), /glowingdotred/);
  assert.ok(json(targetNotice.embeds[0]).fields.find(field => field.name === 'Moderation action').value.startsWith(feedEmoji('report_orange')));
  assert.ok(json(reporterNotice.embeds[0]).description.startsWith(feedEmoji('report_blue') + ' Reviewed'));
  assert.match(json(targetNotice.embeds[0]).fields.find(field => field.name === 'Moderation action').value, /Message removed/);
  assert.match(outcome(reporterNotice), /Action taken/);
  assert.doesNotMatch(outcome(reporterNotice), /Message removed/);
  for (const notice of [targetNotice, reporterNotice]) {
    const embed = json(notice.embeds[0]);
    assert.equal(embed.fields.find(field => field.name === 'Reported message').value, 'Original message text');
    assert.equal(embed.footer.text, 'Cloudy Inc. Moderation team');
    assert.equal(embed.color, 0xFFFFFF);
  }
  assert.deepEqual(targetNotice.components[0].toJSON().components.map(button => button.label), ['Close']);
  // Submitted becomes Handled at, in the same place, with the handling time.
  const handled = assertHandledInPlace(f, 'staff', 'The reported message has been deleted.');
  assert.equal(handled.fields[5].value, '<t:1800000000:F>');
  assert.equal(handled.fields[0].value, '<@target>');
  assert.equal(handled.fields[2].value, 'TEST!');
  for (const [audience, entry] of Object.entries(record.cases)) {
    assert.ok(entry.createdLogId);
    const created = f.logs.messages.cache.get(entry.createdLogId);
    assert.equal(json(created.embeds[0]).title, audience === 'reporter' ? 'Report n•1 update' : 'Moderation n•1 update');
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

test('each participant can close their own report channel in one click, with one close log', async () => {
  const f = fixture(); await f.register();
  const record = await f.submit();
  for (const [audience, member, outsider] of [
    ['target', f.target, f.reporter],
    ['reporter', f.reporter, f.target],
  ]) {
    const entry = record.cases[audience];
    const channel = f.channels.get(entry.channelId);
    const notice = channel.messages.cache.get(entry.messageId);
    assert.equal(json(notice.embeds[0]).color, 0xFFFFFF);
    assert.equal(notice.components[0].toJSON().components[0].label, 'Close');
    const wrongMember = f.interaction(outsider.user, notice, channel.id);
    await handleReportCaseControl(wrongMember, f.client, ['close', record.messageId, audience]);
    assert.equal(json(wrongMember.error.embeds[0]).title, 'Permission denied');
    assert.ok(f.channels.has(channel.id));

    const click = f.interaction(member.user, notice, channel.id);
    await handleReportCaseControl(click, f.client, ['close', record.messageId, audience]);
    assert.equal(f.channels.has(channel.id), false);
    assert.equal(click.error, undefined);
    const latest = await f.client.db.get(reportKey(f.guild.id, record.messageId));
    const closed = latest.cases[audience];
    const log = json(f.logs.messages.cache.get(closed.closeLogId).embeds[0]);
    assert.equal(log.title, audience === 'reporter' ? 'Report n•1 closed' : 'Moderation n•1 closed');
    assert.equal(log.fields.find(field => field.name === 'Closed by').value, `<@${member.id}>`);
    assert.equal(closed.deleteLogId, undefined);
    assert.equal(f.payloads.filter(message => message.channelId === channel.id).length, 1);
    if (audience === 'target') assert.ok(f.channels.has(record.cases.reporter.channelId));
  }
});

test('restore updates active legacy notifications to white Close notices', async () => {
  const f = fixture(); await f.register();
  const record = await f.submit();
  const entry = record.cases.target;
  const notice = f.channels.get(entry.channelId).messages.cache.get(entry.messageId);
  const original = json(notice.embeds[0]);
  await notice.edit({ embeds: [{ ...original, color: 0x00C49D }], components: [] });
  delete entry.closeNoticeReady;
  const key = reportKey(f.guild.id, record.messageId);
  await f.client.db.set(key, record);

  await restoreReportCaseTimers(f.client);
  assert.equal(json(notice.embeds[0]).color, 0xFFFFFF);
  assert.equal(json(notice.embeds[0]).description, original.description);
  assert.equal(notice.components[0].toJSON().components[0].label, 'Close');
  assert.equal((await f.client.db.get(key)).cases.target.closeNoticeReady, true);
});

test('both notices show a static 24-hour deletion message, survive restart and expire both channels with red logs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  const notices = Object.values(record.cases).map(entry => f.channels.get(entry.channelId).messages.cache.get(entry.messageId));
  for (const notice of notices) {
    const data = JSON.stringify(json(notice.embeds[0]));
    assert.match(data, /Auto-close/);
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
  for (const [audience, entry] of Object.entries(record.cases)) {
    const deleted = f.logs.messages.cache.get(entry.deleteLogId);
    assert.equal(json(deleted.embeds[0]).color, TICKET_EVENT_STYLES.delete.color);
    assert.equal(json(deleted.embeds[0]).title, audience === 'reporter' ? 'Report n•1 automatically deleted' : 'Moderation n•1 automatically deleted');
    assert.equal(entry.closeLogId, undefined);
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
  assert.match(outcome(reporter), /Action taken/);
  assert.doesNotMatch(outcome(reporter), /Temporary mute/);
  assert.doesNotMatch(JSON.stringify(json(reporter.embeds[0])), /Another private reason/);
  assert.doesNotMatch(JSON.stringify(json(target.embeds[0])), /Another private reason/);
  assert.match(json(target.embeds[0]).fields.find(field => field.name === 'Moderation action').value, /Temporary mute/);
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
  assert.match(json(targetNotice.embeds[0]).fields.find(field => field.name === 'Moderation action').value, /Temporary mute \(10m\)/);
  assert.equal(json(targetNotice.embeds[0]).fields.find(field => field.name === 'Reason').value, 'Private action reason');
  assert.match(outcome(reporterNotice), /Action taken/);
  assert.doesNotMatch(outcome(reporterNotice), /Temporary mute|10m/);
  assert.deepEqual(f.report.components, []);
  assertHandledInPlace(f, 'staff', 'The reported member has been timed out.');
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
  assertHandledInPlace(f, 'role-owner', 'The reported member has been banned.');
  assert.ok(record.cases.reporter);
  assert.equal(record.cases.target, undefined);
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  assert.match(outcome(reporter), /Action taken/);
  assert.doesNotMatch(outcome(reporter), /banned/);
  assert.doesNotMatch(JSON.stringify(json(reporter.embeds[0])), /Private action reason/);
  assert.deepEqual(reporter.components[0].toJSON().components.map(button => button.label), ['Close']);
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
    assert.match(outcome(notice), /No action taken/);
    assert.match(outcome(notice), audience === 'target' ? /glowing_dot_green/ : /glowingdotred/);
    assert.deepEqual(json(notice.embeds[0]).fields.map(field => field.name), audience === 'reporter'
      ? ['Reported member', 'Reported message', 'Review outcome', 'Auto-close']
      : ['Reported message', 'Review outcome', 'Auto-close']);
    assert.ok(!json(notice.embeds[0]).fields.some(field => field.name === 'Reason' || field.name === 'Moderation action'));
    assert.doesNotMatch(JSON.stringify(json(notice.embeds[0])), /Handled by|Private action reason/);
  }
  assertHandledInPlace(f, 'staff', 'The report was reviewed and no sanction was applied.');
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

  assertHandledInPlace(f, 'staff', 'The reported message has been deleted.\nThe report was reviewed and no sanction was applied.');
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
  assertHandledInPlace(f, 'staff', 'The reported message has been deleted.\nThe reported member has been timed out.');
  const reporter = f.channels.get(record.cases.reporter.channelId).messages.cache.get(record.cases.reporter.messageId);
  const target = f.channels.get(record.cases.target.channelId).messages.cache.get(record.cases.target.messageId);
  assert.match(json(target.embeds[0]).fields.find(field => field.name === 'Moderation action').value, /Message removed & temporary mute \(10m\)/);
  assert.equal(json(target.embeds[0]).fields.find(field => field.name === 'Reason').value, 'Private action reason');
  assert.match(outcome(reporter), /Action taken/);
  assert.doesNotMatch(outcome(reporter), /message removed|temporary mute|10m/i);
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
  assertHandledInPlace(f, 'role-owner', 'The reported message has been deleted.\nThe reported member has been banned.');
});

test('saved shared notification templates cannot leak private reasons or overwrite report notification presentation', async () => {
  const f = fixture();
  await saveEmbedTemplateDecoration(f.guild.id, 'shared', ['Report notification'], { title: 'Report notification', description: 'Leaked reason', fields: [{ name: 'Reason', value: 'Private secret' }], color: 0xFFFFFF }, { sharedScope: true, applyFields: true });
  const payload = { embeds: [{ title: 'Report notification', description: 'The reported member has been banned.', fields: [{ name: 'Automatic deletion', value: 'This report notification will be automatically deleted after 24 hours.' }] }] };
  assert.deepEqual(await applySavedResponsePayloadTemplates(payload, { guildId: f.guild.id, channelId: 'reporter' }), payload);
});

test('startup updates both existing #89 Report created staff logs in place', async () => {
  const f = fixture(); await f.register();
  const record = await f.submit();
  record.number = 89;
  const priorIds = {};
  for (const [audience, entry] of Object.entries(record.cases)) {
    const prior = f.logs.messages.cache.get(entry.createdLogId);
    priorIds[audience] = prior.id;
    const original = json(prior.embeds[0]);
    prior.embeds = [{ ...original, title: 'Report created', fields: original.fields.map(field =>
      field.name === 'Report' ? { ...field, value: '#89' } : field) }];
  }
  const key = reportKey(f.guild.id, record.messageId);
  await f.client.db.set(key, record);
  const messagesBefore = f.logs.messages.cache.size;

  await restoreReportCaseTimers(f.client);
  const latest = await f.client.db.get(key);
  for (const [audience, entry] of Object.entries(latest.cases)) {
    assert.equal(entry.createdLogId, priorIds[audience]);
    assert.equal(entry.logTitlesUpgraded, true);
    const message = f.logs.messages.cache.get(entry.createdLogId);
    assert.equal(json(message.embeds[0]).title, audience === 'reporter'
      ? 'Report n•89 update' : 'Moderation n•89 update');
  }
  assert.equal(f.logs.messages.cache.size, messagesBefore, 'old staff logs are edited, not reposted');
  await restoreReportCaseTimers(f.client);
  assert.equal(f.logs.messages.cache.size, messagesBefore);
});

test('orphaned #89 Report created staff logs are corrected in place without a case record', async () => {
  const f = fixture();
  const originals = [];
  for (const audience of ['Reporter', 'Reported member']) {
    originals.push(await f.logs.send({ embeds: [{
      title: 'Report created', fields: [
        { name: 'Report', value: '#89' },
        { name: 'Audience', value: audience },
      ],
    }] }));
  }
  const unrelated = await f.logs.send({ embeds: [{
    title: 'Report created', fields: [
      { name: 'Report', value: '#88' },
      { name: 'Audience', value: 'Reporter' },
    ],
  }] });
  const messagesBefore = f.logs.messages.cache.size;
  const fetchById = f.logs.messages.fetch;
  f.logs.messages.fetch = async arg => typeof arg === 'object'
    ? f.logs.messages.cache : fetchById(arg);
  f.client.channels = { fetch: async id => {
    assert.equal(id, REPORT_LOG_CHANNEL_ID);
    return f.logs;
  } };

  await restoreReportCaseTimers(f.client);
  assert.equal(json(originals[0].embeds[0]).title, 'Report n•89 update');
  assert.equal(json(originals[1].embeds[0]).title, 'Moderation n•89 update');
  assert.equal(unrelated.embeds[0].title, 'Report created');
  assert.equal(f.logs.messages.cache.size, messagesBefore);
  assert.equal(await f.client.db.get('global:report-log-89-title-backfill'), true);
  await restoreReportCaseTimers(f.client);
  assert.equal(f.logs.messages.cache.size, messagesBefore);
});
