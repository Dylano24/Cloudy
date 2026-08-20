import { logger } from '../utils/logger.js';

const GLOBAL_CHAT_INPUT_LIMIT = 100;
const GUILD_CHAT_INPUT_LIMIT = 100;
const CRITICAL_COMMANDS = [
  'help',
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'warn',
  'ticket',
];

function collectUniqueCommandPayloads(client) {
  const payloads = [];
  const seen = new Set();

  for (const command of client.commands.values()) {
    if (!command?.data || typeof command.data.toJSON !== 'function') {
      continue;
    }

    const payload = command.data.toJSON();
    const name = payload?.name;
    if (!name || seen.has(name)) {
      continue;
    }

    seen.add(name);

    // Match the original 06:00 commandLoader permission behavior exactly.
    if (command.adminOnly && !payload.default_member_permissions) {
      payload.default_member_permissions = '8';
    }

    payloads.push(payload);
  }

  return payloads;
}

function splitPayloads(allPayloads) {
  const globalPayloads = allPayloads.slice(0, GLOBAL_CHAT_INPUT_LIMIT);
  const guildPayloads = allPayloads.slice(GLOBAL_CHAT_INPUT_LIMIT);

  if (guildPayloads.length > GUILD_CHAT_INPUT_LIMIT) {
    throw new Error(
      `Cloudy has ${allPayloads.length} unique top-level commands. ` +
      `Discord capacity is ${GLOBAL_CHAT_INPUT_LIMIT} global + ${GUILD_CHAT_INPUT_LIMIT} guild commands.`
    );
  }

  const loadedNames = new Set(allPayloads.map((command) => command.name));
  const missingCriticalFiles = CRITICAL_COMMANDS.filter((name) => !loadedNames.has(name));
  if (missingCriticalFiles.length > 0) {
    throw new Error(
      `Critical commands were not loaded from GitHub: ${missingCriticalFiles.join(', ')}`
    );
  }

  return { globalPayloads, guildPayloads };
}

function verifyResult(scope, expectedPayloads, result) {
  const returnedNames = new Set(result.map((command) => command.name));
  const missing = expectedPayloads
    .map((command) => command.name)
    .filter((name) => !returnedNames.has(name));

  if (missing.length > 0) {
    throw new Error(`Discord ${scope} sync did not return: ${missing.join(', ')}`);
  }
}

export async function syncGlobalCommandBase(client) {
  if (!client?.rest || !client?.user?.id) {
    throw new Error('Cannot sync global commands before Discord is ready');
  }

  const allPayloads = collectUniqueCommandPayloads(client);
  const { globalPayloads } = splitPayloads(allPayloads);
  const route = `/applications/${client.user.id}/commands`;
  const result = await client.rest.put(route, { body: globalPayloads });

  verifyResult('global', globalPayloads, result);
  logger.info(`[COMMAND_SYNC] Verified ${result.length} global Cloudy commands.`);

  return {
    totalLoaded: allPayloads.length,
    globalCount: result.length,
  };
}

export async function syncGuildCommandOverflow(client, guildId) {
  if (!client?.rest || !client?.user?.id || !guildId) {
    throw new Error('Cannot sync guild command overflow before Discord is ready');
  }

  const allPayloads = collectUniqueCommandPayloads(client);
  const { globalPayloads, guildPayloads } = splitPayloads(allPayloads);
  const route = `/applications/${client.user.id}/guilds/${guildId}/commands`;
  const result = await client.rest.put(route, { body: guildPayloads });

  verifyResult(`guild ${guildId}`, guildPayloads, result);

  const allRegisteredNames = new Set([
    ...globalPayloads.map((command) => command.name),
    ...guildPayloads.map((command) => command.name),
  ]);
  const missingCritical = CRITICAL_COMMANDS.filter((name) => !allRegisteredNames.has(name));
  if (missingCritical.length > 0) {
    throw new Error(`Critical Cloudy commands missing after split: ${missingCritical.join(', ')}`);
  }

  logger.info(
    `[COMMAND_SYNC] Verified ${result.length} guild-only commands for guild ${guildId}; ` +
    `${globalPayloads.length} commands are in the global scope.`
  );

  return {
    totalLoaded: allPayloads.length,
    globalCount: globalPayloads.length,
    guildCount: result.length,
  };
}

export async function syncGuildCommandOverflowForAllGuilds(client) {
  // Re-assert the first 100 as well. The legacy 06:00 loader remains untouched,
  // but this second pass proves Discord actually accepted the complete split.
  await syncGlobalCommandBase(client);

  const summaries = [];
  for (const guild of client.guilds.cache.values()) {
    try {
      summaries.push({
        guildId: guild.id,
        ...(await syncGuildCommandOverflow(client, guild.id)),
      });
    } catch (error) {
      logger.error(`[COMMAND_SYNC] Failed for guild ${guild.id}:`, error);
      throw error;
    }
  }

  return summaries;
}
