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

  if (payloads.length > MAX_GUILD_COMMANDS) {
    logger.warn(`Discord allows at most ${MAX_GUILD_COMMANDS} guild commands; syncing the first ${MAX_GUILD_COMMANDS} of ${payloads.length}.`);
  }

  return payloads.slice(0, MAX_GUILD_COMMANDS);
}

async function syncGuildCommands(client) {
  const payloads = buildGuildCommandPayloads(client);
  if (payloads.length === 0) {
    throw new Error('No slash command payloads were available to sync');
  }

  if (client.guilds.cache.size === 0) {
    throw new Error('Cloudy is not connected to any Discord guilds');
  }

  for (const guild of client.guilds.cache.values()) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const registered = await guild.commands.set(payloads);
        startupLog(`✅ Slash command sync: ${registered.size} commands registered in ${guild.name} (${guild.id})`);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        logger.warn(`Slash command sync attempt ${attempt}/3 failed for ${guild.name} (${guild.id}): ${error?.message || error}`);
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        }
      }
    }

    if (lastError) {
      logger.error(`❌ Slash commands could not be registered in ${guild.name} (${guild.id}). Re-authorize Cloudy with the applications.commands scope.`, lastError);
    }
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
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

      // A bot that was removed and re-added can have stale or missing guild
      // command state. Sync after ClientReady so we use the guilds Discord says
      // Cloudy is actually installed in, instead of relying on an old GUILD_ID.
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
      logger.error("Error in ready event:", error);
    }
  },
};
