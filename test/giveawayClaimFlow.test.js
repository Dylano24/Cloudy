import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits } from 'discord.js';
import { CLOUDY_C_LOGO_URL, createWinnerAnnouncement } from '../src/services/giveawayService.js';
import {
  CLAIM_LIFETIME_MS, CLAIM_SUCCESS_NOTICE_MS, CLAIM_DENIED_NOTICE_MS,
  GIVEAWAY_CLAIM_CATEGORY_ID, handleGiveawayClaimInteraction, cleanupExpiredGiveawayClaims,
  refreshExistingClaimPanels,
} from '../src/services/giveawayClaimService.js';

const GUILD = '156000000000000001', GIVEAWAY = '156000000000000002';
const WINNER = '156000000000000003', OWNER = '156000000000000004';
const KEY = 'guild:' + GUILD + ':giveaway-claim:records';
const CLAIM_ID = GIVEAWAY + ':' + WINNER;

function world() {
  const records = new Map([['guild:' + GUILD + ':giveaways', {
    [GIVEAWAY]: {
      messageId: GIVEAWAY, guildId: GUILD, hostId: OWNER,
      channelId: 'public', ended: true, isEnded: true, winnerIds: [WINNER],
      prize: 'Six-month subscription',
      claimPanelTitle: 'Your giveaway prize',
      claimDetails: 'The subscription is valid for six months after activation.',
      claimCodeInstructions: 'Press Take code to see your private activation code.',
      claimExpiryInstructions: 'This claim channel will close 24 hours after you reveal the code.',
    },
  }]]);
  const sent = [], created = [];
  const cache = new Collection();
  cache.set(GIVEAWAY_CLAIM_CATEGORY_ID, {
    id: GIVEAWAY_CLAIM_CATEGORY_ID, type: ChannelType.GuildCategory,
    name: 'giveaway-claims',
  });
  const guild = {
    id: GUILD, ownerId: OWNER,
    channels: {
      cache, fetch: async id => cache.get(id) || null,
      create: async options => {
        const channel = {
          id: String(156000000000000010n + BigInt(created.length)),
          guild, deleted: false,
          send: async payload => {
            const message = {
              id: String(156000000000000110n + BigInt(sent.length)),
              ...payload, deleted: false,
              delete: async () => { message.deleted = true; },
            };
            sent.push(message);
            return message;
          },
          delete: async () => { channel.deleted = true; cache.delete(channel.id); },
        };
        created.push({ options, channel });
        cache.set(channel.id, channel);
        return channel;
      },
    },
  };
  const client = {
    user: { id: 'cloudy-bot' },
    db: {
      get: async (key, fallback) => structuredClone(records.get(key) ?? fallback),
      set: async (key, value) => { records.set(key, structuredClone(value)); return true; },
    },
    guilds: { cache: new Collection([[GUILD, guild]]) },
  };
  function interaction(customId, userId = WINNER, opts = {}) {
    const item = {
      customId, guild, guildId: GUILD, user: { id: userId },
      member: { id: userId, roles: { cache: new Collection() },
        permissions: { has: () => false } },
      channelId: opts.channel?.id || 'public',
      channel: opts.channel,
      fields: { getTextInputValue: () => opts.code || '' },
      inGuild: () => true,
      isModalSubmit: () => opts.modal === true,
      deferReply: async () => { item.deferred = true; },
      editReply: async payload => { item.response = payload; },
      deleteReply: async () => { item.deletedReplies = (item.deletedReplies || 0) + 1; },
      reply: async payload => { item.response = payload; },
      showModal: async modal => { item.modal = modal.toJSON(); },
    };
    return item;
  }
  return { client, records, sent, created, interaction, cache };
}

test('winner announcement has a Claim button; no-winner and builder preview have none', () => {
  const payload = createWinnerAnnouncement({ messageId: GIVEAWAY, prize: 'Subscription' }, [WINNER]);
  const button = payload.components[0].toJSON().components[0];
  assert.equal(button.custom_id, 'gclaim:open:' + GIVEAWAY);
  assert.equal(button.label, 'Claim');
  assert.equal(button.emoji.id, '1543303758912688230');
  assert.notEqual(button.disabled, true);
  assert.equal(createWinnerAnnouncement({ messageId: GIVEAWAY }, []).components, undefined);
  assert.equal(createWinnerAnnouncement({ prize: 'Preview' }, [WINNER]).components, undefined);
});

test('only the winner opens exactly one private claim channel', async () => {
  const w = world();
  const outsider = w.interaction('gclaim:open:' + GIVEAWAY, OWNER);
  await handleGiveawayClaimInteraction(outsider, w.client);
  assert.equal(outsider.response.embeds[0].title, 'Claim denied');
  assert.equal(outsider.response.embeds[0].description,
    'This button is reserved for giveaway winners only. You are not eligible to claim this prize.');
  assert.equal(outsider.response.embeds[0].color, 0x7A1712);
  assert.deepEqual(outsider.response.embeds[0].thumbnail, { url: CLOUDY_C_LOGO_URL });
  assert.equal(w.created.length, 0);
  const open = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(open, w.client);
  assert.equal(w.created.length, 1);
  const { options, channel } = w.created[0];
  assert.equal(open.response.embeds[0].title, 'Claim successful!');
  assert.equal(open.response.embeds[0].description,
    "You've been tagged in <#" + channel.id + "> to collect your prize!");
  assert.equal(open.response.embeds[0].color, 0x00C49D);
  assert.deepEqual(open.response.embeds[0].thumbnail, { url: CLOUDY_C_LOGO_URL });
  assert.equal(options.type, ChannelType.GuildText);
  assert.equal(options.parent, GIVEAWAY_CLAIM_CATEGORY_ID);
  const everyone = options.permissionOverwrites.find(value => value.id === GUILD);
  const winner = options.permissionOverwrites.find(value => value.id === WINNER);
  assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(winner.allow.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(winner.allow.includes(PermissionFlagsBits.SendMessages));
  const claimEmbed = w.sent[0].embeds[0];
  assert.equal(claimEmbed.title, undefined);
  assert.equal(claimEmbed.color, 0xFFFFFF);
  assert.match(claimEmbed.description, /congratulates you on winning this prize/);
  const parts = ['Prize conditions', 'How to get your prize', 'Share your feedback', 'Please note'];
  let position = 0;
  for (const part of parts) {
    const index = claimEmbed.description.indexOf('**' + part + '**');
    assert.ok(index > position, part + ' must be in order');
    position = index;
  }
  assert.match(claimEmbed.description, /Details and conditions of their prize/);
  assert.match(claimEmbed.description, /Reveal my code/);
  assert.match(claimEmbed.description, /staff reviews/);
  assert.match(claimEmbed.description, /satisfied with your experience/);
  assert.match(claimEmbed.description, /\[staff reviews\]\(https:\/\/discord\.com\/channels\//);
  assert.match(claimEmbed.description, /automatically deleted after 24 hours/);
  assert.match(claimEmbed.description, /Six-month subscription/);
  assert.match(claimEmbed.description, /Six-month subscription/);
  assert.match(claimEmbed.description, /Please review the information below before collecting it/);
  assert.match(claimEmbed.description, /Cloudy Inc\./);
  assert.ok(claimEmbed.description.indexOf('Please review the information below') < claimEmbed.description.indexOf('**Prize conditions**'));
  assert.ok(claimEmbed.description.includes('\n\n\n<:W97warningwhite:'));
  assert.doesNotMatch(claimEmbed.description, /DEMO-|Your review|Congratulations on winning!/);
  assert.equal(claimEmbed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  assert.equal(claimEmbed.thumbnail, undefined);
  const claimButtons = w.sent[0].components[0].toJSON().components;
  assert.deepEqual(claimButtons.map(button => button.label), ['Reveal my code', 'Close']);
  assert.deepEqual(claimButtons.map(button => button.style), [2, 2]);
  assert.ok(Date.parse(w.records.get(KEY)[CLAIM_ID].expiresAt) >= Date.now());
  const repeat = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(repeat, w.client);
  assert.equal(w.created.length, 1);
  assert.equal(repeat.response.embeds[0].title, 'Claim successful!');
  assert.deepEqual(repeat.response.embeds[0].thumbnail, { url: CLOUDY_C_LOGO_URL });
  assert.match(repeat.response.embeds[0].description, new RegExp(channel.id));
});

test('Claim replies are private and disappear after 20 seconds for non-winners or 10 minutes for winners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world();
  const denied = w.interaction('gclaim:open:' + GIVEAWAY, OWNER);
  const accepted = w.interaction('gclaim:open:' + GIVEAWAY, WINNER);
  await handleGiveawayClaimInteraction(denied, w.client);
  await handleGiveawayClaimInteraction(accepted, w.client);
  assert.equal(CLAIM_DENIED_NOTICE_MS, 20_000);
  assert.equal(CLAIM_SUCCESS_NOTICE_MS, 600_000);
  assert.equal(denied.deferred, true);
  assert.equal(accepted.deferred, true);

  t.mock.timers.tick(CLAIM_DENIED_NOTICE_MS - 1);
  assert.equal(denied.deletedReplies, undefined);
  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(denied.deletedReplies, 1);
  assert.equal(accepted.deletedReplies, undefined);

  t.mock.timers.tick(CLAIM_SUCCESS_NOTICE_MS - CLAIM_DENIED_NOTICE_MS);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(accepted.deletedReplies, 1);
  assert.equal(w.created[0].channel.deleted, false);
});


test('Claim prevents late unclaimed winners from taking a slot after the 24-hour deadline', async () => {
  const w = world();
  w.records.get('guild:' + GUILD + ':giveaways')[GIVEAWAY].claimDeadlineAt =
    new Date(Date.now() - 1_000).toISOString();
  const late = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(late, w.client);
  assert.equal(late.response.embeds[0].title, 'Claim denied');
  assert.equal(w.created.length, 0);

  // Someone who already claimed may still revisit their existing channel.
  const already = world();
  const first = already.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(first, already.client);
  already.records.get('guild:' + GUILD + ':giveaways')[GIVEAWAY].claimDeadlineAt =
    new Date(Date.now() - 1_000).toISOString();
  const returnClick = already.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(returnClick, already.client);
  assert.equal(returnClick.response.embeds[0].title, 'Claim successful!');
  assert.equal(already.created.length, 1);
});

test('Claim refuses missing or non-category channel without creating an unprotected fallback', async () => {
  const w = world();
  w.cache.delete(GIVEAWAY_CLAIM_CATEGORY_ID);
  const missing = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(missing, w.client);
  assert.match(missing.response.content, /claim category is unavailable/);
  assert.equal(w.created.length, 0);

  w.cache.set(GIVEAWAY_CLAIM_CATEGORY_ID, {
    id: GIVEAWAY_CLAIM_CATEGORY_ID, type: ChannelType.GuildText, name: 'public-text-channel',
  });
  const wrongType = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(wrongType, w.client);
  assert.match(wrongType.response.content, /claim category is unavailable/);
  assert.equal(w.created.length, 0);
});

test('existing claim panel is edited in place on restart and Staff Set code disappears', async () => {
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  channel.parentId = 'old-category';
  let moved;
  channel.setParent = async (id, options) => { moved = { id, options }; channel.parentId = id; };
  const panel = w.sent[0];
  const originalContent = panel.content;
  panel.author = { id: 'cloudy-bot' };
  panel.components = [{ components: [
    { customId: 'gclaim:take:' + CLAIM_ID },
    { customId: 'gclaim:setup:' + CLAIM_ID },
  ] }];
  let edited = 0;
  panel.edit = async payload => {
    edited += 1;
    Object.assign(panel, payload);
    return panel;
  };
  channel.messages = {
    fetch: async arg => typeof arg === 'string'
      ? (arg === panel.id ? panel : null)
      : new Collection([[panel.id, panel]]),
  };
  const oldRecords = w.records.get(KEY);
  delete oldRecords[CLAIM_ID].panelMessageId;
  await w.client.db.set(KEY, oldRecords);
  await refreshExistingClaimPanels(w.client);

  assert.equal(edited, 1);
  assert.deepEqual(moved, { id: GIVEAWAY_CLAIM_CATEGORY_ID, options: { lockPermissions: false } });
  assert.equal(w.sent.length, 1);
  assert.equal(panel.content, originalContent);
  assert.equal(panel.embeds[0].title, undefined);
  assert.match(panel.embeds[0].description, /How to get your prize/);
  assert.equal(panel.embeds[0].color, 0xFFFFFF);
  assert.deepEqual(panel.components[0].toJSON().components.map(button => button.label), ['Reveal my code', 'Close']);
  assert.equal(w.records.get(KEY)[CLAIM_ID].panelMessageId, panel.id);
  assert.ok(w.records.get(KEY)[CLAIM_ID].expiresAt);
});

test('Close removes only the winner claim and never reopens it', async () => {
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  const denied = w.interaction('gclaim:done:' + CLAIM_ID, OWNER, { channel });
  await handleGiveawayClaimInteraction(denied, w.client);
  assert.match(denied.response.content, /Only the winner/);
  assert.equal(channel.deleted, false);
  const taken = w.interaction('gclaim:done:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(taken, w.client);
  assert.equal(channel.deleted, true);
  assert.ok(w.records.get(KEY)[CLAIM_ID].closedAt);
  assert.equal(w.records.get(KEY)[CLAIM_ID].encryptedCode, null);
  const retry = w.interaction('gclaim:done:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(retry, w.client);
  assert.match(retry.response.content, /no longer active/);
});

test('Reveal my code shows only the winner code privately and preserves expiry', async () => {
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  const expiry = w.records.get(KEY)[CLAIM_ID].expiresAt;
  const outsider = w.interaction('gclaim:reveal:' + CLAIM_ID, OWNER, { channel });
  await handleGiveawayClaimInteraction(outsider, w.client);
  assert.match(outsider.response.content, /Only the winner/);
  const winner = w.interaction('gclaim:reveal:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(winner, w.client);
  assert.match(winner.response.content, /^DEMO-[A-Z0-9-]+$/);
  assert.equal(winner.deferred, true);
  assert.equal(w.records.get(KEY)[CLAIM_ID].expiresAt, expiry);
  assert.equal(w.sent.length, 1);
});

test('Unclaimed demo channel expires after 24h even without a spoiler tap', async () => {
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const record = w.records.get(KEY)[CLAIM_ID];
  assert.ok(record.expiresAt);
  record.expiresAt = new Date(Date.now() - 3000).toISOString();
  await w.client.db.set(KEY, w.records.get(KEY));
  await cleanupExpiredGiveawayClaims(w.client);
  assert.equal(w.created[0].channel.deleted, true);
  assert.ok(w.records.get(KEY)[CLAIM_ID].closedAt);
});

test('code stays encrypted; only winner reveals; cleanup starts 24h after reveal', async t => {
  const prior = process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY;
  process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY = '7'.repeat(64);
  t.after(() => {
    if (prior === undefined) delete process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY;
    else process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY = prior;
  });
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  const noCode = w.interaction('gclaim:take:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(noCode, w.client);
  assert.match(noCode.response.content, /not ready/);
  assert.ok(Date.parse(w.records.get(KEY)[CLAIM_ID].expiresAt) > Date.now());

  const setup = w.interaction('gclaim:setup:' + CLAIM_ID, OWNER, { channel });
  await handleGiveawayClaimInteraction(setup, w.client);
  assert.equal(setup.modal.title, 'Set prize code');
  const save = w.interaction('gclaim:save:' + CLAIM_ID, OWNER, {
    channel, code: 'SUPER-SECRET-REDEEM-CODE', modal: true,
  });
  await handleGiveawayClaimInteraction(save, w.client);
  assert.match(save.response.content, /stored securely/);
  assert.ok(w.records.get(KEY)[CLAIM_ID].encryptedCode);
  assert.doesNotMatch(JSON.stringify(w.records.get(KEY)), /SUPER-SECRET-REDEEM-CODE/);
  assert.ok(Date.parse(w.records.get(KEY)[CLAIM_ID].expiresAt) > Date.now());

  const unauthorized = w.interaction('gclaim:take:' + CLAIM_ID, OWNER, { channel });
  await handleGiveawayClaimInteraction(unauthorized, w.client);
  assert.match(unauthorized.response.content, /Only the winner/);
  assert.equal(w.sent.length, 1);

  const reveal = w.interaction('gclaim:take:' + CLAIM_ID, WINNER, { channel });
  const start = Date.now();
  await handleGiveawayClaimInteraction(reveal, w.client);
  assert.match(reveal.response.content, /Code revealed/);
  assert.equal(w.sent.length, 2);
  assert.match(w.sent[1].embeds[0].description, /SUPER-SECRET-REDEEM-CODE/);
  const stored = w.records.get(KEY);
  const record = stored[CLAIM_ID];
  assert.equal(record.encryptedCode, null);
  assert.ok(Date.parse(record.expiresAt) >= start + CLAIM_LIFETIME_MS);
  assert.ok(Date.parse(record.expiresAt) <= Date.now() + CLAIM_LIFETIME_MS);
  assert.equal(channel.deleted, false);

  const again = w.interaction('gclaim:take:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(again, w.client);
  assert.match(again.response.content, /already shown/);
  assert.equal(w.sent.length, 2);

  record.expiresAt = new Date(Date.now() - 2000).toISOString();
  await w.client.db.set(KEY, stored);
  await cleanupExpiredGiveawayClaims(w.client);
  assert.equal(channel.deleted, true);
  assert.ok(w.records.get(KEY)[CLAIM_ID].closedAt);
});
