import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { dashboardSetupUrl, pickSetupChannel, sendSetupWelcome } from '../src/services/dashboardOnboarding.js';

const HOME = '1532882647838228723';
const CUSTOMER = '111111111111111111';
const ENV = { CLOUDY_DASHBOARD_URL: 'https://cloudy-store-vert.vercel.app/', GUILD_ID: HOME };
const ALL = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

function channel(id, { position = 0, allowed = ALL, type = ChannelType.GuildText } = {}) {
  const sent = [];
  return { id, type, rawPosition: position, sent, permissionsFor: () => ({ has: flag => allowed.includes(flag) }), send: async payload => { sent.push(payload); return { id: `m${id}` }; } };
}
function guild({ id = CUSTOMER, system = null, channels = [] } = {}) {
  return { id, name: 'Customer server', systemChannel: system, members: { me: { id: 'bot' } }, channels: { cache: new Map(channels.map(c => [c.id, c])) } };
}
function client() {
  const store = new Map();
  return { store, db: { get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback), set: async (key, value) => { store.set(key, value); return true; } } };
}

test('the dashboard link needs an https website address and a valid server ID', () => {
  assert.equal(dashboardSetupUrl(CUSTOMER, ENV), `https://cloudy-store-vert.vercel.app/bot/${CUSTOMER}`);
  assert.equal(dashboardSetupUrl(CUSTOMER, {}), null);
  assert.equal(dashboardSetupUrl(CUSTOMER, { CLOUDY_DASHBOARD_URL: 'http://insecure.example' }), null);
  assert.equal(dashboardSetupUrl('x', ENV), null);
});

test('the setup message goes to the system channel, else the first channel Cloudy may post in', () => {
  const system = channel('1', { position: 5 });
  assert.equal(pickSetupChannel(guild({ system, channels: [channel('2')] })), system);
  const blocked = channel('1', { allowed: [PermissionFlagsBits.ViewChannel] });
  const second = channel('3', { position: 2 });
  const first = channel('2', { position: 1 });
  assert.equal(pickSetupChannel(guild({ system: blocked, channels: [blocked, second, first, channel('4', { type: ChannelType.GuildVoice })] })), first);
  assert.equal(pickSetupChannel(guild({ channels: [blocked] })), null);
});

test('it is sent once per customer server, never in Cloudy\'s own server, and only when configured', async () => {
  const target = channel('2');
  const c = client();
  const result = await sendSetupWelcome(guild({ channels: [target] }), c, { env: ENV });
  assert.deepEqual(result, { sent: true, channelId: '2' });
  const payload = target.sent[0];
  assert.equal(payload.embeds[0].data.title, 'Thanks for adding Cloudy');
  assert.equal(payload.components[0].components[0].data.url, `https://cloudy-store-vert.vercel.app/bot/${CUSTOMER}`);
  assert.deepEqual(payload.allowedMentions, { parse: [] });

  assert.equal((await sendSetupWelcome(guild({ channels: [target] }), c, { env: ENV })).reason, 'already_sent');
  assert.equal(target.sent.length, 1);
  assert.equal((await sendSetupWelcome(guild({ id: HOME, channels: [channel('9')] }), client(), { env: ENV })).reason, 'home_guild');
  assert.equal((await sendSetupWelcome(guild({ channels: [channel('8')] }), client(), { env: { GUILD_ID: HOME } })).reason, 'not_configured');
  assert.equal((await sendSetupWelcome(guild({ channels: [] }), client(), { env: ENV })).reason, 'no_channel');
});
