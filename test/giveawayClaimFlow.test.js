import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { createWinnerAnnouncement } from '../src/services/giveawayService.js';
import {
  CLAIM_LIFETIME_MS, handleGiveawayClaimInteraction, cleanupExpiredGiveawayClaims,
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
      reply: async payload => { item.response = payload; },
      showModal: async modal => { item.modal = modal.toJSON(); },
    };
    return item;
  }
  return { client, records, sent, created, interaction };
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
  assert.match(outsider.response.content, /Only a current winner/);
  assert.equal(w.created.length, 0);
  const open = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(open, w.client);
  assert.match(open.response.content, /private claim channel/);
  assert.equal(w.created.length, 1);
  const { options, channel } = w.created[0];
  const everyone = options.permissionOverwrites.find(value => value.id === GUILD);
  const winner = options.permissionOverwrites.find(value => value.id === WINNER);
  assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(winner.allow.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(winner.allow.includes(PermissionFlagsBits.SendMessages));
  const claimEmbed = w.sent[0].embeds[0];
  assert.equal(claimEmbed.title, undefined);
  assert.equal(claimEmbed.color, 0xFFFFFF);
  assert.match(claimEmbed.description, /<@156000000000000003>, congratulations on winning/);
  const parts = ['Your prize', 'Prize details', 'How to claim', 'Important'];
  let previous = 0;
  for (const part of parts) {
    const at = claimEmbed.description.indexOf('**' + part + '**');
    assert.ok(at > previous, part + ' must occur in order');
    previous = at;
  }
  assert.match(claimEmbed.description, /Your prize is ready to be claimed/);
  assert.match(claimEmbed.description, /valid for six months/);
  assert.match(claimEmbed.description, /Press Take code/);
  assert.match(claimEmbed.description, /close 24 hours after you reveal/);
  assert.doesNotMatch(claimEmbed.description, /🎁 Your prize|🔑 How to claim|⏱️ Important/);
  assert.equal(claimEmbed.footer.text, '© Cloudy Inc. • Quality. Innovation. Performance.');
  assert.ok(claimEmbed.thumbnail.url);
  const panelButtons = w.sent[0].components[0].toJSON().components;
  assert.equal(panelButtons.length, 1);
  assert.equal(panelButtons[0].label, 'Take code');
  assert.equal(panelButtons[0].style, 2);
  assert.equal(panelButtons[0].disabled, true);
  const repeat = w.interaction('gclaim:open:' + GIVEAWAY);
  await handleGiveawayClaimInteraction(repeat, w.client);
  assert.equal(w.created.length, 1);
  assert.match(repeat.response.content, new RegExp(channel.id));
});

test('existing claim panel is edited in place on restart and Staff Set code disappears', async () => {
  const w = world();
  await handleGiveawayClaimInteraction(w.interaction('gclaim:open:' + GIVEAWAY), w.client);
  const channel = w.created[0].channel;
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
  assert.equal(w.sent.length, 1);
  assert.equal(panel.content, originalContent);
  assert.equal(panel.embeds[0].title, undefined);
  assert.match(panel.embeds[0].description, /\*\*Prize details\*\*/);
  assert.match(panel.embeds[0].description, /\*\*How to claim\*\*/);
  assert.equal(panel.embeds[0].color, 0xFFFFFF);
  assert.deepEqual(panel.components[0].toJSON().components.map(button => button.label), ['Take code']);
  assert.equal(w.records.get(KEY)[CLAIM_ID].panelMessageId, panel.id);
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
  assert.equal(w.records.get(KEY)[CLAIM_ID].expiresAt, null);

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
  assert.equal(w.records.get(KEY)[CLAIM_ID].expiresAt, null);

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
