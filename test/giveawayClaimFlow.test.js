import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, PermissionFlagsBits } from 'discord.js';
import { CLOUDY_C_LOGO_URL, createWinnerAnnouncement } from '../src/services/giveawayService.js';
import { GIVEAWAY_CLAIM_LOG_CHANNEL_ID, GIVEAWAY_CLAIM_LOG_FOOTER, buildGiveawayClaimLog, removeExistingClaimLogTimestamps, refreshExistingGiveawayClaimLogPresentation, refreshClosedGiveawayClaimLogChannels, updateClosedClaimChannelLogs, refreshClosedClaimReferencesInEarlierLogs, replaceClosedClaimChannelMentions, removeRedundantGiveawayClaimLogs } from '../src/services/giveawayClaimLogService.js';
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
      channelId: '156000000000000087', ended: true, isEnded: true, winnerIds: [WINNER],
      prize: 'Six-month subscription',
      claimPanelTitle: 'Your giveaway prize',
      claimDetails: 'The subscription is valid for six months after activation.',
      claimCodeInstructions: 'Press Take code to see your private activation code.',
      claimExpiryInstructions: 'This claim channel will close 24 hours after you reveal the code.',
    },
  }]]);
  const sent = [], created = [], logs = [];
  const cache = new Collection();
  cache.set(GIVEAWAY_CLAIM_LOG_CHANNEL_ID, {
    id: GIVEAWAY_CLAIM_LOG_CHANNEL_ID,
    send: async payload => {
      logs.push(payload);
      return { id: 'audit-' + logs.length };
    },
  });
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
  return { client, records, sent, created, logs, interaction, cache };
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

test('Close also deletes every pending Claim successful notice immediately', async () => {
  const w = world();
  const first = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(first, w.client);
  const repeated = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(repeated, w.client);
  const channel = w.created[0].channel;
  assert.equal(first.deletedReplies, undefined);
  assert.equal(repeated.deletedReplies, undefined);
  const done = w.interaction('gclaim:done:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(done, w.client);
  assert.equal(channel.deleted, true);
  assert.equal(first.deletedReplies, 1);
  assert.equal(repeated.deletedReplies, 1);
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

async function flushClaimLogs() {
  // The audit send is deliberately asynchronous and never delays the button.
  await new Promise(resolve => setImmediate(resolve));
}

test('only first successful Claim is logged; denied and repeated Claim clicks keep their replies but create no extra logs', async () => {
  const w = world();
  const denied = w.interaction('gclaim:open:' + GIVEAWAY, OWNER);
  await handleGiveawayClaimInteraction(denied, w.client);
  const first = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(first, w.client);
  const second = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(second, w.client);
  await flushClaimLogs();

  assert.deepEqual(w.logs.map(log => log.embeds[0].title), ['Giveaway claim opened']);
  assert.equal(denied.response.embeds[0].title, 'Claim denied');
  assert.equal(second.response.embeds[0].title, 'Claim successful!');
  for (const entry of w.logs) {
    assert.deepEqual(entry.allowedMentions, { parse: [] });
    assert.deepEqual(entry.embeds[0].thumbnail, { url: CLOUDY_C_LOGO_URL });
    assert.match(entry.embeds[0].footer.text, /Cloudy Inc/);
    assert.equal(entry.embeds[0].timestamp, undefined);
    assert.match(JSON.stringify(entry.embeds[0]), /Six-month subscription/);
    assert.match(JSON.stringify(entry.embeds[0]), new RegExp(GIVEAWAY));
  }
  const opened = JSON.stringify(w.logs[0]);
  assert.match(opened, new RegExp(WINNER));
  assert.match(opened, new RegExp(w.created[0].channel.id));
  assert.equal(w.created.length, 1, 'revisiting does not create an additional channel');
  assert.equal(w.logs[0].embeds[0].color, 0x00C49D);
});

test('Reveal my code logs successful reveal but NEVER logs demo or encrypted prize codes', async t => {
  const prior = process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY;
  process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY = '9'.repeat(64);
  t.after(() => {
    if (prior === undefined) delete process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY;
    else process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY = prior;
  });
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;

  // Unauthorized reveal is not a successful reveal.
  await handleGiveawayClaimInteraction(w.interaction('gclaim:reveal:' + CLAIM_ID, OWNER, { channel }), w.client);
  const allowed = w.interaction('gclaim:reveal:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(allowed, w.client);
  assert.match(allowed.response.content, /^DEMO-/);
  await flushClaimLogs();
  assert.equal(w.logs.filter(entry => entry.embeds[0].title === 'Giveaway code revealed').length, 1);
  assert.doesNotMatch(JSON.stringify(w.logs), /DEMO-[A-Z0-9-]+/);

  const save = w.interaction('gclaim:save:' + CLAIM_ID, OWNER, {
    channel, code: 'ULTRA-PRIVATE-WINNER-CODE', modal: true,
  });
  await handleGiveawayClaimInteraction(save, w.client);
  const configured = w.interaction('gclaim:reveal:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(configured, w.client);
  assert.equal(configured.response.content, 'ULTRA-PRIVATE-WINNER-CODE');
  await flushClaimLogs();
  assert.equal(w.logs.filter(entry => entry.embeds[0].title === 'Giveaway code revealed').length, 2);
  assert.doesNotMatch(JSON.stringify(w.logs), /ULTRA-PRIVATE-WINNER-CODE/);
  assert.doesNotMatch(JSON.stringify(w.logs), /encryptedCode|ciphertext|body|DEMO-/i);
});

test('Close writes exactly one manual-close log after deleting the private claim channel', async () => {
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  const denied = w.interaction('gclaim:done:' + CLAIM_ID, OWNER, { channel });
  await handleGiveawayClaimInteraction(denied, w.client);
  await flushClaimLogs();
  assert.equal(w.logs.filter(entry => entry.embeds[0].title === 'Giveaway claim closed').length, 0);

  const close = w.interaction('gclaim:done:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(close, w.client);
  await flushClaimLogs();
  assert.equal(channel.deleted, true);
  const end = w.logs.filter(entry => entry.embeds[0].title === 'Giveaway claim closed');
  assert.equal(end.length, 1);
  assert.match(JSON.stringify(end[0]), new RegExp(channel.id));
  assert.equal(end[0].embeds[0].title, 'Giveaway claim closed');
  assert.equal(end[0].embeds[0].fields.some(field => field.name === 'Action'), false);
  await handleGiveawayClaimInteraction(w.interaction('gclaim:done:' + CLAIM_ID, WINNER, { channel }), w.client);
  await flushClaimLogs();
  assert.equal(w.logs.filter(entry => entry.embeds[0].title === 'Giveaway claim closed').length, 1);
});

test('24-hour automatic channel expiry sends the separate expiration log only once', async () => {
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  const record = w.records.get(KEY)[CLAIM_ID];
  record.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await w.client.db.set(KEY, w.records.get(KEY));
  await cleanupExpiredGiveawayClaims(w.client);
  await flushClaimLogs();
  assert.equal(channel.deleted, true);
  const expired = w.logs.filter(entry => entry.embeds[0].title === 'Giveaway auto expiry');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].embeds[0].fields.some(field => field.name === 'Action'), false);
  assert.equal(expired[0].embeds[0].color, 0x7A1712);
  assert.match(JSON.stringify(expired[0]), new RegExp(channel.id));
  await cleanupExpiredGiveawayClaims(w.client);
  await flushClaimLogs();
  assert.equal(w.logs.filter(entry => entry.embeds[0].title === 'Giveaway auto expiry').length, 1);
});

test('log channel send failure never prevents Claim, Reveal or Close', async () => {
  const w = world();
  w.cache.get(GIVEAWAY_CLAIM_LOG_CHANNEL_ID).send = async () => {
    throw new Error('Audit log channel unavailable');
  };
  const start = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(start, w.client);
  const channel = w.created[0].channel;
  const reveal = w.interaction('gclaim:reveal:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(reveal, w.client);
  const close = w.interaction('gclaim:done:' + CLAIM_ID, WINNER, { channel });
  await handleGiveawayClaimInteraction(close, w.client);
  await flushClaimLogs();
  assert.equal(start.response.embeds[0].title, 'Claim successful!');
  assert.match(reveal.response.content, /^DEMO-/);
  assert.equal(channel.deleted, true);
});

test('audit embed builder contains only safe metadata and never mentions users', () => {
  const entry = buildGiveawayClaimLog({
    event: 'revealed', guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
    claimChannelId: '156000000000000123',
    giveaway: { prize: 'Top prize', channelId: '156000000000000087' },
  });
  assert.deepEqual(entry.allowedMentions, { parse: [] });
  assert.equal(entry.embeds[0].title, 'Giveaway code revealed');
  assert.equal(entry.embeds[0].fields.find(field => field.name === 'Prize').value, 'Top prize');
  assert.match(entry.embeds[0].fields.find(field => field.name === 'Giveaway').value,
    /discord\.com\/channels\//);
  assert.equal(entry.embeds[0].thumbnail.url, CLOUDY_C_LOGO_URL);
});

test('old giveaway log timestamps are removed in place without changing any other embed content', async () => {
  const w = world();
  const base = buildGiveawayClaimLog({
    event: 'opened', guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
    giveaway: { prize: 'Six-month subscription' },
  }).embeds[0];
  const dated = { ...base, timestamp: '2026-11-03T18:36:00.000Z' };
  const original = {
    author: { id: w.client.user.id },
    embeds: [{ toJSON: () => structuredClone(dated) }],
    edited: [],
    edit: async function (data) { this.edited.push(data); this.embeds = data.embeds; },
  };
  const unrelated = {
    author: { id: w.client.user.id },
    embeds: [{ title: 'Other log', footer: { text: GIVEAWAY_CLAIM_LOG_FOOTER },
      timestamp: '2026-11-03T18:36:00.000Z' }],
    edit: async () => { throw new Error('Unrelated log was edited'); },
  };
  const otherAuthor = {
    author: { id: 'someone-else' }, embeds: [dated],
    edit: async () => { throw new Error('Other user message was edited'); },
  };
  w.cache.set(GIVEAWAY_CLAIM_LOG_CHANNEL_ID, {
    id: GIVEAWAY_CLAIM_LOG_CHANNEL_ID,
    messages: { fetch: async () => new Collection([
      ['1', original], ['2', unrelated], ['3', otherAuthor],
    ]) },
  });
  await removeExistingClaimLogTimestamps(w.client);
  assert.equal(original.edited.length, 1);
  assert.equal(original.embeds[0].timestamp, undefined);
  assert.deepEqual(original.embeds[0], base);
  assert.equal(original.embeds[0].footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
  await removeExistingClaimLogTimestamps(w.client);
  assert.equal(original.edited.length, 1);
});

test('claim logs hide raw IDs and manual close uses the ticket orange side line', () => {
  const metadata = {
    guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
    claimChannelId: '156000000000000123',
    giveaway: { prize: 'Prize', channelId: '156000000000000087' },
  };
  for (const event of ['opened', 'revealed', 'closed', 'expired']) {
    const embed = buildGiveawayClaimLog({ event, ...metadata }).embeds[0];
    const member = embed.fields.find(field => field.name === 'Member');
    const channel = embed.fields.find(field => field.name === 'Private channel');
    assert.equal(member.value, '<@' + WINNER + '>');
    assert.equal(channel.value, ['closed', 'expired'].includes(event)
      ? '`156000000000000123`' : '<#156000000000000123>');
    assert.equal(embed.footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
    assert.equal(embed.timestamp, undefined);
    assert.equal(embed.thumbnail.url, CLOUDY_C_LOGO_URL);
    assert.equal(embed.fields.some(field => field.name === 'Action'), false);
    if (event === 'closed') assert.equal(embed.color, 0xFF7A00);
    if (event === 'revealed') assert.equal(embed.color, 0xFFFFFF);
  }
});

test('existing giveaway claim logs remove ID suffixes and recolor Close without altering other content', async () => {
  const w = world();
  const originalChannel = '156000000000000123';
  function oldLog(event) {
    const embed = buildGiveawayClaimLog({
      event, guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
      claimChannelId: originalChannel, giveawayNumber: 1,
      giveaway: { prize: 'Prize', channelId: '156000000000000087' },
    }).embeds[0];
    return {
      ...embed,
      color: event === 'closed' ? 0xFFFFFF : embed.color,
      fields: embed.fields.map(field => {
        if (field.name === 'Member') return { ...field, value: field.value + ' (\x60' + WINNER + '\x60)' };
        if (field.name === 'Private channel') return { ...field, value: '<#' + originalChannel + '> (\x60' + originalChannel + '\x60)' };
        return field;
      }),
    };
  }
  function originalMessage(embed, authorId = w.client.user.id) {
    return {
      author: { id: authorId },
      embeds: [{ toJSON: () => structuredClone(embed) }],
      edits: [],
      edit: async function(payload) { this.edits.push(payload); this.embeds = payload.embeds; },
    };
  }
  const opened = originalMessage(oldLog('opened'));
  const closed = originalMessage(oldLog('closed'));
  const unrelated = originalMessage({ title: 'Unrelated embed', color: 0xFFFFFF,
    footer: { text: GIVEAWAY_CLAIM_LOG_FOOTER } });
  const anotherAuthor = originalMessage(oldLog('closed'), 'another-bot');
  w.cache.set(GIVEAWAY_CLAIM_LOG_CHANNEL_ID, {
    id: GIVEAWAY_CLAIM_LOG_CHANNEL_ID,
    messages: { fetch: async () => new Collection([
      ['1', opened], ['2', closed], ['3', unrelated], ['4', anotherAuthor],
    ]) },
  });

  await refreshExistingGiveawayClaimLogPresentation(w.client);
  for (const message of [opened, closed]) {
    assert.equal(message.edits.length, 1);
    const embed = message.embeds[0];
    assert.equal(embed.fields.find(field => field.name === 'Member').value, '<@' + WINNER + '>');
    assert.equal(embed.fields.find(field => field.name === 'Private channel').value,
      '<#' + originalChannel + '>');
    assert.equal(embed.footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
    assert.equal(embed.thumbnail.url, CLOUDY_C_LOGO_URL);
    if (message === opened) {
      assert.equal(embed.fields.find(field => field.name === 'Giveaway').value,
        '[#1](https://discord.com/channels/' + GUILD + '/156000000000000087/' + GIVEAWAY + ')');
    } else {
      assert.equal(embed.fields.find(field => field.name === 'Giveaway').value, '#1',
        'closed giveaways keep their number without a clickable link');
    }
    assert.equal(embed.timestamp, undefined);
  }
  assert.equal(opened.embeds[0].color, 0x00C49D);
  assert.equal(closed.embeds[0].color, 0xFF7A00);
  assert.equal(unrelated.edits.length, 0);
  assert.equal(anotherAuthor.edits.length, 0);
  await refreshExistingGiveawayClaimLogPresentation(w.client);
  assert.equal(opened.edits.length, 1);
  assert.equal(closed.edits.length, 1);
});

test('after closure, old closed/expired logs retain the raw private channel ID but earlier logs remain linked', async () => {
  const w = world();
  const rawId = '156000000000000123';
  function priorLog(event, author = w.client.user.id) {
    const embed = buildGiveawayClaimLog({
      event, guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
      claimChannelId: rawId,
      giveaway: { prize: 'Prize', channelId: '156000000000000087' },
    }).embeds[0];
    embed.fields = embed.fields.map(field =>
      field.name === 'Private channel' ? { ...field, value: '<#' + rawId + '>' } : field);
    const message = {
      author: { id: author }, embeds: [embed], edits: [],
      edit: async payload => { message.edits.push(payload); message.embeds = payload.embeds; },
    };
    return message;
  }
  const opened = priorLog('opened');
  const revealed = priorLog('revealed');
  const closed = priorLog('closed');
  const expired = priorLog('expired');
  const otherBot = priorLog('closed', 'external-bot');
  w.cache.set(GIVEAWAY_CLAIM_LOG_CHANNEL_ID, {
    id: GIVEAWAY_CLAIM_LOG_CHANNEL_ID,
    messages: { fetch: async () => new Collection([
      ['1', opened], ['2', revealed], ['3', closed], ['4', expired], ['5', otherBot],
    ]) },
  });
  await refreshClosedGiveawayClaimLogChannels(w.client);
  for (const entry of [closed, expired]) {
    assert.equal(entry.edits.length, 1);
    assert.equal(entry.embeds[0].fields.find(field => field.name === 'Private channel').value,
      '`' + rawId + '`');
    assert.equal(entry.embeds[0].footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
    assert.equal(entry.embeds[0].timestamp, undefined);
  }
  assert.equal(closed.embeds[0].color, 0xFF7A00);
  assert.equal(opened.edits.length, 0);
  assert.equal(revealed.edits.length, 0);
  assert.equal(otherBot.edits.length, 0);
  await refreshClosedGiveawayClaimLogChannels(w.client);
  assert.equal(closed.edits.length, 1);
  assert.equal(expired.edits.length, 1);
});

function attachClaimLogArchive(w) {
  const entries = [];
  const destination = w.cache.get(GIVEAWAY_CLAIM_LOG_CHANNEL_ID);
  destination.send = async payload => {
    const entry = {
      id: String(156000000000000400n + BigInt(entries.length)),
      author: { id: w.client.user.id },
      embeds: structuredClone(payload.embeds),
      edits: [],
      edit: async function(next) {
        this.edits.push(next);
        this.embeds = structuredClone(next.embeds);
        return this;
      },
    };
    entries.push(entry);
    return entry;
  };
  destination.messages = {
    fetch: async () => new Collection(entries.slice().reverse().map(entry => [entry.id, entry])),
  };
  return entries;
}
const loggedValue = entry => entry.embeds[0].fields.find(field => field.name === 'Private channel')?.value;
async function drainAuditActions() {
  for (let i = 0; i < 4; i++) await flushClaimLogs();
}

test('manual Close converts earlier Claim and Reveal logs to channel number, not only the Close log', async () => {
  const w = world();
  const archive = attachClaimLogArchive(w);
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  await drainAuditActions();
  assert.equal(archive.length, 1);
  assert.equal(loggedValue(archive[0]), '<#' + channel.id + '>');

  await handleGiveawayClaimInteraction(
    w.interaction('gclaim:reveal:' + CLAIM_ID, WINNER, { channel }), w.client);
  await drainAuditActions();
  assert.equal(archive.length, 2);
  assert.equal(loggedValue(archive[1]), '<#' + channel.id + '>');

  await handleGiveawayClaimInteraction(
    w.interaction('gclaim:done:' + CLAIM_ID, WINNER, { channel }), w.client);
  await drainAuditActions();
  assert.equal(channel.deleted, true);
  assert.deepEqual(archive.map(message => message.embeds[0].title), [
    'Giveaway claim opened', 'Giveaway code revealed', 'Giveaway claim closed',
  ]);
  assert.deepEqual(archive.map(loggedValue), Array(3).fill('`' + channel.id + '`'));
  assert.deepEqual(archive.map(entry => entry.edits.length), [1, 1, 0]);
  assert.deepEqual(archive.map(entry => entry.embeds[0].color), [0x00C49D, 0xFFFFFF, 0xFF7A00]);
  for (const entry of archive) {
    assert.equal(entry.embeds[0].footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
    assert.equal(entry.embeds[0].thumbnail.url, CLOUDY_C_LOGO_URL);
    assert.equal(entry.embeds[0].timestamp, undefined);
  }
  assert.equal(await updateClosedClaimChannelLogs(w.client, w.created[0].channel.guild,
    new Set([channel.id])), 0, 'running close cleanup twice never duplicates an edit');
});

test('automatic 24-hour expiry converts every previous channel mention to its ID', async () => {
  const w = world();
  const archive = attachClaimLogArchive(w);
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  await drainAuditActions();
  await handleGiveawayClaimInteraction(
    w.interaction('gclaim:reveal:' + CLAIM_ID, WINNER, { channel }), w.client);
  await drainAuditActions();
  const records = w.records.get(KEY);
  records[CLAIM_ID].expiresAt = new Date(Date.now() - 1000).toISOString();
  await w.client.db.set(KEY, records);
  await cleanupExpiredGiveawayClaims(w.client);
  await drainAuditActions();
  assert.equal(channel.deleted, true);
  assert.deepEqual(archive.map(loggedValue), Array(3).fill('`' + channel.id + '`'));
  assert.equal(archive[2].embeds[0].title, 'Giveaway auto expiry');
  assert.equal(archive[2].embeds[0].fields.some(field => field.name === 'Action'), false);
  assert.equal(archive[2].embeds[0].timestamp, undefined);
  assert.deepEqual(archive.map(entry => entry.edits.length), [1, 1, 0]);
});

test('older closed claims are reconciled once while unrelated and still-active claim logs remain linked', async () => {
  const w = world();
  const archive = attachClaimLogArchive(w);
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
  await drainAuditActions();
  const closed = structuredClone(w.records.get(KEY));
  closed[CLAIM_ID].closedAt = new Date().toISOString();
  await w.client.db.set(KEY, closed);
  const prior = archive[0];
  const otherId = '156000000000000999';
  const other = {
    id: '156000000000000998',
    author: { id: w.client.user.id },
    embeds: [buildGiveawayClaimLog({
      event: 'opened', guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
      claimChannelId: otherId, giveaway: { prize: 'Different prize' },
    }).embeds[0]],
    edits: [],
    edit: async function(next) { this.edits.push(next); this.embeds = next.embeds; },
  };
  archive.push(other);
  await refreshClosedClaimReferencesInEarlierLogs(w.client);
  assert.equal(loggedValue(prior), '`' + channel.id + '`');
  assert.equal(loggedValue(other), '<#' + otherId + '>');
  assert.equal(prior.edits.length, 1);
  assert.equal(other.edits.length, 0);
  await refreshClosedClaimReferencesInEarlierLogs(w.client);
  assert.equal(prior.edits.length, 1);
  assert.equal(other.edits.length, 0);

  const nonCloudy = { ...other, author: { id: 'unrelated-bot' }, embeds: [
    buildGiveawayClaimLog({
      event: 'opened', guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
      claimChannelId: channel.id,
    }).embeds[0],
  ] };
  const guarded = replaceClosedClaimChannelMentions(nonCloudy.embeds[0], new Set([otherId]));
  assert.equal(guarded.changed, false, 'mismatched channel ID stays unchanged');
});

test('legacy Claim accessed and denied audit entries are removed without affecting the three requested logs', async () => {
  const w = world();
  const deleted = [];
  const titles = [
    'Giveaway claim opened',
    'Giveaway claim accessed',
    'Giveaway code revealed',
    'Giveaway claim denied',
    'Giveaway claim closed',
    'Giveaway claim expired',
    'Unrelated status message',
  ];
  const messages = titles.map((title, i) => ({
    id: String(156000000000000700n + BigInt(i)),
    author: { id: w.client.user.id },
    embeds: [{
      title,
      footer: { text: GIVEAWAY_CLAIM_LOG_FOOTER },
    }],
    delete: async function () { deleted.push(title); },
  }));
  // Do not touch other authors, even if their embeds have the same title.
  messages.push({
    ...messages[1],
    id: '156000000000000900',
    author: { id: 'different-bot' },
    delete: async () => { throw new Error('Other bot message must not be deleted'); },
  });
  messages.push({
    ...messages[1],
    id: '156000000000000901',
    embeds: [{ title: 'Giveaway claim accessed', footer: { text: 'Other footer' } }],
    delete: async () => { throw new Error('Other embed must not be deleted'); },
  });
  w.cache.set(GIVEAWAY_CLAIM_LOG_CHANNEL_ID, {
    id: GIVEAWAY_CLAIM_LOG_CHANNEL_ID,
    messages: { fetch: async () => new Collection(messages.map(message => [message.id, message])) },
  });
  await removeRedundantGiveawayClaimLogs(w.client);
  assert.deepEqual(deleted, ['Giveaway claim accessed', 'Giveaway claim denied']);
  assert.equal(w.records.get('guild:' + GUILD + ':giveaway-claim:remove-extra-logs-v1'), true);
  await removeRedundantGiveawayClaimLogs(w.client);
  assert.deepEqual(deleted, ['Giveaway claim accessed', 'Giveaway claim denied'],
    'the one-time cleanup does not delete more messages after restart');
});

test('the log service exposes only the three requested claim stages and automatic closure', () => {
  const base = { guildId: GUILD, messageId: GIVEAWAY, userId: WINNER,
    claimChannelId: '156000000000000900', giveaway: { prize: 'Prize' } };
  assert.throws(() => buildGiveawayClaimLog({ ...base, event: 'accessed' }), /Unsupported/);
  assert.throws(() => buildGiveawayClaimLog({ ...base, event: 'denied' }), /Unsupported/);
  for (const [event, title] of [
    ['opened', 'Giveaway claim opened'],
    ['revealed', 'Giveaway code revealed'],
    ['closed', 'Giveaway claim closed'],
    ['expired', 'Giveaway auto expiry'],
  ]) {
    const embed = buildGiveawayClaimLog({ ...base, event }).embeds[0];
    assert.equal(embed.title, title);
    assert.equal(embed.fields.some(field => field.name === 'Action'), false);
  }
});
