import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { db } from '../src/utils/database.js';
import { ModerationService } from '../src/services/moderation/moderationService.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { appealReviewKey, buildAppealActions, buildAppealReasonModal, executeAppealDecision, handleAppealAction, handleAppealDecision } from '../src/services/appealActionService.js';

function fixture(action = 'Ban', scope = 'discord') {
  const record = { id: 'CLD-TEST-123456', guildId: 'appeal-test-guild', channelId: 'appeals', messageId: 'message', action, scope, status: 'pending', discordIdentity: '12345678901234567', gamertag: 'Rust player' };
  const values = new Map([[appealReviewKey(record.guildId, record.id), record], [`guild:${record.guildId}:config`, { ticketStaffRoleId: 'staff-role' }]]);
  const storage = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); return true; } };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const member = { id: 'staff', user: { id: 'staff' }, roles: { cache: new Collection([['staff-role', {}]]) }, permissions: new PermissionsBitField(0n) };
  const visitor = { id: 'visitor', roles: { cache: new Collection() }, permissions: new PermissionsBitField(0n) };
  const target = { id: record.discordIdentity };
  const message = { id: 'message', author: { id: 'bot' }, components: buildAppealActions(record).map(row => ({ components: row.toJSON().components.map(button => ({ customId: button.custom_id })) })), embeds: [{ toJSON: () => ({ title: `${scope} appeal`, fields: [] }) }], edit: async payload => { message.updated = payload; } };
  const channel = { id: 'appeals', messages: { fetch: async () => message } };
  const guild = { id: record.guildId, ownerId: 'owner', members: { fetch: async id => id === 'staff' ? member : id === 'visitor' ? visitor : target } };
  const client = { user: { id: 'bot' }, db: storage, users: { fetch: async id => ({ id }) } };
  const interaction = { client, guild, guildId: guild.id, channel, channelId: channel.id, member, message, user: member.user,
    inGuild: () => true, showModal: async modal => { interaction.modal = modal.toJSON(); }, deferReply: async () => {}, fields: { getTextInputValue: id => id === 'reason' ? 'Accepted after review' : record.discordIdentity } };
  return { record, values, member, message, guild, client, interaction };
}

test('correct action buttons and required reason modals for both appeal types', () => {
  for (const [action, scope, labels] of [['Mute', 'discord', ['Unmute', 'Deny']], ['Ban', 'discord', ['Unban', 'Deny']], ['Ban', 'rust', ['Unban', 'Deny']]]) {
    const { record } = fixture(action, scope);
    const buttons = buildAppealActions(record)[0].toJSON().components;
    assert.deepEqual(buttons.map(button => button.label), labels);
    for (const button of buttons) {
      const command = button.custom_id.split(':')[1];
      const modal = buildAppealReasonModal(record, command).toJSON();
      assert.equal(modal.components.flatMap(row => row.components).find(input => input.custom_id === 'reason').required, true);
    }
  }
});

test('real button and modal handlers reject nonstaff and forged appeal messages', async t => {
  const replies = [];
  t.mock.method(InteractionHelper, 'universalReply', async (_interaction, payload) => replies.push(payload.content));
  t.mock.method(InteractionHelper, 'safeEditReply', async (_interaction, payload) => replies.push(payload.content));
  const f = fixture();
  f.interaction.user = { id: 'visitor' };
  await handleAppealAction(f.interaction, f.client, ['unban', f.record.id]);
  assert.match(replies.pop(), /Only the staff team/);
  await handleAppealDecision(f.interaction, f.client, ['deny', f.record.id]);
  assert.match(replies.pop(), /Only the staff team/);
  assert.equal(f.values.get(appealReviewKey(f.guild.id, f.record.id)).status, 'pending');
  f.interaction.user = f.member.user;
  f.interaction.message = { id: 'forged' };
  await handleAppealAction(f.interaction, f.client, ['unban', f.record.id]);
  assert.match(replies.pop(), /unavailable/);
});

test('staff must enter reason; Discord unban/unmute actually run once and persist the decision', async t => {
  const calls = [];
  t.mock.method(ModerationService, 'unbanUser', async args => calls.push(['unban', args]));
  t.mock.method(ModerationService, 'removeTimeoutUser', async args => calls.push(['unmute', args]));
  t.mock.method(InteractionHelper, 'safeEditReply', async () => {});
  for (const [appealAction, command] of [['Ban', 'unban'], ['Mute', 'unmute']]) {
    const f = fixture(appealAction);
    await assert.rejects(executeAppealDecision({ ...f, action: command, reason: '   ', targetId: f.record.discordIdentity }), /reason/);
    const count = calls.length;
    await handleAppealDecision(f.interaction, f.client, [command, f.record.id]);
    assert.equal(calls.length, count + 1);
    assert.equal(calls.at(-1)[0], command);
    assert.equal(calls.at(-1)[1].reason, 'Accepted after review');
    const decided = f.values.get(appealReviewKey(f.guild.id, f.record.id));
    assert.equal(decided.status, 'approved');
    assert.equal(decided.moderatorId, 'staff');
    assert.equal(f.message.updated.components[0].toJSON().components.every(button => button.disabled), true);
    await handleAppealDecision(f.interaction, f.client, [command, f.record.id]);
    assert.equal(calls.length, count + 1);
  }
});

test('deny stores a mandatory reason for Discord/Rust, and wrong Discord targets cannot be acted on', async () => {
  for (const scope of ['discord', 'rust']) {
    const f = fixture('Ban', scope);
    if (scope === 'discord') await assert.rejects(executeAppealDecision({ ...f, action: 'unban', reason: 'Reason', targetId: '98765432109876543' }), /must match/);
    const denied = await executeAppealDecision({ ...f, action: 'deny', reason: 'Insufficient explanation' });
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reason, 'Insufficient explanation');
  }
});


test('Owner role opens the appeal modal before username lookup; submission resolves the actual banned account', async t => {
  const f = fixture();
  f.member.roles.cache = new Collection([['owner-role', { name: 'Owner' }]]);
  f.record.discordIdentity = 'player';
  let lookups = 0;
  f.guild.bans = { fetch: async () => { lookups++; return new Collection([['target', { user: { id: '12345678901234567', username: 'player' } }]]); } };
  const fetchMember = f.guild.members.fetch;
  f.guild.members.fetch = async value => typeof value === 'object' ? new Collection() : fetchMember(value);
  await handleAppealAction(f.interaction, f.client, ['unban', f.record.id]);
  assert.ok(f.interaction.modal);
  assert.equal(lookups, 0);
  assert.equal(f.interaction.modal.components[0].components[0].value, 'player');
  const calls = [];
  t.mock.method(ModerationService, 'unbanUser', async args => calls.push(args));
  t.mock.method(InteractionHelper, 'safeEditReply', async () => {});
  await handleAppealDecision(f.interaction, f.client, ['unban', f.record.id]);
  assert.equal(lookups, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].user.id, '12345678901234567');
  assert.equal(calls[0].reason, 'Accepted after review');
});


test('button opens the reason modal from its Discord payload; submission still refreshes staff rights', async t => {
  const f = fixture();
  let memberReads = 0, messageReads = 0;
  f.guild.members.fetch = async () => { memberReads++; return f.member; };
  f.interaction.channel.messages.fetch = async () => { messageReads++; return f.message; };
  await handleAppealAction(f.interaction, f.client, ['deny', f.record.id]);
  assert.ok(f.interaction.modal);
  assert.equal(memberReads, 0);
  assert.equal(messageReads, 0);
  f.member.roles.cache.clear();
  const responses = [];
  t.mock.method(InteractionHelper, 'safeEditReply', async (_interaction, payload) => responses.push(payload.content));
  await handleAppealDecision(f.interaction, f.client, ['deny', f.record.id]);
  assert.equal(memberReads, 1);
  assert.match(responses[0], /Only the staff team/);
  assert.equal(f.record.status, 'pending');
});

