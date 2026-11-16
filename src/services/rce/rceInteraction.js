// Shared pieces of the /rce, /rceconfig and /rust commands: replies in the
// Cloudy style (Success / Warning are 10-second status replies) and
// autocomplete lists.
import { MessageFlags } from 'discord.js';
import { QUICK_CHAT } from './rceParser.js';
import { getRceConfig, findServer } from './rceStore.js';
import { getRceRuntime } from './rceRuntime.js';
import { RCE_COLORS, rceEmbed } from './rceEmbeds.js';

export class RceUserError extends Error {}
export const fail = message => { throw new RceUserError(message); };

export function success(description) {
  return { embeds: [rceEmbed('Success', [description], { color: RCE_COLORS.green })], allowedMentions: { parse: [] } };
}

export function warning(description) {
  return { embeds: [rceEmbed('Warning', [description], { color: RCE_COLORS.red })], allowedMentions: { parse: [] } };
}

export function info(title, lines, options = {}) {
  return { embeds: [rceEmbed(title, lines, options)], allowedMentions: { parse: [] } };
}

/** Runs a command body: defers (ephemeral unless `visible`), shows errors as a Warning. */
export async function runRceCommand(interaction, body, { visible = false } = {}) {
  if (!interaction.inGuild?.()) {
    return interaction.reply({ ...warning('This command works in a server only.'), flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply(visible ? {} : { flags: MessageFlags.Ephemeral });
  try {
    const payload = await body();
    if (payload) await interaction.editReply(payload);
  } catch (error) {
    const known = error instanceof RceUserError || error?.name === 'RceCommandError' || error?.userMessage;
    const message = error?.userMessage || (known ? error.message : null) || error?.message || 'Please try again.';
    await interaction.editReply(warning(String(message).slice(0, 1000))).catch(() => undefined);
  }
  return undefined;
}

export function requireRuntime() {
  const runtime = getRceRuntime();
  if (!runtime) fail('The Rust Console module is still starting. Try again in a minute.');
  return runtime;
}

/** The configured server for an option value (or the only server). */
export async function serverFromOption(interaction, optionName = 'server', { required = true } = {}) {
  const config = await getRceConfig(interaction.client, interaction.guildId);
  const value = interaction.options.getString(optionName);
  if (!config.servers.length) fail('No game server is set up yet. Add one with /rce server add.');
  const server = findServer(config, value);
  if (!server && (required || value)) fail(value ? 'That game server does not exist. Pick one from the list.' : 'Choose a game server.');
  return { config, server };
}

export function liveSession(runtime, guildId, server) {
  const session = runtime.session(guildId, server.id);
  if (!session) fail(`${server.name} is not connected (disabled, Premium needed, or the password cannot be read).`);
  if (!session.online) fail(`${server.name} is ${session.state === 'connecting' ? 'still connecting' : 'offline'}${session.lastError ? ` (${session.lastError})` : ''}. Check the address, port and password.`);
  return session;
}

const clip = (text, max = 100) => String(text).slice(0, max);

export function filterChoices(entries, query) {
  const text = String(query || '').toLowerCase();
  return entries
    .filter(entry => !text || entry.name.toLowerCase().includes(text) || String(entry.value).toLowerCase().includes(text))
    .slice(0, 25)
    .map(entry => ({ name: clip(entry.name), value: clip(entry.value) }));
}

/** Autocomplete answers shared by the three commands. */
export async function rceAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const config = await getRceConfig(interaction.client, interaction.guildId).catch(() => null);
  if (!config) return interaction.respond([]);
  const runtime = getRceRuntime();
  const query = focused.value;
  let entries;
  switch (focused.name) {
    case 'server':
      entries = config.servers.map(server => ({ name: `${server.name} (${server.id})`, value: server.id }));
      break;
    case 'item':
      entries = config.shop.map(item => ({ name: `${item.name} · ${item.price.toLocaleString('en-US')}`, value: item.id }));
      break;
    case 'location':
      entries = config.locations.map(location => ({ name: location.name, value: location.name }));
      break;
    case 'emote':
      entries = Object.entries(QUICK_CHAT).map(([value, name]) => ({ name, value }));
      break;
    case 'action-id':
      entries = config.emotes.map(binding => ({ name: `${QUICK_CHAT[binding.trigger]} → ${binding.name || `${binding.action} ${binding.value}`}`, value: binding.id }));
      break;
    case 'message-id':
      entries = config.automessages.map(message => ({ name: message.text, value: message.id }));
      break;
    case 'player': {
      const names = new Set();
      for (const session of runtime?.guildSessions(interaction.guildId) || []) for (const player of session.players.values()) names.add(player.name);
      entries = [...names].sort().map(name => ({ name, value: name }));
      break;
    }
    default:
      entries = [];
  }
  return interaction.respond(filterChoices(entries, query)).catch(() => undefined);
}
