import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { isPlayerCommand } from '../src/config/playerCommands.js';

const token = String(
  process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || ''
).trim();

const configuredClientId = String(
  process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID || process.env.APPLICATION_ID || process.env.BOT_CLIENT_ID || ''
).trim();

const CRITICAL = ['help', 'ban', 'unban', 'kick', 'timeout', 'untimeout', 'warn', 'ticket'];
const API = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 20000;

if (!token) {
  console.error('[PRESTART_COMMANDS] DISCORD_TOKEN is missing.');
  process.exit(1);
}

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

    // Keep command-specific permissions such as BanMembers/ModerateMembers.
    // Only commands without their own Discord permission get Administrator.
    if (!isPlayerCommand(payload.name) && !payload.default_member_permissions) {
      payload.default_member_permissions = '8';
    }
    payloads.push(payload);
  }
  return payloads;
}

function criticalMissing(commands = []) {
  const names = new Set(commands.map((command) => command.name));
  return CRITICAL.filter((name) => !names.has(name));
}

async function main() {
  const meResult = await discordFetch('/users/@me');
  if (!meResult.response.ok || !meResult.body?.id) {
    throw new Error(`Discord token check failed (${meResult.response.status}): ${JSON.stringify(meResult.body)}`);
  }

  const applicationId = String(meResult.body.id);
  if (configuredClientId && configuredClientId !== applicationId) {
    console.warn(`[PRESTART_COMMANDS] CLIENT_ID ${configuredClientId} differs from token bot ID ${applicationId}; using token bot ID.`);
  }

  const payloads = await loadPayloads();
  if (!payloads.length || payloads.length > 100) {
    throw new Error(`Invalid global command count: ${payloads.length}; Discord CHAT_INPUT global limit is 100.`);
  }

  const missingFiles = criticalMissing(payloads);
  if (missingFiles.length) throw new Error(`Critical command files missing: ${missingFiles.join(', ')}`);

  // IMPORTANT: never clear commands first. A direct bulk overwrite is idempotent:
  // existing names are updated instead of needlessly consuming create quota.
  const existingResult = await discordFetch(`/applications/${applicationId}/commands`);
  if (!existingResult.response.ok) {
    throw new Error(`Cannot read existing global commands (${existingResult.response.status}): ${JSON.stringify(existingResult.body)}`);
  }

  const existing = Array.isArray(existingResult.body) ? existingResult.body : [];
  const existingMissingCritical = criticalMissing(existing);
  if (existing.length === payloads.length && existingMissingCritical.length === 0) {
    console.log(`[PRESTART_COMMANDS] Existing global command set already healthy: ${existing.length} commands. No write needed.`);
    return;
  }

  console.log(`[PRESTART_COMMANDS] Non-destructive GLOBAL sync: existing=${existing.length}, desired=${payloads.length}, app=${applicationId}.`);

  let syncResult;
  try {
    syncResult = await discordFetch(`/applications/${applicationId}/commands`, {
      method: 'PUT',
      body: JSON.stringify(payloads),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      console.error(`[PRESTART_COMMANDS] Discord command sync timed out after ${REQUEST_TIMEOUT_MS}ms. Bot startup will continue.`);
      return;
    }
    throw error;
  }

  if (syncResult.response.status === 429) {
    const retryAfter = syncResult.body?.retry_after ?? syncResult.response.headers.get('retry-after') ?? 'unknown';
    console.error(`[PRESTART_COMMANDS] RATE_LIMITED by Discord. retry_after=${retryAfter}. Bot startup will continue; DO NOT redeploy/re-register commands until reset.`);
    return;
  }

  if (!syncResult.response.ok) {
    throw new Error(`Global command sync failed (${syncResult.response.status}): ${JSON.stringify(syncResult.body)}`);
  }

  const registered = Array.isArray(syncResult.body) ? syncResult.body : [];
  const missingCritical = criticalMissing(registered);
  if (missingCritical.length) {
    throw new Error(`Discord response missing critical commands: ${missingCritical.join(', ')}`);
  }

  console.log(`[PRESTART_COMMANDS] SUCCESS: Discord accepted ${registered.length} GLOBAL Cloudy commands.`);
}

main().catch((error) => {
  console.error('[PRESTART_COMMANDS] FATAL:', error);
  process.exit(1);
});
