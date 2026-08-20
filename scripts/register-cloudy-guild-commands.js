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
const PRIORITY = [
  'help',
  'ban', 'unban', 'timeout', 'untimeout', 'kick', 'warn', 'warnings',
  'cases', 'lock', 'unlock', 'purge', 'dm', 'massban', 'masskick', 'say', 'usernotes',
  'ticket', 'close', 'claim', 'priority',
];
const MAX_RUNTIME_MS = 23 * 60 * 60 * 1000;
const PERMANENT_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

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
      // Only implementation-module folders are excluded. Every real command
      // directory, including Leveling, is part of the 100-command production set.
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
      payloads.push(payload);
    } catch (error) {
      console.error(`[COMMAND_RECOVERY] Failed loading ${file}: ${error.message}`);
    }
  }

  return payloads;
}

function retryAfterSeconds(result) {
  const raw = result?.body?.retry_after ?? result?.response?.headers?.get?.('retry-after');
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sortRecoveryQueue(payloads, existingNames) {
  const byName = new Map(payloads.map((payload) => [payload.name, payload]));
  const queue = [];

  for (const name of PRIORITY) {
    if (!existingNames.has(name) && byName.has(name)) {
      queue.push(byName.get(name));
      byName.delete(name);
    }
  }

  const rest = [...byName.values()]
    .filter((payload) => !existingNames.has(payload.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...queue, ...rest];
}

async function main() {
  const startedAt = Date.now();
  const blockedUntil = new Map();

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

  const route = `/applications/${applicationId}/guilds/${guildId}/commands`;
  console.log(`[COMMAND_RECOVERY] Incremental recovery started: app=${applicationId}, guild=${guildId}, desired=${payloads.length}.`);
  console.log(`[COMMAND_RECOVERY] Priority order: ${PRIORITY.join(', ')}.`);

  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    let current;
    try {
      current = await discordFetch(route);
    } catch (error) {
      console.error(`[COMMAND_RECOVERY] GET failed: ${error.message}; retrying in 60s.`);
      await sleep(60000);
      continue;
    }

    if (!current.response.ok || !Array.isArray(current.body)) {
      const retryAfter = retryAfterSeconds(current);
      if (current.response.status === 429) {
        const waitSeconds = Math.max(5, Math.ceil((retryAfter ?? 60) + 2));
        console.warn(`[COMMAND_RECOVERY] GET rate-limited; waiting ${waitSeconds}s.`);
        await sleep(waitSeconds * 1000);
        continue;
      }
      console.error(`[COMMAND_RECOVERY] GET rejected HTTP ${current.response.status}: ${JSON.stringify(current.body)}; retrying in 5m.`);
      await sleep(5 * 60 * 1000);
      continue;
    }

    const existingNames = new Set(current.body.map((command) => command.name));
    const fullQueue = sortRecoveryQueue(payloads, existingNames);

    if (!fullQueue.length) {
      console.log(`[COMMAND_RECOVERY] COMPLETE: all ${payloads.length} Cloudy guild commands are registered.`);
      return;
    }

    const now = Date.now();
    const queue = fullQueue.filter((payload) => (blockedUntil.get(payload.name) || 0) <= now);

    if (!queue.length) {
      const earliest = Math.min(...fullQueue.map((payload) => blockedUntil.get(payload.name) || (now + 60000)));
      const waitMs = Math.max(5000, Math.min(earliest - now, 5 * 60 * 1000));
      console.warn(`[COMMAND_RECOVERY] All currently missing commands are temporarily deferred; checking again in ${Math.ceil(waitMs / 1000)}s.`);
      await sleep(waitMs);
      continue;
    }

    const next = queue[0];
    console.log(
      `[COMMAND_RECOVERY] Progress ${existingNames.size}/${payloads.length}. Next command: /${next.name}. Remaining=${fullQueue.length}.`
    );

    let create;
    try {
      create = await discordFetch(route, {
        method: 'POST',
        body: JSON.stringify(next),
      });
    } catch (error) {
      console.error(`[COMMAND_RECOVERY] POST /${next.name} failed: ${error.message}; retrying in 60s.`);
      await sleep(60000);
      continue;
    }

    if (create.response.ok && create.body?.name === next.name) {
      blockedUntil.delete(next.name);
      console.log(`[COMMAND_RECOVERY] RESTORED /${next.name}. Discord now has at least ${existingNames.size + 1}/${payloads.length} Cloudy commands.`);
      await sleep(1500);
      continue;
    }

    const retryAfter = retryAfterSeconds(create);
    const apiCode = Number(create.body?.code);

    if (create.response.status === 429) {
      const waitSeconds = Math.max(5, Math.ceil((retryAfter ?? 432) + 2));
      console.warn(
        `[COMMAND_RECOVERY] CREATE_QUOTA: /${next.name} must wait ${waitSeconds}s (retry_after=${retryAfter ?? 'unknown'}). ` +
        'Cloudy remains online; this command will be retried automatically.'
      );
      await sleep(waitSeconds * 1000);
      continue;
    }

    if (apiCode === 30034) {
      console.warn(
        `[COMMAND_RECOVERY] DAILY_CREATE_LIMIT 30034 while restoring /${next.name}. ` +
        'Waiting 10 minutes before checking for the next available create token.'
      );
      await sleep(10 * 60 * 1000);
      continue;
    }

    blockedUntil.set(next.name, Date.now() + PERMANENT_FAILURE_BACKOFF_MS);
    console.error(
      `[COMMAND_RECOVERY] Discord rejected /${next.name}: HTTP ${create.response.status}, body=${JSON.stringify(create.body)}. ` +
      'That command is deferred for 30 minutes so it cannot block recovery of the others.'
    );
    await sleep(1500);
  }

  console.warn('[COMMAND_RECOVERY] 23-hour recovery window ended. Restart/redeploy later only if commands are still missing.');
}

main().catch((error) => {
  console.error('[COMMAND_RECOVERY] FATAL:', error);
  process.exitCode = 1;
});
