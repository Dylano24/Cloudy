import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { isPlayerCommand } from '../src/config/playerCommands.js';

const token = String(
  process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || ''
).trim();
const guildId = String(process.env.GUILD_ID || process.env.BOTPROFILE_GUILD_ID || '').trim();
const configuredClientId = String(
  process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID || process.env.APPLICATION_ID || process.env.BOT_CLIENT_ID || ''
).trim();

const API = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 20000;
const CRITICAL = ['help', 'ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn', 'ticket'];
const DAILY_CREATE_LIMIT_CODE = 30034;
const MAX_ATTEMPTS = 48;

if (!token) {
  console.error('[COMMAND_RECOVERY] DISCORD_TOKEN is missing.');
  process.exit(1);
}
if (!guildId) {
  console.error('[COMMAND_RECOVERY] GUILD_ID is missing.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discordFetch(endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetch(`${API}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
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
  const files = await getCommandFiles(path.resolve('src/commands'));
  const payloads = [];
  const seen = new Set();

  for (const file of files) {
    const mod = await import(pathToFileURL(file).href);
    const command = mod.default || mod;
    if (!command?.data || typeof command.data.toJSON !== 'function' || typeof command.execute !== 'function') continue;

    const payload = JSON.parse(JSON.stringify(command.data.toJSON()));
    if (!payload?.name || seen.has(payload.name)) continue;
    seen.add(payload.name);

    if (!isPlayerCommand(payload.name) && !payload.default_member_permissions) {
      payload.default_member_permissions = '8';
    }
    payloads.push(payload);
  }

  return payloads;
}

function missingCritical(commands = []) {
  const names = new Set(commands.map((command) => command.name));
  return CRITICAL.filter((name) => !names.has(name));
}

function retryAfterSeconds(result) {
  const raw = result?.body?.retry_after ?? result?.response?.headers?.get?.('retry-after');
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function mergeExistingIds(payloads, existing) {
  const ids = new Map(existing.map((command) => [`${command.type || 1}:${command.name}`, command.id]));
  return payloads.map((payload) => {
    const id = ids.get(`${payload.type || 1}:${payload.name}`);
    return id ? { ...payload, id } : payload;
  });
}

async function main() {
  const me = await discordFetch('/users/@me');
  if (!me.response.ok || !me.body?.id) {
    throw new Error(`Discord token check failed (${me.response.status}): ${JSON.stringify(me.body)}`);
  }

  const applicationId = String(me.body.id);
  if (configuredClientId && configuredClientId !== applicationId) {
    console.warn(`[COMMAND_RECOVERY] CLIENT_ID ${configuredClientId} != authenticated app ${applicationId}; authenticated app wins.`);
  }

  const payloads = await loadPayloads();
  if (!payloads.length || payloads.length > 100) {
    throw new Error(`Invalid command count ${payloads.length}; expected 1-100.`);
  }

  const missingFiles = missingCritical(payloads);
  if (missingFiles.length) {
    throw new Error(`Critical command files missing: ${missingFiles.join(', ')}`);
  }

  const route = `/applications/${applicationId}/guilds/${guildId}/commands`;
  console.log(`[COMMAND_RECOVERY] Target app=${applicationId} guild=${guildId} desired=${payloads.length}.`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let existingResult;
    try {
      existingResult = await discordFetch(route);
    } catch (error) {
      console.error(`[COMMAND_RECOVERY] GET attempt ${attempt} failed: ${error.message}`);
      await sleep(60000);
      continue;
    }

    if (existingResult.response.ok && Array.isArray(existingResult.body)) {
      const existing = existingResult.body;
      const criticalMissing = missingCritical(existing);
      if (existing.length === payloads.length && criticalMissing.length === 0) {
        console.log(`[COMMAND_RECOVERY] HEALTHY: ${existing.length} guild commands already registered. Critical commands present.`);
        return;
      }

      console.log(
        `[COMMAND_RECOVERY] Attempt ${attempt}/${MAX_ATTEMPTS}: existing=${existing.length}, desired=${payloads.length}, ` +
        `missingCritical=${criticalMissing.join(',') || 'none'}.`
      );

      const body = mergeExistingIds(payloads, existing);
      let sync;
      try {
        sync = await discordFetch(route, { method: 'PUT', body: JSON.stringify(body) });
      } catch (error) {
        console.error(`[COMMAND_RECOVERY] PUT attempt ${attempt} failed: ${error.message}`);
        await sleep(60000);
        continue;
      }

      if (sync.response.ok && Array.isArray(sync.body)) {
        const missing = missingCritical(sync.body);
        if (missing.length) {
          throw new Error(`Discord accepted guild set but critical commands are missing: ${missing.join(', ')}`);
        }
        console.log(`[COMMAND_RECOVERY] SUCCESS: Discord accepted ${sync.body.length} GUILD commands; visible immediately in Cloudy.`);
        return;
      }

      const retryAfter = retryAfterSeconds(sync);
      const apiCode = Number(sync.body?.code);

      if (sync.response.status === 429) {
        const waitSeconds = Math.max(5, Math.ceil((retryAfter ?? 60) + 2));
        console.warn(`[COMMAND_RECOVERY] RATE_LIMIT 429: retry_after=${retryAfter ?? 'unknown'}s; retrying in ${waitSeconds}s.`);
        await sleep(waitSeconds * 1000);
        continue;
      }

      if (apiCode === DAILY_CREATE_LIMIT_CODE) {
        console.warn('[COMMAND_RECOVERY] Discord daily command-create limit (30034) reached. Cloudy stays online; retrying in 60 minutes.');
        await sleep(60 * 60 * 1000);
        continue;
      }

      console.error(`[COMMAND_RECOVERY] Discord rejected guild sync HTTP ${sync.response.status}: ${JSON.stringify(sync.body)}`);
      await sleep(5 * 60 * 1000);
      continue;
    }

    const retryAfter = retryAfterSeconds(existingResult);
    if (existingResult.response.status === 429) {
      const waitSeconds = Math.max(5, Math.ceil((retryAfter ?? 60) + 2));
      console.warn(`[COMMAND_RECOVERY] GET rate-limited: retry_after=${retryAfter ?? 'unknown'}s; retrying in ${waitSeconds}s.`);
      await sleep(waitSeconds * 1000);
      continue;
    }

    console.error(`[COMMAND_RECOVERY] Cannot read guild commands HTTP ${existingResult.response.status}: ${JSON.stringify(existingResult.body)}`);
    await sleep(5 * 60 * 1000);
  }

  console.error('[COMMAND_RECOVERY] Automatic recovery exhausted all attempts; bot remains online.');
}

main().catch((error) => {
  console.error('[COMMAND_RECOVERY] FATAL:', error);
  process.exitCode = 1;
});
