import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandType, ChannelType } from 'discord.js';

import reportCommand, { reportEvidence } from '../src/commands/Utility/reportMessage.js';
import { isPlayerCommand } from '../src/config/playerCommands.js';
import { isOwnerAssistantRequest } from '../src/events/cloudyOwnerAssistantMessageCreate.js';
import { readAiGuildContext } from '../src/services/explicitAiService.js';
import { authorizeAiRequest } from '../src/services/aiSafety.js';
import { createTicket } from '../src/services/ticket.js';
import { db } from '../src/utils/database.js';

test('Cloudy report is a member-visible message context command with message evidence', () => {
  const payload = reportCommand.data.toJSON();
  assert.equal(payload.name, 'Cloudy report');
  assert.equal(payload.type, ApplicationCommandType.Message);
  assert.equal(reportCommand.adminOnly, false);
  assert.equal(isPlayerCommand('Cloudy report'), true);

  const evidence = reportEvidence({
    url: 'https://discord.com/channels/1/2/3',
    channel: { toString: () => '<#2>' },
    content: 'This is the reported message.',
    attachments: new Map([
      ['a', { url: 'https://cdn.discordapp.com/a.png' }],
      ['b', { url: 'https://cdn.discordapp.com/b.png' }],
    ]),
  });

  assert.match(evidence, /Open reported message/);
  assert.match(evidence, /<#2>/);
  assert.match(evidence, /This is the reported message/);
  assert.match(evidence, /Attachment 1: https:\/\/cdn\.discordapp\.com\/a\.png/);
  assert.match(evidence, /Attachment 2: https:\/\/cdn\.discordapp\.com\/b\.png/);
});

test('Cloudy Assistant owner trigger is accepted in an ordinary channel', () => {
  const message = {
    guild: { id: 'assistant-guild' },
    channel: { id: 'general-channel', name: 'general' },
    author: { id: 'owner-user', bot: false },
    webhookId: null,
    content: '!ai what happened in the server?',
    member: {
      roles: {
        cache: {
          some: predicate => predicate({ name: 'Owner' }),
        },
      },
    },
  };

  assert.equal(isOwnerAssistantRequest(message), true);
  message.member.roles.cache.some = () => false;
  assert.equal(isOwnerAssistantRequest(message), false);
});

test('Owner-role message requests can scan every readable text channel, including beyond the old 50-channel cap', async () => {
  const ownerMember = {
    id: 'owner-user',
    permissions: { has: () => false },
  };
  const botMember = { id: 'cloudy-bot' };
  const channels = new Map();

  for (let index = 0; index < 61; index += 1) {
    const id = `channel-${index}`;
    channels.set(id, {
      id,
      guildId: 'assistant-guild',
      name: `channel-${index}`,
      rawPosition: index,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
      messages: {
        fetch: async () => new Map([[
          `message-${index}`,
          {
            id: `message-${index}`,
            content: `needle evidence from channel ${index}`,
            embeds: [],
            createdTimestamp: index + 1,
          },
        ]]),
      },
    });
  }

  const guild = {
    id: 'assistant-guild',
    ownerId: 'different-user',
    channels: {
      cache: channels,
      fetch: async () => channels,
    },
    members: {
      fetchMe: async () => botMember,
      fetch: async () => ownerMember,
    },
  };
  const actor = {
    guild,
    author: { id: 'owner-user', bot: false },
    member: {
      roles: {
        cache: {
          some: predicate => predicate({ name: 'Owner' }),
        },
      },
    },
  };

  const authorized = await authorizeAiRequest(
    actor,
    { action: 'server', question: 'needle' },
    { allowMessageServerContext: true },
  );
  assert.equal(authorized, ownerMember);

  const result = await readAiGuildContext(actor, { action: 'server', question: 'needle' }, ownerMember);
  assert.equal(result.channels, 61);
  assert.equal(result.count, 60);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.channelsScanned, 61);
});

test('new tickets tag only staff and creator and do not auto-pin the main ticket message', async t => {
  const oldInitialized = db.initialized;
  const oldUseFallback = db.useFallback;
  const oldDb = db.db;
  const values = new Map();
  db.initialized = true;
  db.useFallback = false;
  db.db = {
    get: async (key, fallback = null) => values.has(key) ? values.get(key) : fallback,
    set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    list: async prefix => [...values.keys()].filter(key => key.startsWith(prefix)),
    isAvailable: () => false,
  };
  t.after(() => {
    db.initialized = oldInitialized;
    db.useFallback = oldUseFallback;
    db.db = oldDb;
  });

  let pinCalls = 0;
  const sent = [];
  const category = { id: 'ticket-category', name: 'Tickets', type: ChannelType.GuildCategory };
  const ticketMessage = {
    id: 'ticket-main-message',
    pin: async () => { pinCalls += 1; },
  };
  const ticketChannel = {
    id: 'ticket-channel',
    name: 'ticket-1',
    type: ChannelType.GuildText,
    send: async payload => {
      sent.push(payload);
      return payload.embeds ? ticketMessage : { id: 'ticket-mention-message' };
    },
  };

  const clientStorage = new Map();
  const client = {
    db: {
      get: async (key, fallback = null) => clientStorage.has(key) ? clientStorage.get(key) : fallback,
      set: async (key, value) => { clientStorage.set(key, structuredClone(value)); return true; },
      isAvailable: () => false,
    },
    guilds: {
      cache: new Map(),
      fetch: async () => null,
    },
  };
  const guild = {
    id: 'ticket-guild',
    client,
    channels: {
      cache: new Map([[category.id, category]]),
      create: async options => {
        assert.equal(options.parent, category.id);
        return ticketChannel;
      },
    },
    members: { me: { id: 'cloudy-bot' } },
  };
  client.guilds.cache.set(guild.id, guild);
  ticketChannel.guild = guild;

  const member = {
    id: 'ticket-user',
    toString: () => '<@ticket-user>',
  };

  const result = await createTicket(
    guild,
    member,
    category.id,
    'Need help',
    'none',
    {
      skipLimitCheck: true,
      config: {
        maxTicketsPerUser: 3,
        ticketStaffRoleId: 'staff-role',
        tickets: {},
      },
    },
  );

  assert.equal(result.ticketMessage, ticketMessage);
  assert.equal(pinCalls, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].content, '<@&staff-role> <@ticket-user>');
  assert.deepEqual(sent[0].allowedMentions, {
    parse: [],
    roles: ['staff-role'],
    users: ['ticket-user'],
  });
  const componentIds = sent[1].components[0].components.map(component => component.data.custom_id);
  assert.ok(componentIds.includes('ticket_pin'), 'manual Pin button must stay available');
});
