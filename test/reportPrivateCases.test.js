import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, OverwriteType, PermissionOverwrites, PermissionsBitField } from 'discord.js';
import { db } from '../src/utils/database.js';
import { buildReportActions, handleReportAction, handleReportModeration, reportActionAllowed, timeoutDuration } from '../src/services/reportActionService.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { registerReport, reportKey, REPORT_CATEGORY_ID, REPORT_CASE_MS, REPORT_LOG_CHANNEL_ID, restoreReportCaseTimers, handleReportCaseControl, publishReportOutcome, deleteReportCase } from '../src/services/reportCaseService.js';
import { TICKET_EVENT_STYLES } from '../src/utils/ticket/ticketLogging.js';
import { feedEmoji } from '../src/services/feedEmojiService.js';
import { applySavedResponsePayloadTemplates } from '../src/events/fullResponseCatalogReady.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import { CLOUDY_GREEN_COLOR } from '../src/utils/embedColorPolicy.js';

const settle = async () => { await new Promise(resolve => { setImmediate(resolve); }); };
const json = embed => embed.toJSON?.() || embed;
const noticeSections = notice => [...(json(notice.embeds[0]).description || '').matchAll(/\*\*([^\n*]+)\*\*\n/g)].map(match => match[1]);
const noticeSection = (notice, name) => {
  const description = json(notice.embeds[0]).description || '';
  const marker = `**${name}**\n`;
  const start = description.indexOf(marker);
  if (start < 0) return undefined;
  const from = start + marker.length;
  const rest = description.slice(from);
  const next = rest.search(/\n(?:\n)?\*\*[^*\n]+\*\*\n/);
  // A small gap (an empty line in small text) between sections is spacing, not section text.
  return rest.slice(0, next < 0 ? undefined : next).replace(/\n-# \u200b\s*$/, '').trim();
};
const outcome = notice => noticeSection(notice, 'Review outcome');
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

test('report timeout accepts 1m 1h 1d 1w, and existing minutes input', () => {
  for (const [input, minutes] of [['1m',1],['1h',60],['1d',1440],['1w',10080],['10',10],['2W',20160],[' 4h ',240],['28d',40320]]) {
    assert.equal(timeoutDuration(input), minutes * 60_000);
  }
  for (const invalid of ['0', '0m', '29d', '5w', '40321', '1x', 'abc', '1h5m', '1.5h', '', '-1h']) {
    assert.throws(() => timeoutDuration(invalid), /Invalid duration|Timeout duration/);
  }
});

test('timeout modal shows units in label and placeholder', async () => {
  const f = fixture(); await f.register();
  const click = f.interaction();
  await handleReportAction(click, f.client, ['timeout', 'target']);
  const durationField = click.modal.components[0].components[0];
  assert.equal(durationField.label, 'Duration (1m, 1h, 1w)');
  assert.equal(durationField.placeholder, '1m, 1h, 1d, 1w');
});

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
  assert.equal(noticeSection(targetNotice, 'Reason'), 'Private action reason');
  for (const [audience, entry] of Object.entries(record.cases)) {
    const createdLog = json(f.logs.messages.cache.get(entry.createdLogId).embeds[0]);
    assert.equal(createdLog.title, audience === 'reporter' ? 'Report update' : 'Moderation update');
    assert.equal(createdLog.footer?.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
    assert.ok(createdLog.thumbnail?.url, 'new report staff log includes Cloudy C logo');
    assert.equal(createdLog.fields.find(field => field.name === 'Report')?.value, '#1');
  }
  assert.equal(json(targetNotice.embeds[0]).title, 'Moderation update');
  assert.equal(json(reporterNotice.embeds[0]).title, 'Report update');
  assert.deepEqual(noticeSections(reporterNotice), ['Reported member', 'Reported message', 'Review outcome', 'Auto-close']);
  assert.deepEqual(noticeSections(targetNotice), ['Reported message', 'Review outcome', 'Moderation action', 'Reason', 'Auto-close']);
  assert.match(outcome(reporterNotice), /Appropriate action has been taken/);
  assert.ok(json(reporterNotice.embeds[0]).description.includes('fair and safe.\n-# \u200b\n**Auto-close**'), 'a small gap (an empty line in small text) between the thanks and Auto-close (owner\'s choice)');
  assert.match(outcome(targetNotice), /glowingdotred/);
  assert.ok(noticeSection(targetNotice, 'Moderation action').startsWith(feedEmoji('report_orange')));
  assert.ok(json(reporterNotice.embeds[0]).description.startsWith(feedEmoji('report_blue') + ' Reviewed\n-# \u200b\nYour report'), 'a small gap under Reviewed (owner\'s choice)');
  assert.ok(json(reporterNotice.embeds[0]).description.includes('by our moderation team.\n-# \u200b\n**Reported member**\n'), 'a small gap above Reported member (owner\'s choice)');
  assert.match(noticeSection(targetNotice, 'Moderation action'), /Message removed/);
  assert.match(outcome(reporterNotice), /Action taken/);
  assert.doesNotMatch(outcome(reporterNotice), /Message removed/);
  for (const notice of [targetNotice, reporterNotice]) {
    const embed = json(notice.embeds[0]);
    assert.equal(noticeSection(notice, 'Reported message'), 'Original message text');
    assert.equal(embed.footer.text, 'Cloudy Inc. • Moderation team • R1');
    assert.equal(embed.thumbnail, undefined, 'private update embeds must not have a C logo');
    assert.ok(embed.description.includes(notice === reporterNotice
      ? '\n**Reported message**\n'
      : 'and has been reviewed.\n-# \u200b\n**Reported message**\n'), 'reporter: right under the member; target: a small gap under its opening sentence');
    assert.ok(embed.description.includes('Original message text\n**Review outcome**\n'), 'reported message and outcome are closer');
    assert.ok(!embed.description.includes('Original message text\n\n**Review outcome**\n'), 'no double gap at the highlighted transition');
    assert.ok(!embed.description.endsWith('\n\n'), 'no extra spacing after the last section');
    assert.ok(!embed.fields?.length, 'private notice sections are rendered as one description for consistent spacing');
    if (notice === reporterNotice) {
      assert.match(noticeSection(notice, 'Review outcome'), /Action taken\n-# \u200b\nAppropriate action/, 'a small gap under Action taken (owner\'s choice)');
      assert.ok(embed.description.includes('server rules.\n-# \u200b\nThank you'), 'a small gap between the outcome text and the thanks (owner\'s choice)');
      assert.ok(embed.description.includes('<@target>\n**Reported message**\n'), 'member and reported message are closer');
    } else {
      assert.ok(embed.description.startsWith('Your recent message'), 'no artificial gap below moderation title');
      assert.ok(!embed.description.endsWith('\n\u200b'));
      assert.match(embed.description, /Action taken\n\*\*Moderation action\*\*\n/, 'outcome and moderation action have a compact gap');
      assert.match(embed.description, /Message removed\n\*\*Reason\*\*\n/, 'moderation action and reason have a compact gap');
      assert.ok(embed.description.includes('Private action reason\n-# \u200b\n**Auto-close**\n'), 'a small gap between the reason and Auto-close (owner\'s choice: the same in every report message)');
    }
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
    assert.equal(json(created.embeds[0]).title, audience === 'reporter' ? 'Report update' : 'Moderation update');
  }
  assert.equal(f.dms.length, 0);
});

test('report update footers match the visible channel number and repair existing notices', async () => {
  const f = fixture(); await f.register();
  const record = await f.submit();
  const count = f.payloads.length;
  for (const audience of ['reporter', 'target']) {
    const entry = record.cases[audience];
    const channel = f.channels.get(entry.channelId);
    channel.name = 'report-104';
    const notice = channel.messages.cache.get(entry.messageId);
    const old = json(notice.embeds[0]);
    notice.embeds = [{ ...old,
      // Simulate an older, field-based notice to verify migration on restart.
      description: old.description.split(/\n(?:-# \u200b\n|\n)(?=\*\*)/)[0].replace('Reviewed\n-# \u200b\n', 'Reviewed\n'),
      footer: { text: 'Cloudy Inc. Moderation team • R103' },
      fields: noticeSections(notice).map(name => ({
        name,
        value: noticeSection(notice, name).replace('Action taken\n-# \u200b\n', 'Action taken\n')
          .replace('server rules.\n\n', 'server rules.\n'),
      })),
    }];
  }

  await restoreReportCaseTimers(f.client);
  for (const audience of ['reporter', 'target']) {
    const entry = record.cases[audience];
    const notice = f.channels.get(entry.channelId).messages.cache.get(entry.messageId);
    const embed = json(notice.embeds[0]);
    assert.equal(embed.footer.text, 'Cloudy Inc. • Moderation team • R104');
    assert.ok(!embed.description.endsWith('\n\u200b'));
    assert.ok(embed.description.includes('Original message text\n**Review outcome**\n'));
    if (audience === 'reporter') {
      assert.ok(embed.description.includes('Reviewed\n-# \u200b\nYour report'));
      assert.ok(embed.description.includes('by our moderation team.\n-# \u200b\n**Reported member**'));
      assert.match(noticeSection(notice, 'Review outcome'), /Action taken\n-# \u200b\nAppropriate action/);
      assert.ok(embed.description.includes('server rules.\n-# \u200b\nThank you'), 'an existing notice gets the small gap too');
      assert.ok(embed.description.includes('fair and safe.\n-# \u200b\n**Auto-close**'));
      assert.ok(!embed.description.includes('\u200b\n-# \u200b'), 'never two small gaps after a second refresh');
    }
  }
  assert.equal(f.payloads.length, count, 'existing notices are edited, never reposted');
  assert.equal(record.number, 1, 'do not rewrite stored report identity');
  await publishReportOutcome(f.client, f.guild, f.report, record, ['delete'], 'staff');
  for (const audience of ['reporter', 'target']) {
    const entry = record.cases[audience];
    const notice = f.channels.get(entry.channelId).messages.cache.get(entry.messageId);
    assert.equal(json(notice.embeds[0]).footer.text, 'Cloudy Inc. • Moderation team • R104');
  }
});

test('report-113 reporter and moderation notices always use R113 even with stale record numbers', async () => {
  const f = fixture();
  await f.register();
  let record = await f.submit();
  for (const audience of ['reporter', 'target']) {
    const channel = f.channels.get(record.cases[audience].channelId);
    channel.name = 'report-113';
  }
  const oldReportNumber = record.number;
  record.number = 103;
  await publishReportOutcome(f.client, f.guild, f.report, record, ['delete'], 'staff');
  for (const audience of ['reporter', 'target']) {
    const entry = record.cases[audience];
    const channel = f.channels.get(entry.channelId);
    const notice = channel.messages.cache.get(entry.messageId);
    const embed = json(notice.embeds[0]);
    assert.equal(embed.footer.text, 'Cloudy Inc. • Moderation team • R113');
    assert.equal(embed.title, audience === 'reporter' ? 'Report update' : 'Moderation update');
  }
  assert.notEqual(oldReportNumber, 113, 'case number deliberately differs from channel');
});

test('existing compact moderation notice restores one blank line before Auto-close', async () => {
  const f = fixture(); await f.register();
  const record = await f.submit();
  const entry = record.cases.target;
  const notice = f.channels.get(entry.channelId).messages.cache.get(entry.messageId);
  const old = json(notice.embeds[0]);
  assert.ok(old.description.includes('Private action reason\n-# \u200b\n**Auto-close**'));
  notice.embeds = [{ ...old, description: old.description.replace('Private action reason\n-# \u200b\n**Auto-close**', 'Private action reason\n**Auto-close**') }];
  await restoreReportCaseTimers(f.client);
  const restored = json(notice.embeds[0]);
  assert.ok(restored.description.includes('Private action reason\n-# \u200b\n**Auto-close**'), 'the small gap comes back');
  assert.ok(!restored.description.includes('\u200b\n-# \u200b'), 'never two small gaps');
  assert.ok(!restored.description.includes('\n\n'), 'no full empty line anywhere in the moderation notice');
  assert.ok(!restored.fields?.length, 'the notice remains in the compact description format');
});

test('an existing reporter notice without space before the thanks or Auto-close gets the small gap back, once', async () => {
  const f = fixture(); await f.register();
  const record = await f.submit();
  const entry = record.cases.reporter;
  const notice = f.channels.get(entry.channelId).messages.cache.get(entry.messageId);
  const old = json(notice.embeds[0]);
  // As a notice looked for a while: the text glued together, no gap at all.
  notice.embeds = [{ ...old, description: old.description
    .replace('server rules.\n-# \u200b\nThank you', 'server rules.\nThank you')
    .replace('fair and safe.\n-# \u200b\n**Auto-close**', 'fair and safe.\n**Auto-close**') }];
  await restoreReportCaseTimers(f.client);
  const restored = json(notice.embeds[0]);
  assert.ok(restored.description.includes('server rules.\n-# \u200b\nThank you'));
  assert.ok(restored.description.includes('fair and safe.\n-# \u200b\n**Auto-close**'));
  const before = f.payloads.length;
  await restoreReportCaseTimers(f.client);
  assert.equal(json(notice.embeds[0]).description, restored.description, 'a second start changes nothing');
  assert.equal(f.payloads.length, before, 'nothing is posted');
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
  await handleReportModeration(timeout, f.client, ['timeout', 'target', 'report']);
  assert.equal(json(timeout.error.embeds[0]).title, 'Invalid duration');
  assert.match(json(timeout.error.embeds[0]).description, /between 1 minute and 4 weeks/);
  assert.deepEqual(f.removed, [], 'invalid duration cannot perform an action');
});

test('a member without report access is refused before their timeout duration is even looked at', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.register();
  for (const typed of ['0', 'abc', '10']) {
    const outsider = f.interaction(f.target.user);
    outsider.fields.getTextInputValue = field => field === 'minutes' ? typed : 'Reason';
    const replies = [];
    outsider.editReply = async payload => { replies.push(payload); };
    outsider.reply = async payload => { replies.push(payload); };
    outsider.followUp = async payload => { replies.push(payload); };
    await handleReportModeration(outsider, f.client, ['timeout', 'target', 'report']);
    const shown = JSON.stringify(replies);
    assert.match(shown, /Only the staff team can manage reports\./, `refused for "${typed}"`);
    assert.doesNotMatch(shown, /Invalid duration/, 'form validation is never shown to someone without access');
  }
  assert.deepEqual(f.removed, []); assert.equal(f.payloads.length, 0);
});

test('a case channel removed by hand in Discord is logged as closed, never as the automatic 24-hour deletion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  // Staff delete the reported member's channel directly in Discord.
  f.channels.delete(record.cases.target.channelId);
  await restoreReportCaseTimers(f.client);
  t.mock.timers.tick(REPORT_CASE_MS); await settle(); await settle();
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  assert.ok(record.closedAt);

  const target = record.cases.target;
  assert.equal(target.deletedBy, 'Unknown');
  assert.equal(target.deleteLogId, undefined, 'no "deleted" log: that title is only for the automatic deletion');
  const closed = json(f.logs.messages.cache.get(target.closeLogId).embeds[0]);
  assert.equal(closed.title, 'Moderation update closed');
  assert.deepEqual(closed.fields.find(field => field.name === 'Closed by'), { name: 'Closed by', value: 'Unknown', inline: true });
  assert.doesNotMatch(JSON.stringify(closed), /24-hour expiry/);

  // The reporter's channel was still there: that one is the automatic deletion.
  const reporter = record.cases.reporter;
  assert.equal(reporter.deletedBy, '24-hour expiry');
  assert.ok(reporter.expiryStartedAt);
  assert.equal(json(f.logs.messages.cache.get(reporter.deleteLogId).embeds[0]).title, 'Report update deleted');
});

test('an automatic deletion interrupted by a restart is still logged as the 24-hour deletion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  const record = await f.submit();
  // Cloudy had begun the automatic deletion and removed the channel, then
  // stopped before that was saved.
  record.cases.target.expiryStartedAt = Date.now();
  await f.client.db.set(reportKey(f.guild.id, 'report'), record);
  f.channels.delete(record.cases.target.channelId);
  await deleteReportCase(f.client, f.guild, record);
  const saved = (await f.client.db.get(reportKey(f.guild.id, 'report'))).cases.target;
  assert.equal(saved.deletedBy, '24-hour expiry');
  assert.equal(json(f.logs.messages.cache.get(saved.deleteLogId).embeds[0]).title, 'Report moderation deleted');
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
    assert.equal(log.title, audience === 'reporter' ? 'Report update closed' : 'Moderation update closed');
    assert.equal(log.fields.find(field => field.name === 'Closed by').value, `<@${member.id}>`);
    assert.equal(log.footer?.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
    assert.equal(log.color, TICKET_EVENT_STYLES.close.color);
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
    assert.equal(json(deleted.embeds[0]).footer?.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
    assert.equal(json(deleted.embeds[0]).title, audience === 'reporter' ? 'Report update deleted' : 'Report moderation deleted');
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
  assert.match(noticeSection(target, 'Moderation action'), /Temporary mute/);
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
  assert.match(noticeSection(targetNotice, 'Moderation action'), /Temporary mute \(10m\)/);
  assert.equal(noticeSection(targetNotice, 'Reason'), 'Private action reason');
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
    assert.deepEqual(noticeSections(notice), audience === 'reporter'
      ? ['Reported member', 'Reported message', 'Review outcome', 'Auto-close']
      : ['Reported message', 'Review outcome', 'Auto-close']);
    assert.ok(!noticeSections(notice).some(name => name === 'Reason' || name === 'Moderation action'));
    const text = json(notice.embeds[0]).description;
    assert.ok(text.includes('No action taken\n-# \u200b\n'), 'a small gap under No action taken');
    assert.ok(!text.includes('\n\n'), 'no full empty line anywhere in the notice');
    if (audience === 'target') assert.ok(text.includes('at this time.\n-# \u200b\n**Auto-close**'), 'a small gap before Auto-close');
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
  assert.match(noticeSection(target, 'Moderation action'), /Message removed & temporary mute \(10m\)/);
  assert.equal(noticeSection(target, 'Reason'), 'Private action reason');
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
    assert.equal(entry.reportLogPresentationV4, true);
    const message = f.logs.messages.cache.get(entry.createdLogId);
    assert.equal(json(message.embeds[0]).title, audience === 'reporter'
      ? 'Report update' : 'Moderation update');
  }
  assert.equal(f.logs.messages.cache.size, messagesBefore, 'old staff logs are edited, not reposted');
  await restoreReportCaseTimers(f.client);
  assert.equal(f.logs.messages.cache.size, messagesBefore);
});

test('previously migrated report logs repair stale R103 footer without changing Report #110', async () => {
  const f = fixture(); await f.register();
  const record = await f.submit();
  record.number = 110;
  const key = reportKey(f.guild.id, record.messageId);
  for (const [audience, entry] of Object.entries(record.cases)) {
    entry.reportLogPresentationV3 = true; // previous migration incorrectly marked this complete
    const prior = f.logs.messages.cache.get(entry.createdLogId);
    const original = json(prior.embeds[0]);
    prior.embeds = [{
      ...original,
      fields: original.fields.map(field => field.name === 'Report'
        ? { ...field, value: '#110' } : field),
      footer: { text: 'Cloudy Inc. • Moderation team • R103' },
      thumbnail: undefined,
    }];
  }
  await f.client.db.set(key, record);
  const count = f.logs.messages.cache.size;
  await restoreReportCaseTimers(f.client);
  for (const [audience, entry] of Object.entries(record.cases)) {
    const embed = json(f.logs.messages.cache.get(entry.createdLogId).embeds[0]);
    assert.equal(embed.footer?.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
    assert.equal(embed.fields.find(field => field.name === 'Report')?.value, '#110');
    assert.ok(embed.thumbnail?.url, 'report staff logs have consistent Cloudy C logo');
    assert.equal(embed.color, 0xFFFFFF);
    assert.equal(embed.title, audience === 'reporter' ? 'Report update' : 'Moderation update');
  }
  const latest = await f.client.db.get(key);
  assert.ok(Object.values(latest.cases).every(entry => entry.reportLogPresentationV4));
  assert.equal(f.logs.messages.cache.size, count, 'existing log messages are edited, not duplicated');
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
  assert.equal(json(originals[0].embeds[0]).title, 'Report update');
  assert.equal(json(originals[1].embeds[0]).title, 'Moderation update');
  assert.equal(unrelated.embeds[0].title, 'Report created');
  assert.equal(f.logs.messages.cache.size, messagesBefore);
  assert.equal(await f.client.db.get('global:report-log-89-title-backfill-v2'), true);
  await restoreReportCaseTimers(f.client);
  assert.equal(f.logs.messages.cache.size, messagesBefore);
});

test('every report staff log ends with a Date section holding the exact time of its own event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const f = fixture(); await f.register();
  let record = await f.submit();
  const tag = at => `<t:${Math.floor(at / 1000)}:F>`;
  const createdAt = 1_800_000_000_000;
  for (const entry of Object.values(record.cases)) {
    const fields = json(f.logs.messages.cache.get(entry.createdLogId).embeds[0]).fields;
    assert.deepEqual(fields.at(-1), { name: 'Date', value: tag(createdAt), inline: false });
    assert.equal(entry.createdLogAt, createdAt);
  }
  t.mock.timers.tick(REPORT_CASE_MS); await settle(); await settle();
  record = await f.client.db.get(reportKey(f.guild.id, 'report'));
  for (const entry of Object.values(record.cases)) {
    const fields = json(f.logs.messages.cache.get(entry.deleteLogId).embeds[0]).fields;
    assert.deepEqual(fields.at(-1), { name: 'Date', value: tag(entry.deletedAt), inline: false });
  }
});

test('a reported photo or video is linked under Reported message in both notices, instead of "No text available."', async () => {
  const f = fixture();
  await registerReport(f.client, f.report, { guildId: f.guild.id, reporterId: f.reporter.id, targetId: f.target.id,
    sourceChannelId: f.channels.get('original')?.id || 'original', sourceMessageId: 'original-message', reportedMessageText: '',
    reportedAttachments: [{ name: 'clip.mp4', url: 'https://cloudy.test/deleted-media/abc' }, { name: 'photo.png', url: 'https://cloudy.test/cloudy-embed-media/x.png' }] });
  const record = await f.submit();
  for (const entry of Object.values(record.cases)) {
    const text = json(f.channels.get(entry.channelId).messages.cache.get(entry.messageId).embeds[0]).description;
    assert.match(text, /\*\*Reported message\*\*\n\[clip\.mp4\]\(https:\/\/cloudy\.test\/deleted-media\/abc\)\n\[photo\.png\]\(https:\/\/cloudy\.test\/cloudy-embed-media\/x\.png\)\n/);
    assert.doesNotMatch(text, /No text available/);
  }
});
