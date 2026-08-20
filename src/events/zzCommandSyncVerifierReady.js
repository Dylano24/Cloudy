import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';

const VERIFY_DELAY_MS = 12_000;
const RETRY_DELAY_MS = 3_000;
const MAX_VERIFY_ATTEMPTS = 3;
const MAX_COMMANDS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildExpectedPayloads(client) {
  const payloads = [];
  const seen = new Set();

  for (const command of client.commands.values()) {
    if (!command?.data || typeof command.data.toJSON !== 'function') continue;

    const payload = command.data.toJSON();
    const name = String(payload?.name || '').toLowerCase();
    if (!name || seen.has(name)) continue;

    seen.add(name);
    payload.default_member_permissions = command.adminOnly ? '8' : null;
    payloads.push(payload);
  }

  if (payloads.length > MAX_COMMANDS) {
    throw new Error(`Cloudy has ${payloads.length} top-level slash commands; Discord allows ${MAX_COMMANDS}.`);
  }

  payloads.sort((a, b) => a.name.localeCompare(b.name));
  return payloads;
}

function compareCommandNames(expectedPayloads, actualCommands) {
  const expected = new Set(expectedPayloads.map((payload) => payload.name));
  const actual = new Set([...actualCommands.values()].map((command) => command.name));

  return {
    missing: [...expected].filter((name) => !actual.has(name)).sort(),
    stale: [...actual].filter((name) => !expected.has(name)).sort(),
    expectedCount: expected.size,
    actualCount: actual.size,
  };
}

async function verifyGuild(client, guild, expectedPayloads) {
  let lastComparison = null;

  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt += 1) {
    const actual = await guild.commands.fetch();
    const comparison = compareCommandNames(expectedPayloads, actual);
    lastComparison = comparison;

    if (comparison.missing.length === 0 && comparison.stale.length === 0) {
      startupLog(
        `✅ Command verification passed in ${guild.name}: ${comparison.actualCount}/${comparison.expectedCount} commands present`
      );
      return comparison;
    }

    logger.warn(
      `Command verification mismatch in ${guild.name} (attempt ${attempt}/${MAX_VERIFY_ATTEMPTS}): ` +
      `missing=[${comparison.missing.join(', ') || 'none'}], stale=[${comparison.stale.join(', ') || 'none'}]`
    );

    // Replace the guild command set atomically. This both restores missing
    // commands and removes stale commands left by older Cloudy deployments.
    await guild.commands.set(expectedPayloads);

    if (attempt < MAX_VERIFY_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `Discord command verification failed in ${guild.name}: ` +
    `${lastComparison?.actualCount ?? 0}/${lastComparison?.expectedCount ?? expectedPayloads.length} present; ` +
    `missing=${lastComparison?.missing?.join(', ') || 'unknown'}; ` +
    `stale=${lastComparison?.stale?.join(', ') || 'unknown'}`
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    // Give the normal ready handler enough time to do its first command sync.
    await sleep(VERIFY_DELAY_MS);

    try {
      const expectedPayloads = buildExpectedPayloads(client);
      if (expectedPayloads.length === 0) {
        throw new Error('No commands were loaded into client.commands.');
      }

      if (client.guilds.cache.size === 0) {
        throw new Error('Cloudy is connected to zero guilds.');
      }

      const results = [];
      for (const guild of client.guilds.cache.values()) {
        results.push(await verifyGuild(client, guild, expectedPayloads));
      }

      client.commandVerification = {
        ok: true,
        expectedCount: expectedPayloads.length,
        verifiedAt: new Date().toISOString(),
        guilds: results,
      };
      client.commandSyncReady = true;

      startupLog(
        `✅ ALL slash commands verified: ${expectedPayloads.length} expected and present in every connected guild`
      );
    } catch (error) {
      client.commandSyncReady = false;
      client.commandVerification = {
        ok: false,
        error: error?.message || String(error),
        verifiedAt: new Date().toISOString(),
      };

      logger.error('❌ Slash command verification failed after automatic repair:', error);
      logger.error('Cloudy will restart instead of staying online with missing commands.');

      setTimeout(() => process.exit(1), 1_000).unref?.();
    }
  },
};
