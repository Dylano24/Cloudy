import { logger } from '../utils/logger.js';

const GLOBAL_CHAT_INPUT_LIMIT = 100;
const GUILD_CHAT_INPUT_LIMIT = 100;

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

export async function syncGuildCommandOverflow(client, guildId) {
  if (!client?.rest || !client?.user?.id || !guildId) {
    throw new Error('Cannot sync guild command overflow before Discord is ready');
  }

  const allPayloads = collectUniqueCommandPayloads(client);
  const overflow = allPayloads.slice(GLOBAL_CHAT_INPUT_LIMIT);

  if (overflow.length > GUILD_CHAT_INPUT_LIMIT) {
    throw new Error(
      `Cloudy has ${allPayloads.length} unique top-level commands. ` +
      `The first ${GLOBAL_CHAT_INPUT_LIMIT} fit globally, but ${overflow.length} remain; ` +
      `Discord allows only ${GUILD_CHAT_INPUT_LIMIT} additional guild commands.`
    );
  }

  const route = `/applications/${client.user.id}/guilds/${guildId}/commands`;
  const result = await client.rest.put(route, { body: overflow });

  const returnedNames = new Set(result.map((command) => command.name));
  const missing = overflow
    .map((command) => command.name)
    .filter((name) => !returnedNames.has(name));

  if (missing.length > 0) {
    throw new Error(`Discord did not return overflow commands: ${missing.join(', ')}`);
  }

  logger.info(
    `[COMMAND_OVERFLOW] Synced ${result.length} guild-only commands for guild ${guildId}; ` +
    `${Math.min(allPayloads.length, GLOBAL_CHAT_INPUT_LIMIT)} remain in the original global scope.`
  );

  return {
    totalLoaded: allPayloads.length,
    globalCount: Math.min(allPayloads.length, GLOBAL_CHAT_INPUT_LIMIT),
    guildCount: result.length,
  };
}

export async function syncGuildCommandOverflowForAllGuilds(client) {
  const summaries = [];

  for (const guild of client.guilds.cache.values()) {
    try {
      summaries.push({
        guildId: guild.id,
        ...(await syncGuildCommandOverflow(client, guild.id)),
      });
    } catch (error) {
      logger.error(`[COMMAND_OVERFLOW] Failed for guild ${guild.id}:`, error);
      throw error;
    }
  }

  return summaries;
}
