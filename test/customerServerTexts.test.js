import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUDY_HOME_GUILD_ID, isCloudyHomeGuild } from '../src/utils/cloudyHomeGuild.js';
import { customTicketOpening, renderTicketTemplate } from '../src/services/ticketCustomText.js';
import { buildTicketPanelPayload, CUSTOMER_TICKET_PANEL_MESSAGE, DEFAULT_TICKET_PANEL_MESSAGE } from '../src/services/ticketPanelBuilder.js';
import { buildCustomerWelcomeEmbed } from '../src/services/customerWelcomeCard.js';
import { formatWelcomeMessage } from '../src/utils/welcome.js';

const CUSTOMER = '111111111111111111';
const FAQ = '222222222222222222';
const client = { channels: { cache: new Map() }, application: null, emojis: { cache: new Map() } };
const buttons = payload => payload.components.flatMap(row => row.toJSON().components);

test('Cloudy Inc. is recognised by GUILD_ID, else by its fixed ID', () => {
  assert.equal(isCloudyHomeGuild(CLOUDY_HOME_GUILD_ID, {}), true);
  assert.equal(isCloudyHomeGuild(CUSTOMER, {}), false);
  assert.equal(isCloudyHomeGuild(CUSTOMER, { GUILD_ID: CUSTOMER }), true);
});

test('a customer\'s ticket panel has no Cloudy FAQ button and no FAQ sentence by default', () => {
  const payload = buildTicketPanelPayload(client, CUSTOMER, {});
  const json = payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0];
  assert.equal(json.description, CUSTOMER_TICKET_PANEL_MESSAGE);
  assert.doesNotMatch(JSON.stringify(buttons(payload)), /Cloudy assistant|1554538586001645679/);
  assert.equal(buttons(payload).some(button => button.custom_id === 'create_ticket'), true);
});

test('a customer chooses its own panel title, text, button and help channel', () => {
  const payload = buildTicketPanelPayload(client, CUSTOMER, { ticketPanelTitle: 'Need help?', ticketPanelMessage: 'Open a ticket below.', ticketButtonLabel: 'Open ticket', ticketFaqChannelId: FAQ, ticketFaqLabel: 'Rules' });
  const json = payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0];
  assert.equal(json.title, 'Need help?');
  assert.equal(json.description, 'Open a ticket below.');
  const all = buttons(payload);
  assert.equal(all.find(button => button.custom_id === 'create_ticket').label, 'Open ticket');
  const link = all.find(button => button.url);
  assert.equal(link.label, 'Rules');
  assert.equal(link.url, `https://discord.com/channels/${CUSTOMER}/${FAQ}`);
});

test('Cloudy Inc.\'s own panel is unchanged', () => {
  const payload = buildTicketPanelPayload(client, CLOUDY_HOME_GUILD_ID, {});
  const json = payload.embeds[0].toJSON ? payload.embeds[0].toJSON() : payload.embeds[0];
  assert.equal(json.description, DEFAULT_TICKET_PANEL_MESSAGE);
  assert.equal(buttons(payload).some(button => button.label === 'Cloudy assistant'), true);
});

test('custom ticket opening texts fill in their variables and always keep the reason', () => {
  assert.equal(customTicketOpening({}, {}), null, 'no custom text: the standard message');
  const vars = { user: '<@1>', reason: 'Lost my kit', number: 42, server: 'Rust EU' };
  const opening = customTicketOpening({ ticketOpenTitle: 'Ticket {number} · {server}', ticketOpenMessage: 'Hi {user}, read the rules first.' }, vars);
  assert.equal(opening.title, 'Ticket 42 · Rust EU');
  assert.equal(opening.description, 'Hi <@1>, read the rules first.\n\n**Reason:** Lost my kit');
  assert.equal(customTicketOpening({ ticketOpenMessage: 'Reason: {reason}' }, vars).description, 'Reason: Lost my kit');
  assert.equal(renderTicketTemplate('{USER}', vars), '<@1>');
});

test('a customer\'s welcome card uses only its own settings', () => {
  const guild = { id: CUSTOMER, name: 'Rust EU', iconURL: () => 'https://cdn.discordapp.com/icons/1/a.png' };
  const user = { id: '3', toString: () => '<@3>', username: 'Player', tag: 'Player' };
  const embed = buildCustomerWelcomeEmbed({ welcome: { welcomeMessage: 'Welcome {user} to {server}!', welcomeEmbed: { title: 'Hey!', color: '#E51B2E', image: 'https://example.com/banner.png' } }, guild, user, memberCount: 1284, format: formatWelcomeMessage }).toJSON();
  assert.equal(embed.title, 'Hey!');
  assert.match(embed.description, /Welcome <@3> to Rust EU!/);
  assert.match(embed.description, /#1,284/);
  assert.equal(embed.color, 0xE51B2E);
  assert.equal(embed.image.url, 'https://example.com/banner.png');
  assert.doesNotMatch(JSON.stringify(embed), /Cloudy Inc/);
  const plain = buildCustomerWelcomeEmbed({ welcome: { welcomeEmbed: { image: 'http://insecure.example/x.png' } }, guild, user, memberCount: 2, format: formatWelcomeMessage }).toJSON();
  assert.equal(plain.title, 'Welcome to Rust EU');
  assert.equal(plain.image, undefined, 'only https pictures');
});

test('/dashboard links to this server\'s dashboard page and tells the plan', async () => {
  const { dashboardLink, planLine, default: command } = await import('../src/commands/Core/dashboard.js');
  assert.equal(dashboardLink(CUSTOMER, {}), `https://cloudy-store-vert.vercel.app/bot/${CUSTOMER}`);
  assert.equal(dashboardLink(CUSTOMER, { CLOUDY_DASHBOARD_URL: 'https://cloudy.example/x' }), `https://cloudy.example/bot/${CUSTOMER}`);
  assert.equal(dashboardLink(CUSTOMER, { CLOUDY_DASHBOARD_URL: 'http://insecure.example' }), `https://cloudy-store-vert.vercel.app/bot/${CUSTOMER}`);
  assert.match(planLine({ status: 'new' }), /Saving changes needs Cloudy Bot Premium/);
  assert.doesNotMatch(planLine({ status: 'new' }), /trial/i);
  const json = command.data.toJSON();
  assert.equal(json.name, 'dashboard');
  assert.equal(json.default_member_permissions, String(1n << 5n), 'Manage Server only');
});

// ---------------------------------------------------------------- rules

test('/rules shows the server\'s own rules card', async () => {
  const { buildRulesEmbed, rulesOf } = await import('../src/services/serverRules.js');
  const guild = { name: 'Raid Night', iconURL: () => 'https://cdn.example/icon.png' };
  assert.equal(buildRulesEmbed({ rules: rulesOf({}), guild }), null, 'no rules yet: nothing to show');
  assert.equal(buildRulesEmbed({ rules: { text: '   ' }, guild }), null);
  const card = buildRulesEmbed({ rules: { text: '1. Be kind on {server}.', color: '#E51B2E' }, guild }).toJSON();
  assert.equal(card.title, 'Raid Night rules');
  assert.equal(card.description, '1. Be kind on Raid Night.');
  assert.equal(card.color, 0xE51B2E);
  assert.equal(card.thumbnail.url, 'https://cdn.example/icon.png');
  const titled = buildRulesEmbed({ rules: { title: 'House rules', text: 'No cheating.', color: 'red' }, guild }).toJSON();
  assert.equal(titled.title, 'House rules');
  assert.equal(titled.color, 0xFFFFFF, 'an invalid colour falls back to white');
  assert.equal(rulesOf({ rules: ['not', 'an', 'object'] }).text, undefined);
});

test('/rules: reading is private, posting for everyone needs Manage Server', async () => {
  const { default: rules } = await import('../src/commands/Community/rules.js');
  const json = rules.data.toJSON();
  assert.equal(json.name, 'rules');
  assert.equal(json.default_member_permissions ?? null, null, 'every member can read the rules');
  assert.deepEqual(json.options.map(option => option.name), ['post']);

  const replies = [];
  const interaction = (post, manage) => ({
    id: '333333333333333333', user: { id: '444444444444444444' }, createdTimestamp: Date.now(),
    guildId: CUSTOMER, guild: { name: 'Raid Night', iconURL: () => null },
    client: {},
    options: { getBoolean: () => post },
    memberPermissions: { has: () => manage },
    replied: false, deferred: false,
    reply: async payload => { replies.push(payload); },
    isRepliable: () => true,
  });
  await rules.execute(interaction(true, false));
  const refused = replies.at(-1);
  assert.match(JSON.stringify(refused.embeds[0]), /Manage Server/);
  assert.ok(refused.flags, 'the refusal is private');
});
