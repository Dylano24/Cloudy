import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, EmbedBuilder, OverwriteType, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { db, getTicketData, saveTicketData } from '../src/utils/database.js';
import buttons from '../src/interactions/buttons/ticket/ticketUiOverrides.js';
import { reopenTicketHandler as legacyReopenTicketHandler } from '../src/handlers/ticketButtons.js';
import modals from '../src/interactions/modals/ticket/createTicketUi.js';
import { getTicketPermissionContext } from '../src/utils/ticket/ticketPermissions.js';
import { ticketActorPermissions } from '../src/services/ticketActionPolicy.js';
import { sendTicketCreationConfirmation, deleteTicketCreationConfirmation } from '../src/services/ticketCreationConfirmationService.js';
import { reconcileTicketChannelState } from '../src/services/ticketReliabilityService.js';
import { buildReportActions, handleReportAction, handleReportModeration, timeoutDuration } from '../src/services/reportActionService.js';
import { messageLogDestination, OWNER_MOD_MESSAGE_LOG_ID, MEMBER_MESSAGE_LOG_ID, CLOUDY_GUILD_ID } from '../src/services/messageLogDestination.js';
import { logEvent, EVENT_TYPES } from '../src/services/loggingService.js';
import { setResponseLifetime } from '../src/utils/responseLifetime.js';
import { scheduleTransientInteractionReplyDeletion } from '../src/utils/transientResponse.js';
import { installInteractionMessageLifecycle } from '../src/utils/interactionMessageLifecycle.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { formatChannelName } from '../src/services/joinToCreateService.js';
import { DELETE_DELAY_MS, deleteTicketSafely } from '../src/services/ticketDeleteService.js';

let sequence = 0;
function fixture(status = 'open', actor = 'creator') {
  const guildId = `15328826478382${String(++sequence).padStart(5, '0')}`;
  const channelId = `15545386226724${String(sequence).padStart(5, '0')}`;
  const creatorId = '1534506224312389801';
  const userId = actor === 'creator' ? creatorId : actor === 'staff' ? '1534506224312389802' : '1534506224312389803';
  const values = new Map();
  const storage = { get: async key => values.get(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    delete: async key => values.delete(key), list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)) };
  db.initialized = true; db.useFallback = false; db.connectionType = 'test'; db.db = storage;
  const client = { user: { id: '1534506224312389863' }, db: { ...storage, isAvailable: () => true },
    rest: { delete: async () => {} }, users: { fetch: async id => ({ id, username: 'Creator' }) } };
  const roles = new Collection([['1534506224312389810', { id: '1534506224312389810', name: 'Staff' }]]);
  const member = { id: userId, user: { id: userId, username: actor }, permissions: new PermissionsBitField(),
    roles: { cache: new Collection(actor === 'staff' ? [...roles] : []) }, toString: () => `<@${userId}>` };
  const guild = { id: guildId, name: 'Cloudy', iconURL: () => null, ownerId: '1534506224312389800', client, roles: { cache: roles, fetch: async id => roles.get(id) },
    members: { me: {}, cache: new Collection([[userId, member]]), fetch: async id => ({ id, user: { id, username: 'Creator' } }) },
    channels: { cache: new Collection(), fetch: async id => guild.channels.cache.get(id) } };
  client.guilds = { cache: new Collection([[guildId, guild]]), fetch: async () => guild };
  const payloads = []; const permissions = [];
  const closedMessage = { id: 'closed-message', author: client.user, embeds: [new EmbedBuilder({ title: 'Ticket closed' })],
    components: [{ components: [{ customId: 'ticket_reopen' }] }], edit: async p => { payloads.push(p); } };
  const channel = { id: channelId, guild, client, name: 'ticket-1', type: ChannelType.GuildText,
    parentId: '1534506224312389812', isTextBased: () => true, isSendable: () => true,
    permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => new Collection(status === 'closed' ? [[closedMessage.id, closedMessage]] : []) },
    permissionOverwrites: { cache: new Collection(), edit: async (id, value) => permissions.push({ id, value }),
      create: async (_user, value) => permissions.push({ value }) },
    setParent: async id => { channel.parentId = id; }, setName: async () => {},
    send: async p => { payloads.push(p); return { id: `sent-${payloads.length}` }; },
    delete: async () => { channel.deleted = true; guild.channels.cache.delete(channelId); } };
  guild.channels.cache.set(channelId, channel);
  for (const id of ['1534506224312389811', '1534506224312389812']) guild.channels.cache.set(id, { id, type: ChannelType.GuildCategory });
  values.set(`guild:${guildId}:config`, { ticketStaffRoleId: roles.first().id, ticketCategoryId: '1534506224312389811',
    ticketClosedCategoryId: '1534506224312389812', ticketLogsChannelId: '1534506224312389813',
    ticketTranscriptChannelId: '1534506224312389814', logging: { enabled: true } });
  const replies = []; let deletedReplies = 0;
  const interaction = { id: `interaction-${sequence}`, guildId, channelId, guild, channel, client,
    member, user: member.user, inGuild: () => true,
    deferReply: async () => { interaction.deferred = true; }, deferUpdate: async () => { interaction.deferred = true; },
    editReply: async p => { replies.push(p); interaction.replied = true; }, reply: async p => { replies.push(p); interaction.replied = true; },
    deleteReply: async () => { deletedReplies += 1; }, showModal: async m => { replies.push(m.toJSON()); },
    fields: { getTextInputValue: () => 'Resolved' } };
  const initialize = () => saveTicketData(guildId, channelId, { id: channelId, ticketNumber: 1, userId: creatorId,
    status, createdAt: new Date().toISOString(), transcriptArchivedAt: new Date().toISOString() });
  return { client, guild, channel, member, interaction, replies, payloads, permissions, initialize,
    deletedReplies: () => deletedReplies, values };
}

test('real ticket context allows creator close but reserves reopening and management for staff', async () => {
  for (const actor of ['creator', 'staff', 'stranger']) {
    const f = fixture('closed', actor); await f.initialize();
    const p = await getTicketPermissionContext({ client: f.client, interaction: f.interaction });
    assert.equal(p.canCloseTicket, actor !== 'stranger'); assert.equal(p.canReopenTicket, actor === 'staff');
    assert.equal(p.canManageTicket, actor === 'staff');
  }
  assert.equal(ticketActorPermissions({ member: { permissions: new PermissionsBitField(PermissionFlagsBits.ManageChannels) },
    userId: 'member', ownerId: 'owner', creatorId: 'someone' }).canManageTicket, false);
});
test('staff reopens through actual handler without a private duplicate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('closed', 'staff'); await f.initialize();
  await buttons.find(b => b.name === 'ticket_reopen').execute(f.interaction, f.client);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).status, 'open');
  assert.equal(f.deletedReplies(), 1); assert.equal(f.replies.length, 0);
  assert.equal(f.payloads.filter(p => p.embeds?.some(e => (e.toJSON?.() || e).title === 'Ticket reopened')).length, 1);
  assert.ok(f.permissions.some(p => p.value.ViewChannel && p.value.SendMessages));
});
test('both current and legacy reopen buttons deny non-staff, including the ticket creator', async () => {
  for (const handlers of [buttons, [legacyReopenTicketHandler]]) {
    for (const actor of ['creator', 'stranger']) {
      const f = fixture('closed', actor); await f.initialize();
      await handlers.find(b => b.name === 'ticket_reopen').execute(f.interaction, f.client);
      assert.equal((await getTicketData(f.guild.id, f.channel.id)).status, 'closed');
      assert.equal(f.payloads.length, 0);
      assert.equal(f.permissions.length, 0);
      assert.ok(f.replies.some(p => JSON.stringify(p).includes('Only the staff team can reopen tickets.')));
    }
  }
});
test('creator cannot delete, claim or pin through actual handlers', async () => {
  for (const name of ['ticket_delete', 'ticket_claim', 'ticket_pin']) {
    const f = fixture(); await f.initialize();
    await buttons.find(b => b.name === name).execute(f.interaction, f.client);
    assert.equal((await getTicketData(f.guild.id, f.channel.id)).status, 'open');
    assert.equal(f.channel.deleted, undefined);
    assert.ok(f.replies.some(p => JSON.stringify(p).includes('Only the staff team can')));
  }
});
test('close modal requires reason and rejects whitespace before changing state', async () => {
  const f = fixture(); await f.initialize();
  await buttons.find(b => b.name === 'ticket_close').execute(f.interaction, f.client);
  assert.equal(f.replies[0].components[0].components[0].required, true);
  f.interaction.fields.getTextInputValue = () => '   ';
  await modals.find(m => m.name === 'ticket_close_modal').execute(f.interaction, f.client);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).status, 'open');
});
test('closing hides all non-staff access and deletes the public confirmation in its source channel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.initialize(); let deleted = 0;
  const source = { id: 'ticket-panel-channel', guild: f.guild,
    send: async () => ({ id: 'confirmation', channelId: 'ticket-panel-channel' }),
    messages: { fetch: async id => { assert.equal(id, 'confirmation'); return { author: f.client.user, delete: async () => { deleted += 1; } }; } } };
  f.guild.channels.cache.set(source.id, source);
  const creatorId = (await getTicketData(f.guild.id, f.channel.id)).userId;
  for (const [id, type] of [[creatorId, OverwriteType.Member], ['guest', OverwriteType.Member], ['member-role', OverwriteType.Role]]) {
    f.channel.permissionOverwrites.cache.set(id, { id, type, allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]), deny: new PermissionsBitField() });
  }
  await sendTicketCreationConfirmation(f.channel, source, { embeds: [new EmbedBuilder({ title: 'Ticket created' })] });
  await modals.find(m => m.name === 'ticket_close_modal').execute(f.interaction, f.client);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).status, 'closed'); assert.equal(deleted, 1);
  for (const id of [creatorId, 'guest', 'member-role', f.guild.id]) {
    assert.equal(f.permissions.filter(p => p.id === id).at(-1).value.ViewChannel, false);
  }
  assert.equal(f.permissions.filter(p => p.id === f.guild.roles.cache.first().id).at(-1).value.ViewChannel, true);
  assert.equal(f.permissions.filter(p => p.id === f.client.user.id).at(-1).value.ViewChannel, true);
  await reconcileTicketChannelState(f.channel);
  assert.equal(f.permissions.filter(p => p.id === creatorId).at(-1).value.ViewChannel, false);
  t.mock.timers.tick(1000);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(f.permissions.filter(p => p.id === creatorId).at(-1).value.ViewChannel, false);
  await buttons.find(b => b.name === 'ticket_reopen').execute({ ...f.interaction, member: { ...f.member, roles: { cache: f.guild.roles.cache } } }, f.client);
  assert.equal(f.permissions.filter(p => p.id === 'guest').at(-1).value.ViewChannel, true);
  assert.equal(f.permissions.filter(p => p.id === 'member-role').at(-1).value.SendMessages, true);
});
test('a staff ticket creator keeps access after closing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.initialize();
  f.guild.members.fetch = async id => ({ id, permissions: new PermissionsBitField(), roles: { cache: f.guild.roles.cache } });
  await modals.find(m => m.name === 'ticket_close_modal').execute(f.interaction, f.client);
  assert.equal((await getTicketData(f.guild.id, f.channel.id)).status, 'closed');
  assert.equal(f.permissions.filter(p => p.id === f.member.id).at(-1).value.ViewChannel, true);
});
test('saved confirmation reference supports cleanup without in-memory registration', async () => {
  const f = fixture(); await f.initialize(); let calls = 0;
  const data = await getTicketData(f.guild.id, f.channel.id);
  data.creationConfirmation = { channelId: f.channel.id, messageId: 'confirmation' };
  await saveTicketData(f.guild.id, f.channel.id, data);
  f.channel.messages.fetch = async () => ({ author: f.client.user, delete: async () => { calls += 1; } });
  assert.equal(await deleteTicketCreationConfirmation(f.channel), true);
  assert.equal(calls, 1); assert.equal((await getTicketData(f.guild.id, f.channel.id)).creationConfirmation, undefined);
});
test('ticket removal waits ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('closed', 'staff'); await f.initialize(); assert.equal(DELETE_DELAY_MS, 10_000);
  await deleteTicketSafely(f.channel, f.interaction.user);
  t.mock.timers.tick(9_999); assert.equal(f.channel.deleted, undefined);
  t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.channel.deleted, true);
});
test('Ban denies staff; modal submit rechecks revoked permission', async () => {
  const f = fixture('open', 'staff');
  f.interaction.message = { id: 'report', author: f.client.user };
  assert.deepEqual(buildReportActions('target')[0].toJSON().components.map(b => b.label), ['Delete', 'Timeout', 'Ban']);
  await handleReportAction(f.interaction, f.client, ['ban', 'target']);
  assert.ok(f.replies.some(p => JSON.stringify(p).includes('Only members with the Owner role')));
  f.member.roles.cache.clear(); await handleReportModeration(f.interaction, f.client, ['timeout', 'target', 'report']);
  assert.ok(f.replies.some(p => JSON.stringify(p).includes('Only the staff team')));
  assert.equal(timeoutDuration('30'), 1_800_000);
  for (const invalid of ['', '0', '-1', '1.5', '40321']) assert.throws(() => timeoutDuration(invalid));
});
test('report confirmation keeps two minutes even with saved Success title', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); installInteractionMessageLifecycle();
  const f = fixture(); let deleted = 0;
  const message = { id: 'report-ack', embeds: [{ title: 'Success' }], components: [], flags: 64, channel: { name: 'general' } };
  f.interaction.fetchReply = async () => message; f.interaction.webhook = { deleteMessage: async () => { deleted += 1; } };
  InteractionHelper.patchInteractionResponses(f.interaction); setResponseLifetime(f.interaction, 120_000);
  await f.interaction.editReply({ embeds: message.embeds });
  f.interaction.deleteReply = async () => { deleted += 1; };
  assert.equal(await scheduleTransientInteractionReplyDeletion(f.interaction), false);
  t.mock.timers.tick(119_999); assert.equal(deleted, 0);
  t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(deleted, 1);
});
test('message logs use supplied owner/mod and member channels; other guilds retain config', () => {
  const guild = { id: CLOUDY_GUILD_ID, ownerId: 'owner' };
  assert.equal(messageLogDestination(guild, 'owner', null), OWNER_MOD_MESSAGE_LOG_ID);
  assert.equal(messageLogDestination(guild, 'member', { permissions: new PermissionsBitField() }), MEMBER_MESSAGE_LOG_ID);
  assert.equal(messageLogDestination(guild, 'mod', { permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages) }), OWNER_MOD_MESSAGE_LOG_ID);
  assert.equal(messageLogDestination({ id: 'other' }, 'member', null), null);
});
test('report logEvent delivers three buttons in supplied reports channel', async () => {
  const f = fixture(); const sent = []; const id = '1554538663512248350';
  f.guild.channels.cache.set(id, { id, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
    send: async p => { sent.push(p); return { id: 'report' }; } });
  await logEvent({ client: f.client, guildId: f.guild.id, eventType: EVENT_TYPES.REPORT_FILE,
    data: { title: 'New report' }, components: buildReportActions('1534506224312389801') });
  assert.equal(sent.length, 1); assert.equal(sent[0].components[0].toJSON().components.length, 3);
});
test('Join to Create resolves username Room template for different members', () => {
  assert.equal(formatChannelName("{username}'s Room", { username: 'Dylano' }), "Dylano's Room");
  assert.equal(formatChannelName("{username}'s Room", { username: 'feelfate' }), "feelfate's Room");
});


test('reopening restores creator access by ID before tagging, without depending on member lookup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('closed', 'staff'); await f.initialize();
  const creatorId = '1534506224312389801';
  const fetchMember = f.guild.members.fetch;
  f.guild.members.fetch = async id => { if (id === creatorId) throw new Error('Lookup unavailable'); return fetchMember(id); };
  await buttons.find(b => b.name === 'ticket_reopen').execute(f.interaction, f.client);
  assert.ok(f.permissions.some(p => p.id === creatorId && p.value.ViewChannel === true));
  const reopened = f.payloads.find(p => p.embeds?.some(e => (e.toJSON?.() || e).title === 'Ticket reopened'));
  assert.ok(reopened);
  assert.ok(reopened.content.includes('<@' + creatorId + '>'));
});


test('Builder Save affects the next actual public reopen notice while keeping the creator ping', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture('closed', 'staff'); await f.initialize();
  const { saveEmbedTemplateDecoration } = await import('../src/services/embedTemplateService.js');
  await saveEmbedTemplateDecoration(f.guild.id, '1534506224312389813', ['Ticket reopened'], { title: 'Reopened again', description: '{dynamic} has reopened this ticket!', color: 0x00C49D, footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' } }, { applyFields: false });
  await buttons.find(b => b.name === 'ticket_reopen').execute(f.interaction, f.client);
  const notice = f.payloads.find(p => p.embeds?.some(e => (e.toJSON?.() || e).title === 'Reopened again'));
  assert.ok(notice);
  assert.match(notice.content, /<@1534506224312389801>/);
  assert.equal((notice.embeds[0].toJSON?.() || notice.embeds[0]).color, 0x00C49D);
});

test('Owner role manages tickets and routes its deleted messages as Staff', () => {
  const member = { id: 'owner-role-member', roles: { cache: new Collection([['owner-role', { name: 'Owner' }]]) }, permissions: new PermissionsBitField() };
  assert.equal(ticketActorPermissions({ member, userId: member.id, ownerId: 'different-owner' }).canReopenTicket, true);
  assert.equal(messageLogDestination({ id: CLOUDY_GUILD_ID }, member.id, member), OWNER_MOD_MESSAGE_LOG_ID);
});

