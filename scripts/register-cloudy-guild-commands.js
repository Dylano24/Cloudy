import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { REST } from '@discordjs/rest';
import { isPlayerCommand } from '../src/config/playerCommands.js';

const token = String(
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.DISCORD_BOT_TOKEN ||
  ''
).trim();

const guildId = String(process.env.GUILD_ID || process.env.BOTPROFILE_GUILD_ID || '').trim();
const configuredClientId = String(
  process.env.CLIENT_ID ||
  process.env.DISCORD_CLIENT_ID ||
  process.env.APPLICATION_ID ||
  process.env.BOT_CLIENT_ID ||
  ''
).trim();

const CRITICAL = ['help', 'ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn', 'ticket'];

if (!token) {
  console.error('[PRESTART_COMMANDS] DISCORD_TOKEN is missing.');
  process.exit(1);
}
if (!guildId) {
  console.error('[PRESTART_COMMANDS] GUILD_ID is missing.');
  process.exit(1);
}

async function getCommandFiles(directory, files = []) {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'modules' || entry.name === 'Leveling') continue;
      await getCommandFiles(fullPath, files);
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function loadPayloads() {
  const commandsDir = path.resolve('src/commands');
  const files = await getCommandFiles(commandsDir);
  const payloads = [];
  const seen = new Set();

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const command = mod.default || mod;
      if (!command?.data || typeof command.data.toJSON !== 'function' || typeof command.execute !== 'function') {
        continue;
      }

      const payload = JSON.parse(JSON.stringify(command.data.toJSON()));
      if (!payload?.name || seen.has(payload.name)) continue;
      seen.add(payload.name);

      if (!isPlayerCommand(payload.name) && !payload.default_member_permissions) {
        payload.default_member_permissions = '8';
      }
      payloads.push(payload);
    } catch (error) {
      console.error(`[PRESTART_COMMANDS] Failed to load ${file}:`, error);
      process.exit(1);
    }
  }

  return payloads;
}

async function main() {
  const rest = new REST({ version: '10' }).setToken(token);

  const me = await rest.get('/users/@me');
  const applicationId = String(me.id);

  if (configuredClientId && configuredClientId !== applicationId) {
    console.warn(
      `[PRESTART_COMMANDS] CLIENT_ID ${configuredClientId} does not match token bot ID ${applicationId}; using token bot ID.`
    );
  }

  const payloads = await loadPayloads();
  if (!payloads.length) throw new Error('No Cloudy command payloads were loaded.');
  if (payloads.length > 100) {
    throw new Error(`Cloudy loaded ${payloads.length} top-level commands; Discord guild limit is 100.`);
  }

  const loadedNames = new Set(payloads.map((command) => command.name));
  const missingFiles = CRITICAL.filter((name) => !loadedNames.has(name));
  if (missingFiles.length) {
    throw new Error(`Critical command files missing before registration: ${missingFiles.join(', ')}`);
  }

  console.log(
    `[PRESTART_COMMANDS] Registering ${payloads.length} commands for app ${applicationId} in guild ${guildId}...`
  );

  // Old global commands from previous registration strategies can shadow or
  // confuse testing, so this deployment keeps Cloudy guild-scoped only.
  await rest.put(`/applications/${applicationId}/commands`, { body: [] });

  const result = await rest.put(
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    { body: payloads }
  );

  const returnedNames = new Set(result.map((command) => command.name));
  const missingCritical = CRITICAL.filter((name) => !returnedNames.has(name));
  if (missingCritical.length) {
    throw new Error(`Discord did not return critical commands: ${missingCritical.join(', ')}`);
  }

  const fetched = await rest.get(`/applications/${applicationId}/guilds/${guildId}/commands`);
  const fetchedNames = new Set(fetched.map((command) => command.name));
  const missingAfterFetch = CRITICAL.filter((name) => !fetchedNames.has(name));
  if (missingAfterFetch.length) {
    throw new Error(`Commands disappeared after registration: ${missingAfterFetch.join(', ')}`);
  }

  console.log(
    `[PRESTART_COMMANDS] VERIFIED ${fetched.length} guild commands. Critical commands present: ${CRITICAL.join(', ')}.`
  );
}

main().catch((error) => {
  console.error('[PRESTART_COMMANDS] FATAL:', error);
  process.exit(1);
});
