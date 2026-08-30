import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, EmbedBuilder } from 'discord.js';

import { db } from '../src/utils/database.js';
import {
  getEmbedRegistry,
  registerCloudyEmbedMessages,
} from '../src/services/embedRegistryService.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';
import {
  cacheGuildInvites,
  recordInviteCreated,
  recordInviteDeleted,
  trackMemberInvite,
} from '../src/services/inviteTrackingService.js';

const INVITE_CHANNEL_ID = '1539371572442435646';

function installTestStorage() {
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = {
    get: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    set: async (key, value) => {
      values.set(key, structuredClone(value));
      return true;
    },
    delete: async key => values.delete(key),
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
  };
  return values;
}

function inviteCreatedEmbed(title = 'Invite created') {
  return new EmbedBuilder()
    .setTitle(title)
    .addFields(
      { name: 'Created by', value: 'User' },
      { name: 'Invite', value: 'https://discord.gg/test' },
      { name: 'Channel', value: '<#1>' },
      { name: 'Maximum uses', value: 'Unlimited' },
      { name: 'Expires', value: 'Never' },
      { name: 'Created', value: 'Now' },
    );
}

function inviteJoinEmbed(title = 'Member joined using invite') {
  return new EmbedBuilder()
    .setTitle(title)
    .addFields(
      { name: 'Member', value: 'Member' },
      { name: 'Invited by', value: 'User' },
      { name: 'Invite', value: 'https://discord.gg/test' },
      { name: 'Invite uses', value: '1' },
      { name: 'Account age', value: '10 days' },
      { name: 'Account created', value: 'Earlier' },
      { name: 'Joined server', value: 'Now' },
    );
}

function buildInviteGuild(guildId, sentPayloads) {
  const logChannel = {
    id: INVITE_CHANNEL_ID,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async payload => {
      sentPayloads.push(payload);
      return {
        id: `sent-${sentPayloads.length}`,
        guildId,
        channelId: INVITE_CHANNEL_ID,
        embeds: payload.embeds.map(embed => embed?.toJSON ? embed.toJSON() : embed),
        createdAt: new Date(),
        flags: { has: () => false },
      };
    },
  };

  const membersCache = new Map();
  const guild = {
    id: guildId,
    memberCount: 25,
    channels: {
      cache: new Map([[INVITE_CHANNEL_ID, logChannel]]),
      fetch: async id => id === INVITE_CHANNEL_ID ? logChannel : null,
    },
    members: {
      me: { id: 'cloudy-bot' },
      cache: membersCache,
      fetch: async id => membersCache.get(id) || null,
    },
    client: {
      user: { id: 'cloudy-bot' },
      users: {
        cache: new Map(),
        fetch: async () => null,
      },
    },
    invites: { fetch: async () => new Collection() },
  };
  return { guild, membersCache };
}

test('invite records keep canonical template identities after title edits', async () => {
  installTestStorage();
  const guildId = '100000000000000101';
  const messages = [
    {
      id: '300000000000000101',
      guildId,
      channelId: INVITE_CHANNEL_ID,
      embeds: [inviteCreatedEmbed('Custom invite heading').toJSON()],
      createdAt: new Date(),
      flags: { has: () => false },
    },
    {
      id: '300000000000000102',
      guildId,
      channelId: INVITE_CHANNEL_ID,
      embeds: [inviteJoinEmbed('Custom join heading').toJSON()],
      createdAt: new Date(),
      flags: { has: () => false },
    },
  ];

  await registerCloudyEmbedMessages(messages, 'test');
  const records = await getEmbedRegistry(guildId);
  assert.deepEqual(new Set(records.map(item => item.name)), new Set([
    'Invite created',
    'Member joined using invite',
  ]));
});

test('new invite logs apply saved template color before send', async () => {
  installTestStorage();
  const guildId = '100000000000000102';
  const sentPayloads = [];
  const { guild } = buildInviteGuild(guildId, sentPayloads);

  const template = inviteCreatedEmbed('Invite created')
    .setColor(0x123456)
    .setFooter({ text: 'Saved invite footer' });
  await saveEmbedTemplateDecoration(
    guildId,
    INVITE_CHANNEL_ID,
    ['Invite created'],
    template.toJSON(),
  );

  const inviter = {
    id: '500000000000000102',
    tag: 'Inviter#0001',
    toString: () => '<@500000000000000102>',
    displayAvatarURL: () => 'https://example.com/avatar.png',
  };
  await recordInviteCreated({
    guild,
    code: 'saved-template',
    uses: 0,
    inviter,
    channelId: '600000000000000102',
    channel: { toString: () => '<#600000000000000102>' },
    maxUses: 0,
    maxAge: 0,
    createdTimestamp: Date.now(),
    expiresTimestamp: null,
  });

  assert.equal(sentPayloads.length, 1);
  const sent = sentPayloads[0].embeds[0].toJSON();
  assert.equal(sent.color, 0x123456);
});

test('one-use invite deletion is retained long enough to identify the joining member', async () => {
  installTestStorage();
  const guildId = '100000000000000103';
  const sentPayloads = [];
  const { guild, membersCache } = buildInviteGuild(guildId, sentPayloads);

  const inviterUser = {
    id: '500000000000000103',
    tag: 'Inviter#0002',
    toString: () => '<@500000000000000103>',
  };
  membersCache.set(inviterUser.id, { user: inviterUser });

  const oneUseInvite = {
    guild,
    code: 'one-use',
    uses: 0,
    inviter: inviterUser,
    channelId: '600000000000000103',
    maxUses: 1,
    maxAge: 0,
    temporary: false,
    createdTimestamp: Date.now() - 1000,
    expiresTimestamp: null,
  };
  guild.invites.fetch = async () => new Collection([['one-use', oneUseInvite]]);
  await cacheGuildInvites(guild);
  await recordInviteDeleted(oneUseInvite);

  guild.invites.fetch = async () => new Collection();
  const joiningUser = {
    id: '700000000000000103',
    tag: 'Joining#0001',
    createdTimestamp: Date.now() - (60 * 86_400_000),
    toString: () => '<@700000000000000103>',
    displayAvatarURL: () => 'https://example.com/joining.png',
  };
  await trackMemberInvite({
    id: joiningUser.id,
    guild,
    user: joiningUser,
  });

  assert.equal(sentPayloads.length, 1);
  const sent = sentPayloads[0].embeds[0].toJSON();
  const inviteField = sent.fields.find(field => field.name === 'Invite');
  const inviterField = sent.fields.find(field => field.name === 'Invited by');
  assert.equal(inviteField.value, 'https://discord.gg/one-use');
  assert.match(inviterField.value, /Inviter#0002/);
});
