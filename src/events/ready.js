import { Events } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { logger, startupLog } from '../utils/logger.js';
import config from '../config/application.js';
import { reconcileReactionRoleMessages } from '../services/reactionRoleService.js';
import {
  reconcileTicketPanels,
  reconcileVerificationPanels,
  reconcileReactionRolePanelHealth,
} from '../services/panelHealthService.js';
import { reconcileLevelRoles } from '../services/leveling/levelRoleSyncService.js';
import { initRiffyAfterReady } from '../services/music/riffySetup.js';
import { scanProtectedIdentities } from '../services/protectedIdentityService.js';
import { initializeInviteTracking } from '../services/inviteTrackingService.js';

const DISCORD_TEXT_LIMIT = 100;
const MAX_GUILD_COMMANDS = 100;
const OPTIONAL_TASK_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 30_000;
const DISCORD_STUCK_RESTART_MS = 5 * 60_000;

function trimDiscordText(value, maxLength = DISCORD_TEXT_LIMIT) {
  if (typeof value !== 'string') return value;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function sanitizeOption(option) {
  if (!option || typeof option !== 'object') return option;

  const sanitized = { ...option };
  if (typeof sanitized.description === 'string') {
    sanitized.description = trimDiscordText(sanitized.description);
  }

  if (Array.isArray(sanitized.choices)) {
    sanitized.choices = sanitized.choices.map((choice) => ({
      ...choice,
      name: trimDiscordText(choice?.name),
      value: typeof choice?.value === 'string'
        ? trimDiscordText(choice.value)
        : choice?.value,
    }));
  }

  if (Array.isArray(sanitized.options)) {
    sanitized.options = sanitized.options.map(sanitizeOption);
  }

  return sanitized;
}

function buildGuildCommandPayloads(client) {
  const seen = new Set();
  const payloads = [];

  for (const command of client.commands.values()) {
    if (!command?.data || typeof command.data.toJSON !== 'function') continue;

    const payload = command.data.toJSON();
    if (!payload?.name || seen.has(payload.name)) continue;
    seen.add(payload.name);

    if (typeof payload.description === 'string') {
      payload.description = trimDiscordText(payload.description);
    }
    if (Array.isArray(payload.options)) {
      payload.options = payload.options.map(sanitizeOption);
    }

    payload.default_member_permissions = command.adminOnly ? '8' : null;
    payloads.push(payload);
  }

  payloads.sort((a, b) => {
    if (a.name === 'help') return -1;
    if (b.name === 'help') return 1;
    return a.name.localeCompare(b.name);
  });

  if (payloads.length > MAX_GUILD_COMMANDS) {
    throw new Error(
      `Loaded ${payloads.length} top-level slash commands, but Discord allows ${MAX_GUILD_COMMANDS}. ` +
      'Group new functionality under subcommands before deploying.'
    );
  }

  return payloads;
}

async function syncSingleGuildCommands(client, guild, payloads) {
  try {
    const registered = await guild.commands.set(payloads);
    const helpRegistered = registered.some((command) => command.name === 'help');

    startupLog(
      `✅ Slash commands synced atomically in ${guild.name}: ${registered.size}/${payloads.length}`
    );

    return {
      guildId: guild.id,
      guildName: guild.name,
      registered: registered.size,
      failed: [],
      helpRegistered,
      mode: 'atomic',
    };
  } catch (bulkError) {
    const bulkMessage = bulkError?.rawError?.message || bulkError?.message || String(bulkError);
    logger.warn(
      `Atomic slash-command sync failed in ${guild.name}; entering isolated recovery mode: ${bulkMessage}`
    );
  }

  const existing = await guild.commands.fetch().catch(() => null);
  const existingByName = new Map();
  if (existing) {
    for (const command of existing.values()) {
      existingByName.set(command.name, command);
    }
  }

  let registered = 0;
  const failed = [];
  const desiredNames = new Set(payloads.map((payload) => payload.name));

  for (const payload of payloads) {
    try {
      const current = existingByName.get(payload.name);
      if (current) {
        await guild.commands.edit(current.id, payload);
      } else {
        await guild.commands.create(payload);
      }
      registered += 1;
    } catch (error) {
      const message = error?.rawError?.message || error?.message || String(error);
      failed.push({ name: payload.name, message });
      logger.error(
        `Slash command /${payload.name} failed to register in ${guild.name} (${guild.id}): ${message}`,
        error
      );
    }
  }

  if (existing && failed.length === 0) {
    for (const command of existing.values()) {
      if (!desiredNames.has(command.name)) {
        await guild.commands.delete(command.id).catch((error) => {
          logger.warn(`Could not remove stale /${command.name} in ${guild.name}: ${error?.message || error}`);
        });
      }
    }
  }

  const helpRegistered = !failed.some((entry) => entry.name === 'help')
    && (desiredNames.has('help') || existingByName.has('help'));

  startupLog(
    `Slash-command recovery for ${guild.name}: ${registered}/${payloads.length} processed, ${failed.length} failed`
  );

  if (failed.length > 0) {
    logger.warn(
      `Failed slash commands in ${guild.name}: ${failed.map((entry) => `/${entry.name}`).join(', ')}`
    );
  }

  return {
    guildId: guild.id,
    guildName: guild.name,
    registered,
    failed,
    helpRegistered,
    mode: 'isolated-recovery',
  };
}

async function syncGuildCommands(client) {
  const payloads = buildGuildCommandPayloads(client);
  if (payloads.length === 0) {
    throw new Error('No slash command payloads were available to sync');
  }
  if (client.guilds.cache.size === 0) {
    throw new Error('Cloudy is not connected to any Discord guilds');
  }

  const results = [];
  for (const guild of client.guilds.cache.values()) {
    results.push(await syncSingleGuildCommands(client, guild, payloads));
  }

  const successfulGuilds = results.filter(
    (result) => result.helpRegistered && result.registered > 0
  );

  client.commandSyncResults = results;
  client.commandSyncReady = successfulGuilds.length > 0;

  if (!client.commandSyncReady) {
    throw new Error('Slash command sync finished without a working /help command in any guild');
  }

  startupLog(
    `✅ Slash-command core ready in ${successfulGuilds.length}/${results.length} guild(s)`
  );

  return results;
}

function ensureRuntimeHealth(client) {
  client.runtimeHealth ??= {
    startedAt: new Date().toISOString(),
    modules: {},
    discord: {
      ready: client.isReady(),
      disconnectedSince: null,
      lastReadyAt: client.isReady() ? new Date().toISOString() : null,
    },
    eventLoopLagMs: 0,
  };
  return client.runtimeHealth;
}

async function runOptionalTask(client, name, task, timeoutMs = OPTIONAL_TASK_TIMEOUT_MS) {
  const health = ensureRuntimeHealth(client);
  health.modules[name] = {
    status: 'starting',
    updatedAt: new Date().toISOString(),
    error: null,
  };

  let timeout;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timeout.unref?.();
      }),
    ]);

    health.modules[name] = {
      status: 'ok',
      updatedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    health.modules[name] = {
      status: 'degraded',
      updatedAt: new Date().toISOString(),
      error: error?.message || String(error),
    };
    logger.warn(`Optional startup module ${name} failed without taking Cloudy offline: ${error?.message || error}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function startSelfHealingWatchdog(client) {
  if (client.cloudyWatchdogInterval) return;

  const health = ensureRuntimeHealth(client);
  let disconnectedSince = null;

  client.cloudyWatchdogInterval = setInterval(() => {
    const scheduledAt = Date.now();

    setTimeout(() => {
      health.eventLoopLagMs = Math.max(0, Date.now() - scheduledAt);
    }, 0).unref?.();

    if (client.isReady()) {
      disconnectedSince = null;
      health.discord.ready = true;
      health.discord.disconnectedSince = null;
      health.discord.lastReadyAt = new Date().toISOString();
      return;
    }

    health.discord.ready = false;
    if (!disconnectedSince) {
      disconnectedSince = Date.now();
      health.discord.disconnectedSince = new Date(disconnectedSince).toISOString();
      logger.warn('Discord connection is not Ready; watchdog started recovery timer.');
      return;
    }

    const disconnectedFor = Date.now() - disconnectedSince;
    if (disconnectedFor >= DISCORD_STUCK_RESTART_MS) {
      logger.error(
        `Discord has been non-ready for ${Math.round(disconnectedFor / 1000)}s. ` +
        'Exiting so Railway can perform a clean restart.'
      );
      process.exit(1);
    }
  }, WATCHDOG_INTERVAL_MS);

  client.cloudyWatchdogInterval.unref?.();
  startupLog('✅ Self-healing Discord watchdog enabled');
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    client.commandSyncReady = false;
    ensureRuntimeHealth(client);
    startSelfHealingWatchdog(client);

    startupLog(`Ready! Logged in as ${client.user.tag}`);
    startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
    startupLog(`Loaded ${client.commands.size} commands`);

    await runOptionalTask(client, 'presence', async () => {
      let presence = config.bot.presence;
      try {
        presence = await client.db?.get?.('global:bot:profile:presence') || presence;
      } catch {
        // use configured presence
      }
      client.user.setPresence(presence);
    }, 10_000);

    try {
      await syncGuildCommands(client);
    } catch (error) {
      client.commandSyncReady = false;
      logger.error('Critical slash-command sync failed:', error);
    }

    const optionalTasks = [
      runOptionalTask(client, 'profile-avatar', async () => {
        const avatarVersion = 'cloudy-c-transparent-v1';
        const savedAvatarVersion = await client.db?.get?.('global:bot:profile:avatar-version');
        if (savedAvatarVersion === avatarVersion) return;

        const avatarBuffer = await readFile(
          new URL('../../assets/cloudy-c-logo.png', import.meta.url)
        );
        await client.user.setAvatar(avatarBuffer);
        await client.db?.set?.('global:bot:profile:avatar-version', avatarVersion);
        startupLog('Cloudy C bot profile picture updated');
      }, 20_000),

      runOptionalTask(client, 'protected-identity-scan', () => scanProtectedIdentities(client)),
      runOptionalTask(client, 'invite-tracking', () => initializeInviteTracking(client)),
      runOptionalTask(client, 'reaction-role-reconcile', async () => {
        const summary = await reconcileReactionRoleMessages(client);
        startupLog(
          `Reaction role reconciliation: scanned ${summary.scannedMessages}, removed ${summary.removedMessages}, errors ${summary.errors}`
        );
      }),
      runOptionalTask(client, 'ticket-panel-health', async () => {
        const summary = await reconcileTicketPanels(client);
        startupLog(
          `Ticket panel health: scanned ${summary.scannedGuilds} guilds, healthy ${summary.healthyPanels}, deleted ${summary.deletedPanels}, recovered ${summary.recoveredIds}, errors ${summary.errors}`
        );
      }),
      runOptionalTask(client, 'verification-panel-health', async () => {
        const summary = await reconcileVerificationPanels(client);
        startupLog(
          `Verification panel health: scanned ${summary.scannedGuilds} guilds, healthy ${summary.healthyPanels}, deleted ${summary.deletedPanels}, recovered ${summary.recoveredIds}, errors ${summary.errors}`
        );
      }),
      runOptionalTask(client, 'reaction-role-panel-health', async () => {
        const summary = await reconcileReactionRolePanelHealth(client);
        startupLog(
          `Reaction role panel health: scanned ${summary.scannedPanels} panels, healthy ${summary.healthyPanels}, deleted ${summary.deletedPanels}, recovered ${summary.recoveredIds}, errors ${summary.errors}`
        );
      }),
      runOptionalTask(client, 'level-role-sync', async () => {
        const summary = await reconcileLevelRoles(client);
        startupLog(
          `Level role sync: scanned ${summary.scannedGuilds} guilds, pruned ${summary.prunedRewardEntries} stale rewards, re-awarded ${summary.rolesReAwarded} roles, errors ${summary.errors}`
        );
      }),
    ];

    if (client.config?.features?.music) {
      optionalTasks.push(
        runOptionalTask(client, 'music-ready', () => initRiffyAfterReady(client), 20_000)
      );
    }

    await Promise.all(optionalTasks);

    if (client.commandSyncReady) {
      startupLog('✅ Cloudy core is ready; optional module failures will not interrupt commands.');
    }
  },
};
