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
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

if (!token) {
  console.error('[COMMAND_SYNC] DISCORD_TOKEN is missing.');
  process.exit(1);
}
if (!guildId) {
  console.error('[COMMAND_SYNC] GUILD_ID is missing.');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
      if (entry.name === 'modules') continue;
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
    try {
      const mod = await import(pathToFileURL(file).href);
      const command = mod.default || mod;
      if (!command?.data || typeof command.data.toJSON !== 'function' || typeof command.execute !== 'function') continue;

      const payload = JSON.parse(JSON.stringify(command.data.toJSON()));
      if (!payload?.name || seen.has(payload.name)) continue;
      seen.add(payload.name);

      if (!isPlayerCommand(payload.name) && !payload.default_member_permissions) {
        payload.default_member_permissions = '8';
      }

      delete payload.dm_permission;
      payloads.push(payload);
    } catch (error) {
      console.error(`[COMMAND_SYNC] Failed loading ${file}: ${error.message}`);
    }
  }

  return payloads.sort((a, b) => a.name.localeCompare(b.name));
}

function retryAfterSeconds(result) {
  const raw = result?.body?.retry_after ?? result?.response?.headers?.get?.('retry-after');
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeCommand(value) {
  if (Array.isArray(value)) return value.map(normalizeCommand);
  if (!value || typeof value !== 'object') return value;

  const ignored = new Set([
    'id',
    'application_id',
    'guild_id',
    'version',
    'dm_permission',
    'integration_types',
    'contexts',
    'nsfw',
  ]);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (ignored.has(key) || value[key] === undefined || value[key] === null) continue;
    result[key] = normalizeCommand(value[key]);
  }
  return result;
}

function commandSetsMatch(current, desired) {
  if (!Array.isArray(current) || current.length !== desired.length) return false;
  const currentNormalized = current
    .map(normalizeCommand)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const desiredNormalized = desired
    .map(normalizeCommand)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return JSON.stringify(currentNormalized) === JSON.stringify(desiredNormalized);
}

async function main() {
  const me = await discordFetch('/users/@me');
  if (!me.response.ok || !me.body?.id) {
    throw new Error(`Discord token check failed (${me.response.status}): ${JSON.stringify(me.body)}`);
  }

  const applicationId = String(me.body.id);
  if (configuredClientId && configuredClientId !== applicationId) {
    console.warn(`[COMMAND_SYNC] CLIENT_ID ${configuredClientId} != authenticated app ${applicationId}; authenticated app wins.`);
  }

  const payloads = await loadPayloads();
  if (!payloads.length || payloads.length > 100) {
    throw new Error(`Invalid command count ${payloads.length}; expected 1-100.`);
  }

  const route = `/applications/${applicationId}/guilds/${guildId}/commands`;

  try {
    const existing = await discordFetch(route, { method: 'GET' });
    if (existing.response.ok && commandSetsMatch(existing.body, payloads)) {
      console.log(`[COMMAND_SYNC] SKIPPED: Discord already has the current ${payloads.length} Cloudy guild commands.`);
      return;
    }
  } catch (error) {
    console.warn(`[COMMAND_SYNC] Existing-command check unavailable: ${error.message}; continuing with sync.`);
  }

  console.log(`[COMMAND_SYNC] Bulk guild sync started: app=${applicationId}, guild=${guildId}, commands=${payloads.length}.`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let result;
    try {
      result = await discordFetch(route, {
        method: 'PUT',
        body: JSON.stringify(payloads),
      });
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error;
      console.warn(`[COMMAND_SYNC] Request failed: ${error.message}; retrying shortly.`);
      await sleep(5_000);
      continue;
    }

    if (result.response.ok && Array.isArray(result.body)) {
      console.log(`[COMMAND_SYNC] COMPLETE: Discord now has ${result.body.length} Cloudy guild commands.`);
      return;
    }

    if (result.response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = retryAfterSeconds(result);
      const waitSeconds = Math.max(5, Math.ceil((retryAfter ?? 5) + 1));
      console.warn(`[COMMAND_SYNC] Rate-limited; waiting ${waitSeconds}s before retry.`);
      await sleep(waitSeconds * 1000);
      continue;
    }

    throw new Error(
      `Bulk command sync rejected HTTP ${result.response.status}: ${JSON.stringify(result.body)}`
    );
  }
}

main().catch(error => {
  console.error('[COMMAND_SYNC] FATAL:', error.message);
  process.exitCode = 1;
});
