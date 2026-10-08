import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MessageFlags, PermissionsBitField } from 'discord.js';
import { db, getTicketData, getTicketKey, saveTicketData } from '../src/utils/database.js';
import buttons from '../src/interactions/buttons/ticket/ticketUiOverrides.js';
import layoutInteraction from '../src/events/ticketV2LayoutInteraction.js';
import layoutMessageCreate from '../src/events/ticketV2LayoutMessageCreate.js';
import { renderTicketV2 } from '../src/services/ticketV2LayoutService.js';
import { primeSystemEmbedTemplateData } from '../src/services/systemEmbedCatalogService.js';

let sequence = 0;
const flush = () => new Promise(resolve => { setImmediate(resolve); });

function fixture(t, { holdFirstWrite = false, holdFirstEdit = false } = {}) {
  const guildId = `16328826478384${String(++sequence).padStart(5, '0')}`;
  const channelId = `16545386226725${String(sequence).padStart(5, '0')}`;
  const creatorId = '1634506224312389802';
  const actorId = '1634506224312389801';
  const staffRoleId = '1634506224312389810';
  const ticketKey = getTicketKey(guildId, channelId);
  const values = new Map([[ticketKey, {
    id: channelId, userId: creatorId, status: 'open', ticketNumber: 1,
    ticketMessageId: 'main-ticket', reason: 'Owner reason', claimedBy: null,
  }], [`guild:${guildId}:config`, { ticketStaffRoleId: staffRoleId, logging: { enabled: false } }]]);
  let releaseWrite, releaseFetch, releaseEdit, writes = 0, fetches = 0, acknowledgements = 0;
  const paints = [], statuses = [], replies = [];
  const storage = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => {
      if (key === ticketKey && ++writes === 1 && holdFirstWrite) {
        await new Promise(resolve => { releaseWrite = resolve; });
      }
      values.set(key, structuredClone(value));
      return true;
    },
  };
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = storage;
  const client = { user: { id: 'bot' }, db: { ...storage, isAvailable: () => true } };
  const role = { id: staffRoleId, name: 'Staff' };
  const member = {
    id: actorId, user: { id: actorId, username: 'Staff' }, permissions: new PermissionsBitField(),
    roles: { cache: new Collection([[staffRoleId, role]]) },
  };
  const guild = {
    id: guildId, client, ownerId: 'owner', roles: { cache: new Collection([[staffRoleId, role]]) },
    channels: { cache: new Collection() },
  };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  const main = {
    id: 'main-ticket', author: client.user, editable: true, flags: { has: () => false },
    embeds: [{ title: 'Ticket #1' }], components: [],
    edit: async payload => {
      if (!releaseEdit && holdFirstEdit) await new Promise(resolve => { releaseEdit = resolve; });
      paints.push(JSON.parse(JSON.stringify(payload)));
      main.embeds = payload.embeds;
      main.components = payload.components;
      return main;
    },
  };
  const channel = {
    id: channelId, guild, client, name: 'ticket-1',
    messages: {
      fetch: async id => {
        assert.equal(id, 'main-ticket', 'known main messages must not require a history scan');
        fetches += 1;
        if (!releaseFetch) await new Promise(resolve => { releaseFetch = resolve; });
        return main;
      },
    },
    send: async payload => {
      statuses.push(JSON.parse(JSON.stringify(payload)));
      return { id: `status-${statuses.length}` };
    },
  };
  guild.channels.cache.set(channelId, channel);
  const interaction = customId => {
    const click = {
      id: `${customId}-${sequence}-${acknowledgements}`, guildId, channelId, guild, channel, client,
      customId, member, user: member.user, message: main,
      deferUpdate: async () => { acknowledgements += 1; click.deferred = true; },
      deferReply: async () => assert.fail('ticket controls must acknowledge without a thinking reply'),
      editReply: async () => assert.fail('ticket controls must preserve their public source'),
      deleteReply: async () => assert.fail('ticket controls must preserve their public source'),
      followUp: async payload => { replies.push(payload); return { id: 'private-error' }; },
    };
    return click;
  };
  t.after(() => { releaseWrite?.(); releaseFetch?.(); releaseEdit?.(); });
  return {
    guild, channel, client, main, interaction, paints, statuses, replies, creatorId,
    acknowledgements: () => acknowledgements, fetches: () => fetches,
    writeStarted: () => typeof releaseWrite === 'function', fetchStarted: () => typeof releaseFetch === 'function',
    editStarted: () => typeof releaseEdit === 'function',
    finishWrite: () => releaseWrite?.(), finishFetch: () => releaseFetch?.(),
    finishEdit: () => releaseEdit?.(),
    data: () => getTicketData(guildId, channelId),
  };
}

test('loaded claim event bursts cannot delay a later unclaim behind main-message presentation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { holdFirstWrite: true });
  const template = {
    title: 'Ticket #{dynamic}', description: 'Saved  text\n\n{dynamic}\nReason: {dynamic}',
    color: 0x432112, footer: { text: 'Manual footer' },
  };
  primeSystemEmbedTemplateData('ticket-main', 'tickets/main', template, f.guild.id);
  const claim = buttons.find(button => button.name === 'ticket_claim');
  const actions = [];
  for (let i = 0; i < 8; i += 1) {
    const click = f.interaction('ticket_claim');
    actions.push(claim.execute(click, f.client));
    await layoutInteraction.execute(click);
  }
  await flush();
  assert.equal(f.acknowledgements(), 8);
  assert.equal(f.writeStarted(), true);
  assert.equal(f.statuses.length, 0, 'a successful status must wait for durable persistence');
  t.mock.timers.tick(700);
  await flush();
  assert.equal(f.fetchStarted(), true);
  f.finishWrite();
  await flush();
  const unclaimClick = f.interaction('ticket_unclaim');
  actions.push(buttons.find(button => button.name === 'ticket_unclaim').execute(unclaimClick, f.client));
  await layoutInteraction.execute(unclaimClick);
  t.mock.timers.tick(700);
  await flush();
  assert.equal(f.acknowledgements(), 9);
  assert.deepEqual(f.statuses.map(payload => payload.embeds[0].title), ['Ticket claimed', 'Ticket unclaimed'],
    'the later durable mutation and status must complete while the older main fetch is still pending');
  assert.equal((await f.data()).claimedBy, null);
  f.finishFetch();
  await Promise.all(actions);
  await flush();
  assert.ok(f.fetches() <= 2, 'duplicate layout events should coalesce into the pending fetch and latest refresh');
  assert.ok(f.paints.length > 0 && f.paints.length <= 2);
  const final = f.paints.at(-1);
  assert.deepEqual(final.components[0].components.map(button => button.custom_id), ['ticket_claim', 'ticket_pin', 'ticket_close']);
  assert.deepEqual(final.embeds[0], {
    title: 'Ticket #1', description: `Saved  text\n\n<@${f.creatorId}>\nReason: Owner reason`,
    color: 0x432112, footer: { text: 'Manual footer' },
  });
  assert.equal(f.replies.length, 0);
});

test('an in-flight main fetch paints the latest closed state without reviving open controls', async t => {
  const f = fixture(t);
  const render = renderTicketV2(f.channel);
  await flush();
  assert.equal(f.fetchStarted(), true);
  const ticket = await f.data();
  ticket.status = 'closed';
  await saveTicketData(f.guild.id, f.channel.id, ticket);
  f.finishFetch();
  await render;
  assert.equal(f.paints.length, 1);
  assert.deepEqual(f.paints[0].components, []);
});

test('an unclaim during an in-flight main edit finishes with one ordered fresh-state repaint', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { holdFirstEdit: true });
  const claimClick = f.interaction('ticket_claim');
  await buttons.find(button => button.name === 'ticket_claim').execute(claimClick, f.client);
  await layoutInteraction.execute(claimClick);
  await flush();
  assert.equal(f.fetchStarted(), true);
  f.finishFetch();
  await flush();
  assert.equal(f.editStarted(), true);
  assert.equal(f.paints.length, 0);
  const unclaimClick = f.interaction('ticket_unclaim');
  await buttons.find(button => button.name === 'ticket_unclaim').execute(unclaimClick, f.client);
  await layoutInteraction.execute(unclaimClick);
  t.mock.timers.tick(700);
  await flush();
  assert.equal(f.acknowledgements(), 2);
  assert.deepEqual(f.statuses.map(payload => payload.embeds[0].title), ['Ticket claimed', 'Ticket unclaimed']);
  assert.equal((await f.data()).claimedBy, null);
  f.finishEdit();
  await flush();
  assert.equal(f.fetches(), 2);
  assert.equal(f.paints.length, 2, 'updates arriving after the fresh read need one ordered repaint');
  assert.deepEqual(f.paints.at(-1).components[0].components.map(button => button.custom_id), ['ticket_claim', 'ticket_pin', 'ticket_close']);
});

test('an in-flight main fetch does not paint a deleting or deleted ticket', async t => {
  for (const state of [{ deletionScheduledAt: '2026-10-08T12:00:00.000Z' }, { status: 'deleted' }]) {
    const f = fixture(t);
    const render = renderTicketV2(f.channel);
    await flush();
    assert.equal(f.fetchStarted(), true);
    const ticket = await f.data();
    Object.assign(ticket, state);
    await saveTicketData(f.guild.id, f.channel.id, ticket);
    f.finishFetch();
    await render;
    assert.equal(f.paints.length, 0, 'archival and deletion must not be followed by an old open-ticket edit');
  }
});

test('a V2 replacement message event cannot reuse the deleted preferred main message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  f.client.user.bot = true;
  f.main.flags = { has: flag => flag === MessageFlags.IsComponentsV2 };
  const messages = new Map([[f.main.id, f.main]]);
  const deleted = [], painted = [];
  let releaseReplacement, replacements = 0;
  f.main.delete = async () => { deleted.push(f.main.id); };
  f.channel.messages.fetch = async id => {
    assert.ok(messages.has(id), 'a rerender must resolve the current stored main-message identity');
    return messages.get(id);
  };
  f.channel.send = async payload => {
    const replacement = {
      id: `replacement-${++replacements}`, guild: f.guild, channel: f.channel, author: f.client.user,
      editable: true, flags: { has: () => false },
      embeds: JSON.parse(JSON.stringify(payload.embeds)), components: payload.components,
      edit: async next => { painted.push({ id: replacement.id, payload: JSON.parse(JSON.stringify(next)) }); return replacement; },
    };
    messages.set(replacement.id, replacement);
    await layoutMessageCreate.execute(replacement);
    if (replacements === 1) await new Promise(resolve => { releaseReplacement = resolve; });
    return replacement;
  };
  t.after(() => releaseReplacement?.());
  const render = renderTicketV2(f.channel, f.main);
  await flush();
  assert.equal(typeof releaseReplacement, 'function');
  t.mock.timers.tick(250);
  await flush();
  releaseReplacement();
  await render;
  await flush();
  assert.equal(replacements, 1, 'the replacement event must not create another main ticket message');
  assert.equal((await f.data()).ticketMessageId, 'replacement-1');
  assert.deepEqual(deleted, ['main-ticket']);
  assert.equal(painted.at(-1)?.id, 'replacement-1');
  assert.deepEqual(painted.at(-1).payload.components[0].components.map(button => button.custom_id), ['ticket_claim', 'ticket_pin', 'ticket_close']);
});
