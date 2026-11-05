import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import {
  GIVEAWAY_COUNTRIES, generateGiveawayCode, giveawayCodeLabel, giveawayCountryModal,
  readGiveawayCodeModal, readGiveawayCountryModal, requiresCountry,
} from '../src/services/giveawayCodeService.js';
import { CLOUDY_C_LOGO_URL, createGiveawayButtons } from '../src/services/giveawayService.js';
import {
  buildGiveawayCreatedLog, buildGiveawayEndedLog, buildGiveawayWinnerCountryLog,
} from '../src/services/giveawayLogService.js';
import { GIVEAWAY_CLAIM_LOG_FOOTER } from '../src/services/giveawayClaimLogService.js';
import { finishGiveaway, loadGiveaway, setGiveawayCode } from '../src/services/giveawayActions.js';
import { giveawayCountryModalHandler, giveawayEnterHandler } from '../src/handlers/giveawayButtons.js';
import { GIVEAWAY_CLAIM_CATEGORY_ID, handleGiveawayClaimInteraction } from '../src/services/giveawayClaimService.js';

const GUILD = '156000000000000001';
const MESSAGE = '156000000000000002';
const CHANNEL = '156000000000000003';
const LOGS = '156000000000000004';
const OWNER_ROLE = '156000000000000005';
const json = value => value?.toJSON?.() || value;

const giveaway = (extra = {}) => ({
  messageId: MESSAGE, channelId: CHANNEL, guildId: GUILD, prize: '1 month vip', winnerCount: 1,
  participants: [], endsAt: Date.now() + 3_600_000, ended: false, isEnded: false,
  createdAt: new Date().toISOString(), giveawayNumber: 7, ...extra,
});

function world(stored) {
  const values = new Map([[`guild:${GUILD}:giveaways`, { [MESSAGE]: structuredClone(stored) }]]);
  const logs = [];
  const sent = [];
  const created = [];
  const giveawayMessage = { id: MESSAGE, edits: [], edit: async payload => { giveawayMessage.edits.push(payload); return giveawayMessage; } };
  const cache = new Collection();
  cache.set(CHANNEL, { id: CHANNEL, name: 'giveaway', isTextBased: () => true,
    messages: { fetch: async id => (id === MESSAGE ? giveawayMessage : null) },
    send: async payload => { const message = { id: String(156000000000000100n + BigInt(sent.length)), ...payload }; sent.push(message); return message; } });
  cache.set(LOGS, { id: LOGS, name: '🎉│giveaway-logs', type: ChannelType.GuildText, isTextBased: () => true,
    send: async payload => { logs.push(payload); return { id: 'log-' + logs.length }; } });
  cache.set(GIVEAWAY_CLAIM_CATEGORY_ID, { id: GIVEAWAY_CLAIM_CATEGORY_ID, type: ChannelType.GuildCategory });
  const guild = {
    id: GUILD, ownerId: 'owner',
    roles: { cache: new Collection([[OWNER_ROLE, { id: OWNER_ROLE, name: 'Owner' }]]) },
    channels: {
      cache, fetch: async id => cache.get(id) || null,
      create: async options => {
        const channel = { id: String(156000000000000200n + BigInt(created.length)), guild,
          send: async payload => { const message = { id: 'panel-' + created.length, ...payload }; sent.push(message); return message; } };
        created.push(options);
        cache.set(channel.id, channel);
        return channel;
      },
    },
  };
  const client = {
    user: { id: 'cloudy' },
    db: {
      get: async (key, fallback) => structuredClone(values.get(key) ?? fallback),
      set: async (key, value) => { values.set(key, structuredClone(value)); return true; },
    },
    guilds: { cache: new Collection([[GUILD, guild]]) },
    channels: { fetch: async () => null },
  };
  function interaction(user, extra = {}) {
    const result = {
      guildId: GUILD, guild, client, user: { id: user }, message: giveawayMessage,
      member: { id: user, roles: { cache: new Collection() }, permissions: { has: () => false } },
      inGuild: () => true, replies: [], replied: false, deferred: false,
      reply: async payload => { result.replies.push(payload); result.replied = true; },
      followUp: async payload => { result.replies.push(payload); return { id: 'follow-up' }; },
      deferUpdate: async () => { result.deferred = true; },
      deferReply: async () => { result.deferred = true; },
      editReply: async payload => { result.edited = payload; },
      deleteReply: async () => {},
      showModal: async modal => { result.modal = modal.toJSON(); },
      ...extra,
    };
    return result;
  }
  return { values, logs, sent, created, giveawayMessage, guild, client, interaction };
}

test('Cloudy generates CLOUDY- codes per code type', () => {
  assert.match(generateGiveawayCode({ codeType: 'standard' }), /^CLOUDY-\d{4}-\d{4}$/);
  assert.match(generateGiveawayCode({ codeType: 'kit' }), /^CLOUDY-K\d{3}-\d{4}$/);
  assert.match(generateGiveawayCode({ codeType: 'credit' }), /^CLOUDY-€\d{3}-\d{4}$/);
  assert.match(generateGiveawayCode({ codeType: 'discount', codeDiscount: 10 }), /^CLOUDY-REDUC10-\d{4}-\d{4}$/);
  assert.notEqual(generateGiveawayCode({ codeType: 'standard' }), generateGiveawayCode({ codeType: 'standard' }));
  assert.equal(giveawayCodeLabel({ codeType: 'discount', codeDiscount: 25 }), 'Discount -25%');
  assert.equal(giveawayCodeLabel({ codeType: 'none' }), 'No code');
  const form = (type, discount = '') => ({ fields: { getStringSelectValues: () => [type], getTextInputValue: () => discount } });
  assert.deepEqual(readGiveawayCodeModal(form('kit')), { codeType: 'kit', codeDiscount: null });
  assert.deepEqual(readGiveawayCodeModal(form('discount', '15%')), { codeType: 'discount', codeDiscount: 15 });
  assert.throws(() => readGiveawayCodeModal(form('discount', '0')), /discount from 1 to 100/);
});

test('only new giveaways without a code ask for a country; old giveaways stay as they were', () => {
  assert.equal(requiresCountry(giveaway({ codeType: 'none' })), true);
  assert.equal(requiresCountry(giveaway({ codeType: 'standard' })), false);
  assert.equal(requiresCountry(giveaway()), false);
  const id = value => json(createGiveawayButtons(value)[0]).components[0].custom_id;
  assert.equal(id(giveaway({ codeType: 'none' })), 'giveaway_enter:country');
  assert.equal(id(giveaway({ codeType: 'kit' })), 'giveaway_enter');
  assert.equal(id(giveaway()), 'giveaway_enter');
  assert.equal(id(giveaway({ codeType: 'none', ended: true, isEnded: true })), 'giveaway_enter');
});

test('the country form is a list of 25 with Other, and Other needs a typed country', () => {
  assert.equal(GIVEAWAY_COUNTRIES.length, 25);
  assert.equal(GIVEAWAY_COUNTRIES.at(-1), 'Other');
  const modal = giveawayCountryModal(MESSAGE).toJSON();
  assert.equal(modal.custom_id, `giveaway_country:${MESSAGE}`);
  assert.equal(modal.components[0].component.placeholder, 'Choose a country');
  assert.equal(modal.components[0].component.options.length, 25);
  const form = (country, other = '') => ({ fields: { getStringSelectValues: () => [country], getTextInputValue: () => other } });
  assert.equal(readGiveawayCountryModal(form('Netherlands')), 'Netherlands');
  assert.equal(readGiveawayCountryModal(form('Other', '  New   Zealand ')), 'New Zealand');
  assert.throws(() => readGiveawayCountryModal(form('Other')), /Other country/);
  assert.throws(() => readGiveawayCountryModal(form('Atlantis')), /Choose your country/);
});

test('Enter giveaway without a code: country form first, then the entry and its country are saved', async () => {
  const w = world(giveaway({ codeType: 'none', participantCountries: {} }));
  const click = w.interaction('member-1');
  await giveawayEnterHandler.execute(click, w.client, ['country']);
  assert.equal(click.modal.custom_id, `giveaway_country:${MESSAGE}`);
  assert.equal(click.deferred, false, 'the form is Discord\'s first answer');
  const submit = w.interaction('member-1', { fields: { getStringSelectValues: () => ['Belgium'], getTextInputValue: () => '' } });
  await giveawayCountryModalHandler.execute(submit, w.client, [MESSAGE]);
  const stored = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.deepEqual(stored.participants, ['member-1']);
  assert.deepEqual(stored.participantCountries, { 'member-1': 'Belgium' });
  assert.equal(json(submit.edited.components[0]).components[0].custom_id, 'giveaway_enter:country');
  assert.match(JSON.stringify(json(submit.replies[0].embeds[0])), /You entered the giveaway/);
});

test('ending a giveaway without a code logs the end and the winner country with the Owner role tagged', async () => {
  const w = world(giveaway({ codeType: 'none', participants: ['member-1'], participantCountries: { 'member-1': 'France' } }));
  await finishGiveaway(w.client, w.guild, MESSAGE, { endedBy: 'staff-1' });
  assert.equal(w.logs.length, 2);
  const [ended, country] = w.logs;
  assert.equal(ended.embeds[0].title, 'Giveaway ended');
  assert.match(JSON.stringify(ended.embeds[0].fields), /\[#7\]\(https:\/\/discord\.com\/channels\//);
  assert.match(JSON.stringify(ended.embeds[0].fields), /<@staff-1>/);
  assert.equal(country.embeds[0].title, 'Giveaway winner country');
  assert.equal(country.content, `<@&${OWNER_ROLE}>`);
  assert.deepEqual(country.allowedMentions, { parse: [], roles: [OWNER_ROLE] });
  assert.equal(country.embeds[0].fields.find(field => field.name === 'Winner').value, '<@member-1>: France');
  for (const log of w.logs) {
    assert.deepEqual(log.embeds[0].thumbnail, { url: CLOUDY_C_LOGO_URL });
    assert.equal(log.embeds[0].footer.text, GIVEAWAY_CLAIM_LOG_FOOTER);
  }
});

test('a website giveaway logs only its end (no country log)', async () => {
  const w = world(giveaway({ codeType: 'standard', participants: ['member-1'] }));
  await finishGiveaway(w.client, w.guild, MESSAGE);
  assert.deepEqual(w.logs.map(log => log.embeds[0].title), ['Giveaway ended']);
  assert.match(JSON.stringify(w.logs[0].embeds[0].fields), /Automatic/);
});

test('created log shows number, prize, host, channel, winners, code and dates', () => {
  const log = buildGiveawayCreatedLog(GUILD, giveaway({ hostId: 'staff-1', codeType: 'kit' }), 7);
  const embed = log.embeds[0];
  assert.equal(embed.title, 'Giveaway created');
  assert.equal(embed.color, 0x00C49D);
  assert.deepEqual(embed.fields.map(field => field.name), ['Giveaway', 'Prize', 'Hosted by', 'Channel', 'Winners', 'Code', 'Ends', 'Date']);
  assert.equal(embed.fields[5].value, 'Kit');
  assert.deepEqual(log.allowedMentions, { parse: [] });
  assert.equal(buildGiveawayEndedLog(GUILD, giveaway({ endedAt: new Date().toISOString() }), [], 7).embeds[0]
    .fields.find(field => field.name === 'Winners').value, 'No valid entries');
  assert.equal(buildGiveawayWinnerCountryLog(GUILD, giveaway(), ['a', 'b'], { number: 7 }).embeds[0]
    .fields.find(field => field.name === 'Winners').value, '<@a>: Not provided\n<@b>: Not provided');
});

test('Code in Manage changes the Enter button of an active giveaway', async () => {
  const w = world(giveaway({ codeType: 'none' }));
  await setGiveawayCode(w.client, w.guild, MESSAGE, { codeType: 'discount', codeDiscount: 20 });
  const stored = await loadGiveaway(w.client, GUILD, MESSAGE);
  assert.equal(stored.codeType, 'discount');
  assert.equal(stored.codeDiscount, 20);
  assert.equal(json(w.giveawayMessage.edits.at(-1).components[0]).components[0].custom_id, 'giveaway_enter');
});

test('claim channels carry the giveaway number; a website winner reveals a CLOUDY- code, a no-code winner has no Reveal', async () => {
  const won = { ended: true, isEnded: true, winnerIds: ['winner'], participants: ['winner'] };
  const website = world(giveaway({ ...won, codeType: 'credit' }));
  const open = website.interaction('winner', { customId: `gclaim:open:${MESSAGE}` });
  await handleGiveawayClaimInteraction(open, website.client);
  assert.equal(website.created[0].name, 'giveaway-claim-7');
  const panel = website.sent.at(-1);
  assert.deepEqual(json(panel.components[0]).components.map(button => button.label), ['Reveal my code', 'Close']);
  const channelId = [...website.guild.channels.cache.keys()].at(-1);
  const reveal = website.interaction('winner', { customId: `gclaim:reveal:${MESSAGE}:winner`, channelId });
  await handleGiveawayClaimInteraction(reveal, website.client);
  assert.match(reveal.edited.content, /^CLOUDY-€\d{3}-\d{4}$/);
  const again = website.interaction('winner', { customId: `gclaim:reveal:${MESSAGE}:winner`, channelId });
  await handleGiveawayClaimInteraction(again, website.client);
  assert.equal(again.edited.content, reveal.edited.content, 'the same code every time');

  const outside = world(giveaway({ ...won, codeType: 'none' }));
  await handleGiveawayClaimInteraction(outside.interaction('winner', { customId: `gclaim:open:${MESSAGE}` }), outside.client);
  const noCodePanel = outside.sent.at(-1);
  assert.deepEqual(json(noCodePanel.components[0]).components.map(button => button.label), ['Close']);
  assert.match(noCodePanel.embeds[0].description, /Our team will contact you in this channel/);
  assert.doesNotMatch(noCodePanel.embeds[0].description, /Reveal my code|activation code/);
});
