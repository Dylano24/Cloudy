// Population bots (owner's choice, like the "EU 6x" bot on another server): one
// extra Discord bot per game server whose custom status shows "🟢 87/100" and
// that sits in the member list under the "Population" role. Each bot is its own
// Discord application; its token comes from POPULATION_BOT_TOKENS, a JSON object
// {"<game server name>": "<bot token>"}. Servers without a token keep the
// webhook message in #population.
import { ActivityType, Client, GatewayIntentBits } from 'discord.js';
import { logger } from '../utils/logger.js';

export const POPULATION_ROLE_NAME = 'Population';
const bots = new Map();
const warned = new Set();

export function populationBotTokens(env = process.env) {
  try {
    const parsed = JSON.parse(env.POPULATION_BOT_TOKENS || '{}');
    return Object.fromEntries(Object.entries(parsed)
      .filter(([name, token]) => name && typeof token === 'string' && token.length > 30));
  } catch {
    return {};
  }
}

const defaultClient = () => new Client({ intents: [GatewayIntentBits.Guilds] });

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

function loginBot(name, token, createClient) {
  if (!bots.has(token)) {
    bots.set(token, (async () => {
      const bot = createClient();
      try {
        await bot.login(token);
        return bot;
      } catch (error) {
        warnOnce(`login:${name}`, `Population bot for ${name} could not log in: ${error?.message || error}`);
        return null;
      }
    })());
  }
  return bots.get(token);
}

async function ensureRole(guild) {
  const existing = guild.roles.cache.find(role => role.name === POPULATION_ROLE_NAME);
  return existing || guild.roles.create({ name: POPULATION_ROLE_NAME, hoist: true, mentionable: false, reason: 'Cloudy population bots' });
}

/**
 * Sets the status of each server's bot and gives it the Population role.
 * `entries`: [{ name, online, text }]. Returns the names of the servers a bot
 * handled, so the caller only posts webhook messages for the others.
 */
export async function updatePopulationBots(guild, entries, { env = process.env, createClient = defaultClient } = {}) {
  const tokens = populationBotTokens(env);
  const handled = new Set();
  for (const entry of entries) {
    const token = tokens[entry.name];
    if (!token) continue;
    const bot = await loginBot(entry.name, token, createClient);
    if (!bot?.user) continue;
    try {
      bot.user.setPresence({
        status: entry.online ? 'online' : 'dnd',
        activities: [{ type: ActivityType.Custom, name: 'Custom Status', state: entry.text }],
      });
      const member = await guild.members.fetch(bot.user.id).catch(() => null);
      if (!member) {
        warnOnce(`member:${entry.name}`, `Population bot for ${entry.name} is not in this server yet: invite it first.`);
        continue;
      }
      const role = await ensureRole(guild);
      if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Cloudy population bots');
      handled.add(entry.name);
    } catch (error) {
      warnOnce(`update:${entry.name}`, `Population bot for ${entry.name} could not be updated: ${error?.message || error}`);
    }
  }
  return handled;
}

export function resetPopulationBots() {
  bots.clear();
  warned.clear();
}
