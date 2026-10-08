import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection } from 'discord.js';
import { db } from '../src/utils/database.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { openEmbedManager } from '../src/services/embedManagerService.js';
import { deleteBuilderSessionMessage } from '../src/utils/builderSessionCleanup.js';
import embedBuilder from '../src/commands/Tools/embedbuilder.js';
import '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

const settle = async () => {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
};

function controlledPromise() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function openManager(t, guildId, beforeBackgroundPaint = async () => {}, viaCommand = false) {
  const backgroundRead = controlledPromise();
  const channels = new Collection(Array.from({ length: 67 }, (_, index) => {
    const channel = {
      id: String(index), name: `channel-${index}`, type: 0, rawPosition: index,
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: async () => assert.fail('pagination must not fetch channel history') },
    };
    return [channel.id, channel];
  }));
  const guild = { id: guildId, channels: { cache: channels }, client: { user: { id: 'cloudy' } } };
  guild.emojis = { cache: new Collection() };
  guild.roles = { everyone: { id: 'everyone' } };
  const record = {
    guildId, channelId: '0', messageId: `saved-${guildId}`, embedIndex: 0,
    source: 'embed-builder', title: 'Owner guide', name: 'Owner guide',
    snapshot: { title: 'Owner guide', description: 'Keep manual text unchanged.' },
    createdAt: '2026-10-07T00:00:00Z',
  };
  let storageReads = 0;
  db.initialized = true;
  db.useFallback = false;
  db.connectionType = 'test';
  db.db = { get: async () => ++storageReads === 1 ? [record] : backgroundRead.promise };
  const collector = new EventEmitter();
  collector.stop = reason => {
    if (collector.ended) return;
    collector.ended = true;
    collector.emit('end', [], reason);
  };
  const manager = {
    id: `manager-${guildId}`, embeds: [{ title: 'Modify embed' }],
    createMessageComponentCollector: () => collector,
  };
  let visiblePage = '';
  const navigationPaints = [];
  const paint = payload => { visiblePage = payload.embeds[0].toJSON?.().description || payload.embeds[0].description; };
  const state = {};
  const openingInteraction = {
    id: `open-${guildId}`, createdTimestamp: Date.now(), guildId,
    guild, client: guild.client, user: { id: 'owner' }, member: { id: 'owner' },
    reply: async payload => { paint(payload); return { resource: { message: manager } }; },
    webhook: {
      editMessage: async (_id, payload) => { await beforeBackgroundPaint(); paint(payload); },
      deleteMessage: async () => {},
    },
  };
  let dashboardCollector;
  if (viaCommand) {
    const preview = { id: `preview-${guildId}`, embeds: [], edit: async () => preview, delete: async () => {} };
    const dashboard = {
      id: `dashboard-${guildId}`, embeds: [{ title: 'Message builder' }],
      edit: async () => dashboard, delete: async () => {},
      createMessageComponentCollector: options => {
        dashboardCollector = new EventEmitter();
        dashboardCollector.options = options;
        dashboardCollector.stop = reason => {
          if (dashboardCollector.ended) return;
          dashboardCollector.ended = true;
          dashboardCollector.emit('end', [], reason);
        };
        return dashboardCollector;
      },
    };
    const channel = channels.get('0');
    channel.send = async () => dashboard;
    const slashInteraction = {
      ...openingInteraction, channel, options: { getString: () => null },
      reply: async payload => {
        preview.embeds = payload.embeds;
        slashInteraction.replied = true;
        return { resource: { message: preview } };
      },
      fetchReply: async () => preview, deleteReply: async () => {},
      editReply: async () => preview, followUp: async () => assert.fail('the normal Builder opens through its existing reply'),
    };
    InteractionHelper.patchInteractionResponses(slashInteraction);
    await embedBuilder.execute(slashInteraction);
    const modify = {
      ...openingInteraction, message: dashboard, customId: 'simple_embed_modify',
      isButton: () => true,
    };
    InteractionHelper.patchInteractionResponses(modify);
    assert.equal(dashboardCollector.options.filter(modify), true);
    await dashboardCollector.listeners('collect')[0](modify);
  } else {
    InteractionHelper.patchInteractionResponses(openingInteraction);
    await openEmbedManager(openingInteraction, state, async () => true);
  }
  t.after(async () => {
    dashboardCollector?.stop('test-completed');
    collector.stop('test-completed');
    backgroundRead.resolve([record]);
    await deleteBuilderSessionMessage(manager);
  });
  const click = (page, beforePaint = async () => {}) => {
    let acknowledgement = '';
    const interaction = {
      id: `click-${guildId}-${page}`, createdTimestamp: Date.now(),
      guildId, guild, user: { id: 'owner' }, member: { id: 'owner' },
      customId: `simple_embed_modify_channel_page:${page}`,
      isStringSelectMenu: () => false,
      update: async payload => {
        acknowledgement = 'update';
        await beforePaint();
        paint(payload);
        navigationPaints.push(visiblePage);
        interaction.replied = true;
      },
      deferUpdate: async () => { acknowledgement = 'deferUpdate'; interaction.deferred = true; },
      editReply: async payload => { paint(payload); navigationPaints.push(visiblePage); },
    };
    InteractionHelper.patchInteractionResponses(interaction);
    collector.emit('collect', interaction);
    return { acknowledged: () => acknowledgement };
  };
  return {
    click, page: () => visiblePage, reads: () => storageReads,
    navigationPaints: () => navigationPaints,
    close: () => collector.stop('test-closed'),
    session: () => state.activeEmbedManager,
    finishRefresh: () => backgroundRead.resolve([record]),
  };
}

test('channel pagination paints while the background storage refresh remains pending', async t => {
  const manager = await openManager(t, 'pagination-slow-storage');
  await settle();
  const readsBeforeClick = manager.reads();
  const click = manager.click(1);
  await settle();
  assert.equal(click.acknowledged(), 'update');
  assert.match(manager.page(), /\*\*Page:\*\* 2\/3/);
  assert.equal(manager.reads(), readsBeforeClick, 'a page click must use its existing session records');
});

test('the loaded Builder command and live search patch route Next directly to the manager update', async t => {
  const manager = await openManager(t, 'pagination-live-command', async () => {}, true);
  const click = manager.click(1);
  await settle();
  assert.equal(click.acknowledged(), 'update');
  assert.match(manager.page(), /\*\*Page:\*\* 2\/3/);
  assert.equal(manager.reads(), 2, 'only preload and the still-pending background refresh should read storage');
});

test('rapid Next then Previous preserves the latest page after a slow older update', async t => {
  const manager = await openManager(t, 'pagination-out-of-order');
  const firstUpdate = controlledPromise();
  const next = manager.click(1, () => firstUpdate.promise);
  await settle();
  assert.equal(next.acknowledged(), 'update');
  const previous = manager.click(0);
  await settle();
  assert.ok(previous.acknowledged(), 'the later click must acknowledge while the older update is pending');
  firstUpdate.resolve();
  await settle();
  assert.match(manager.page(), /\*\*Page:\*\* 1\/3/, 'an older in-flight update must not overwrite the latest navigation');
});

test('a slow background overview edit cannot overwrite newer page navigation', async t => {
  const backgroundUpdate = controlledPromise();
  let refreshStarted = false;
  const manager = await openManager(t, 'pagination-background-race', () => {
    refreshStarted = true;
    return backgroundUpdate.promise;
  });
  manager.finishRefresh();
  await settle();
  assert.equal(refreshStarted, true);
  const next = manager.click(1);
  await settle();
  assert.ok(next.acknowledged(), 'navigation must acknowledge while the background edit is pending');
  backgroundUpdate.resolve();
  await settle();
  assert.match(manager.page(), /\*\*Page:\*\* 2\/3/, 'an in-flight page-zero refresh must not revert the user-selected page');
});

test('rapid pagination acknowledges every click and avoids painting superseded pages', async t => {
  const manager = await openManager(t, 'pagination-burst');
  const firstUpdate = controlledPromise();
  const first = manager.click(1, () => firstUpdate.promise);
  await settle();
  const pending = [manager.click(2), manager.click(1), manager.click(0)];
  await settle();
  assert.equal(first.acknowledged(), 'update');
  assert.ok(pending.every(click => click.acknowledged()), 'all queued clicks must acknowledge before the first edit finishes');
  firstUpdate.resolve();
  await settle();
  assert.equal(manager.navigationPaints().length, 2, 'only the already-sent page and newest requested page should paint');
  assert.match(manager.page(), /\*\*Page:\*\* 1\/3/);
});

test('queued pagination does not edit a manager after its collector closes', async t => {
  const manager = await openManager(t, 'pagination-closed');
  const firstUpdate = controlledPromise();
  manager.click(1, () => firstUpdate.promise);
  await settle();
  manager.click(0);
  await settle();
  manager.close();
  firstUpdate.resolve();
  await settle();
  assert.equal(manager.navigationPaints().length, 1, 'closed sessions must discard unsent navigation');
  assert.equal(manager.session(), null);
});

test('a deleted manager stops queued pagination after the in-flight edit fails', async t => {
  const manager = await openManager(t, 'pagination-missing');
  const firstUpdate = controlledPromise();
  manager.click(1, () => firstUpdate.promise);
  await settle();
  manager.click(0);
  await settle();
  firstUpdate.reject(Object.assign(new Error('Unknown message'), { code: 10008 }));
  await settle();
  assert.equal(manager.navigationPaints().length, 0, 'an unavailable message must stop all pending edits');
  assert.equal(manager.session(), null);
});
