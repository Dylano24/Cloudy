import { Events } from "discord.js";
import { readFile } from "node:fs/promises";
import { logger, startupLog } from "../utils/logger.js";
import config from "../config/application.js";
import { reconcileReactionRoleMessages } from "../services/reactionRoleService.js";
import { reconcileTicketPanels, reconcileVerificationPanels, reconcileReactionRolePanelHealth } from "../services/panelHealthService.js";
import { reconcileLevelRoles } from "../services/leveling/levelRoleSyncService.js";
import { initRiffyAfterReady } from "../services/music/riffySetup.js";
import { startRustPatchNotes } from "../services/rustPatchNotesService.js";
import { scanProtectedIdentities } from "../services/protectedIdentityService.js";
import { initializeInviteTracking } from "../services/inviteTrackingService.js";

const DISCORD_TEXT_LIMIT = 100;
const MAX_GUILD_COMMANDS = 100;

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

    if (command.adminOnly && !payload.default_member_permissions) {
      payload.default_member_permissions = '8';
    }

    payloads.push(payload);
  }

  // Always put /help first. If another command is malformed or the bot ever
  // reaches Discord's 100-command guild limit, /help must still be available.
  payloads.sort((a, b) => {
    if (a.name === 'help') return -1;
    if (b.name === 'help') return 1;
    return a.name.localeCompare(b.name);
  });

  if (payloads.length > MAX_GUILD_COMMANDS) {
    logger.warn(`Discord allows at most ${MAX_GUILD_COMMANDS} guild commands; syncing the first ${MAX_GUILD_COMMANDS} of ${payloads.length}.`);
  }

  return payloads.slice(0, MAX_GUILD_COMMANDS);
}

async function syncSingleGuildCommands(client, guild, payloads) {
  let cleared = false;

  try {
    await guild.commands.set([]);
    cleared = true;
    startupLog(`Cleared stale guild commands in ${guild.name} (${guild.id})`);
  } catch (error) {
    logger.warn(`Could not clear stale guild commands in ${guild.name} (${guild.id}): ${error?.message || error}`);
  }

  let registered = 0;
  const failed = [];

  // Register commands one-by-one. A single malformed command can no longer
  // make Discord reject the entire command set.
  for (const payload of payloads) {
    try {
      await guild.commands.create(payload);
      registered += 1;
    } catch (error) {
      const message = error?.rawError?.message || error?.message || String(error);
      failed.push({ name: payload.name, message });
      logger.error(`Slash command /${payload.name} failed to register in ${guild.name} (${guild.id}): ${message}`, error);
    }
  }

  const helpRegistered = registered > 0 && !failed.some((entry) => entry.name === 'help');

  startupLog(
    `Slash command sync for ${guild.name}: ${registered}/${payloads.length} registered, ${failed.length} failed${cleared ? '' : ', stale clear failed'}`
  );

  if (failed.length > 0) {
    logger.warn(`Failed slash commands in ${guild.name}: ${failed.map((entry) => `/${entry.name}`).join(', ')}`);
  }

  return {
    guildId: guild.id,
    guildName: guild.name,
    registered,
    failed,
    helpRegistered,
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

  const successfulGuilds = results.filter((result) => result.helpRegistered && result.registered > 0);
  client.commandSyncReady = successfulGuilds.length > 0;
  client.commandSyncResults = results;

  if (!client.commandSyncReady) {
    throw new Error('Slash command sync finished without registering /help in any guild');
  }

  startupLog(`✅ Slash command recovery complete in ${successfulGuilds.length}/${results.length} guild(s)`);
  return results;
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.commandSyncReady = false;

      let presence = config.bot.presence;
      try {
        presence = await client.db.get('global:bot:profile:presence') || presence;
      } catch (error) {
        logger.warn('Could not load saved bot presence; using configured presence.', error);
      }
      client.user.setPresence(presence);

      try {
        const avatarVersion = 'cloudy-c-transparent-v1';
        const savedAvatarVersion = await client.db.get('global:bot:profile:avatar-version');

        if (savedAvatarVersion !== avatarVersion) {
          const avatarBuffer = await readFile(
            new URL('../../assets/cloudy-c-logo.png', import.meta.url)
          );
          await client.user.setAvatar(avatarBuffer);
          await client.db.set('global:bot:profile:avatar-version', avatarVersion);
          startupLog('Cloudy C bot profile picture updated');
        }
      } catch (error) {
        logger.warn('Could not update Cloudy bot profile picture.', error);
      }

      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
      startupLog(`Loaded ${client.commands.size} commands`);

      // Rebuild the server command installation every time the bot becomes
      // ready. This repairs command state after the bot was removed/re-added.
      await syncGuildCommands(client);

      startRustPatchNotes(client);
      void scanProtectedIdentities(client);
      await initializeInviteTracking(client);

      if (client.config?.features?.music) {
        initRiffyAfterReady(client);
      }

      const reconciliationSummary = await reconcileReactionRoleMessages(client);
      startupLog(
        `Reaction role reconciliation: scanned ${reconciliationSummary.scannedMessages}, removed ${reconciliationSummary.removedMessages}, errors ${reconciliationSummary.errors}`
      );

      const ticketPanelSummary = await reconcileTicketPanels(client);
      startupLog(
        `Ticket panel health: scanned ${ticketPanelSummary.scannedGuilds} guilds, healthy ${ticketPanelSummary.healthyPanels}, deleted ${ticketPanelSummary.deletedPanels}, missing channel ${ticketPanelSummary.missingChannels}, recovered ${ticketPanelSummary.recoveredIds}, errors ${ticketPanelSummary.errors}`
      );

      const verificationPanelSummary = await reconcileVerificationPanels(client);
      startupLog(
        `Verification panel health: scanned ${verificationPanelSummary.scannedGuilds} guilds, healthy ${verificationPanelSummary.healthyPanels}, deleted ${verificationPanelSummary.deletedPanels}, missing channel ${verificationPanelSummary.missingChannels}, recovered ${verificationPanelSummary.recoveredIds}, errors ${verificationPanelSummary.errors}`
      );

      const reactionRolePanelSummary = await reconcileReactionRolePanelHealth(client);
      startupLog(
        `Reaction role panel health: scanned ${reactionRolePanelSummary.scannedPanels} panels, healthy ${reactionRolePanelSummary.healthyPanels}, deleted ${reactionRolePanelSummary.deletedPanels}, missing channel ${reactionRolePanelSummary.missingChannels}, recovered ${reactionRolePanelSummary.recoveredIds}, errors ${reactionRolePanelSummary.errors}`
      );

      const levelRoleSummary = await reconcileLevelRoles(client);
      startupLog(
        `Level role sync: scanned ${levelRoleSummary.scannedGuilds} guilds, pruned ${levelRoleSummary.prunedRewardEntries} stale rewards, re-awarded ${levelRoleSummary.rolesReAwarded} roles, errors ${levelRoleSummary.errors}`
      );
    } catch (error) {
      client.commandSyncReady = false;
      logger.error("Error in ready event:", error);
    }
  },
};
