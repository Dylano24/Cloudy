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
