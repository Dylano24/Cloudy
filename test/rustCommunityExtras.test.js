import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Collection, PermissionsBitField, PermissionFlagsBits, ChannelType } from 'discord.js';
import {
  addRustServer, buildServerSelector,
  ensureRustCommunityForums, handleRustSelectorButton,
  loadRustCommunityConfig, publishRustSelector, resetRustCommunityCache,
  roleCanBeSelected,
} from '../src/services/rustCommunityExtrasService.js';

import { handleHoneypotMessage, loadHoneypot, setHoneypot, setHoneypotEnabled } from '../src/services/honeypotService.js';
import honeypotCommand from '../src/commands/Utility/honeypot.js';
import rustCommunityCommand from '../src/commands/GameServer/rustcommunity.js';

const guildId = '1532882647838228723';
const memberId = '714736398409924649';
const roleId = '1532882647838228724';

function setup() {
  const memory = new Map();
  const client = {
    db: {
      get: async key => memory.get(key) || null,
      set: async (key, value) => { memory.set(key, structuredClone(value)); return true; },
    },
    user: { id: '1532882647838228725' },
  };
  const me = { roles: { highest: { position: 30 } }, permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles) };
  const role = {
    id: roleId, name: 'Cloudy Rust', managed: false, position: 3, editable: true,
    permissions: new PermissionsBitField(0n),
    guild: { id: guildId },
  };
  const roles = new Map([[roleId, role]]);
  const channels = new Collection();
  const guild = {
    id: guildId, ownerId: '1532882647838228729',
    members: { me, fetchMe: async () => me },
    roles: { cache: roles, fetch: async id => roles.get(id) },
    channels: { cache: channels, fetch: async id => channels.get(id) },
  };
  return { client, guild, role, roles, channels, me, memory };
}

beforeEach(() => resetRustCommunityCache());

test('Server selector rejects privileged roles and keeps branding', async () => {
  const { client, guild, role } = setup();
  assert.equal(roleCanBeSelected(role, guild.members.me), true);
  await addRustServer(client, guild, role, 'EU 6x');
  const settings = await loadRustCommunityConfig(client, guild.id);
  assert.equal(settings.servers[0].name, 'EU 6x');
  const payload = buildServerSelector(settings, guild);
  assert.equal(payload.components.length, 1);
  assert.equal(payload.components[0].components[0].data.custom_id, 'rustcommunity:role:' + roleId);
  assert.match(payload.embeds[0].thumbnail.url, /cloudy-c-logo/);
  assert.match(payload.embeds[0].footer.text, /Cloudy Inc/);
  role.permissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
  assert.equal(roleCanBeSelected(role, guild.members.me), false);
  await assert.rejects(addRustServer(client, guild, role, 'bad'), /without staff permissions/);
});

test('Posting the selector edits its existing message rather than duplicating it', async () => {
  const { client, guild, role, channels } = setup();
  await addRustServer(client, guild, role, 'EU 6x');
  let sends = 0;
  let edits = 0;
  const posted = { id: '1532882647838228777', channelId: '1532882647838228778', edit: async () => { edits++; } };
  const channel = { id: posted.channelId, send: async () => { sends++; return posted; },
    messages: { fetch: async () => posted } };
  channels.set(channel.id, channel);
  await publishRustSelector(client, guild, channel);
  await publishRustSelector(client, guild, channel);
  assert.equal(sends, 1);
  assert.equal(edits, 1);
});

test('Server selector rejects stale panels and cannot assign a privileged role', async () => {
  const { client, guild, role } = setup();
  await addRustServer(client, guild, role, 'EU 6x');
  let assigned = 0;
  const member = { roles: { cache: new Map(), add: async () => { assigned++; }, remove: async () => {} } };
  guild.members.fetch = async () => member;
  let output;
  const interaction = {
    isButton: () => true, client, guild, guildId, channelId: '1532882647838228778',
    message: { id: '1532882647838228777' },
    user: { id: memberId }, customId: 'rustcommunity:role:' + roleId,
    deferReply: async () => {}, editReply: async result => { output = result; },
  };
  await handleRustSelectorButton(interaction);
  assert.match(output.embeds[0].title, /Unavailable/);
  assert.equal(assigned, 0);
});

test('Honeypot defaults to monitoring and never kicks staff', async () => {
  const { client, guild, channels } = setup();
  const channelId = '1532882647838228780';
  const logsId = '1532882647838228781';
  const logs = [];
  channels.set(logsId, { id: logsId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => logs.push(payload) });
  await setHoneypot(client, guildId, channelId, logsId, 'monitor');
  let kicked = 0;
  const member = { id: memberId, kickable: true, permissions: { has: () => false },
    kick: async () => { kicked++; } };
  const message = { client, guild, author: { id: memberId }, channelId, member };
  assert.equal(await handleHoneypotMessage(message), true);
  assert.equal(kicked, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].embeds[0].title, 'Honeypot alert');
  await setHoneypotEnabled(client, guild.id, false);
  assert.equal(await handleHoneypotMessage(message), false);
  assert.deepEqual(await setHoneypotEnabled(client, guild.id, true),
    { channelId, logChannelId: logsId, mode: 'monitor', enabled: true });
  await setHoneypot(client, guildId, channelId, logsId, 'kick');
  const staff = { ...message, member: { ...member, permissions: { has: () => true } } };
  assert.equal(await handleHoneypotMessage(staff), false);
  assert.equal(kicked, 0);
});

test('Community forums are not recreated if they already exist', async () => {
  const { guild, channels } = setup();
  channels.set('one', { id: 'one', name: 'suggestions', type: ChannelType.GuildForum });
  const created = [];
  guild.channels.create = async data => { created.push(data); return data; };
  const results = await ensureRustCommunityForums(guild);
  assert.deepEqual(created.map(item => item.name), ['looking-for-group']);
  assert.equal(results[1].created, false);
});

test('Honeypot is a standalone Cloudy command and reuses legacy settings after off and on', async () => {
  const { client, guild, memory } = setup();
  const channelId = '1532882647838228780';
  const logChannelId = '1532882647838228781';
  memory.set('rust-community-extras:' + guild.id, { honeypot: { channelId, logChannelId, mode: 'kick' } });
  assert.deepEqual(honeypotCommand.data.toJSON().options.map(option => option.name), ['setup', 'on', 'off', 'status']);
  assert.ok(!rustCommunityCommand.data.toJSON().options.some(option => option.name.startsWith('honeypot')));
  assert.equal((await loadHoneypot(client, guild.id)).enabled, true);

  const replies = [];
  const interaction = {
    client, guild, guildId: guild.id, inGuild: () => true, deferReply: async () => {},
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    editReply: async payload => replies.push(payload.embeds[0]),
    options: { getSubcommand: () => 'off' },
  };
  await honeypotCommand.execute(interaction);
  assert.match(replies[0].description, /Status:\*\* Off/);
  interaction.options.getSubcommand = () => 'on';
  await honeypotCommand.execute(interaction);
  assert.equal(replies[1].title, 'Honeypot');
  assert.match(replies[1].description, /Status:\*\* On/);
  assert.match(replies[1].footer.text, /Cloudy Inc/);
  assert.deepEqual(await loadHoneypot(client, guild.id), { channelId, logChannelId, mode: 'kick', enabled: true });
});
