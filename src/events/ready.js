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
import { reconcileTermsMessage } from "../services/termsMessageService.js";
import { reconcileStoreTermsMessage } from "../services/storeTermsMessageService.js";
import { ensureSystemEmbedCatalogs } from "../services/systemEmbedCatalogService.js";
import { scheduleCloudyLogoMigration } from './cloudyLogoMigrationReady.js';

async function runReadyStep(label, task) {
  try {
    return await task();
  } catch (error) {
    logger.error(`[READY] ${label} failed:`, error);
    return null;
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    // This startup path is always present. The scheduler is also invoked by
    // its dedicated ready handler, but it is idempotent so this guarantees the
    // one-time CDN swap starts without ever running twice.
    scheduleCloudyLogoMigration(client);

    let presence = config.bot.presence;
    try {
      presence = await client.db.get('global:bot:profile:presence') || presence;
    } catch (error) {
      logger.warn('Could not load saved bot presence; using configured presence.', error);
    }

    // Never allow a stale saved "invisible" state to make a healthy production
    // bot look offline after a Railway restart. Admins can still choose idle/DND.
    if (!presence || typeof presence !== 'object') {
      presence = config.bot.presence;
    }
    if (presence.status === 'invisible') {
      presence = { ...presence, status: 'online' };
      await client.db.set('global:bot:profile:presence', presence).catch(() => {});
      logger.warn('[READY] Replaced saved invisible presence with online status.');
    }

    try {
      client.user.setPresence(presence);
    } catch (error) {
      logger.warn('Could not apply saved bot presence; forcing online status.', error);
      client.user.setPresence({ ...config.bot.presence, status: 'online' });
    }

    await runReadyStep('bot avatar sync', async () => {
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
    });

    startupLog(`Ready! Logged in as ${client.user.tag}`);
    startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
    startupLog(`Loaded ${client.commands.size} commands`);

    // Keep the Embed Builder master list synchronized independently from the
    // rest of startup so every static, temporary and runtime embed can appear.
    void runReadyStep('embed builder catalog sync', () => ensureSystemEmbedCatalogs(client))
      .then(() => logger.info('[READY] Embed builder catalog sync complete.'));

    // Every subsystem is isolated so one optional feature can never prevent the
    // rest of Cloudy from finishing its startup sequence.
    startRustPatchNotes(client);

    void scanProtectedIdentities(client).catch((error) => {
      logger.error('[READY] protected identity scan failed:', error);
    });

    await runReadyStep('Terms of Service message sync', () => reconcileTermsMessage(client));
    await runReadyStep('Store terms of sale message sync', () => reconcileStoreTermsMessage(client));
    await runReadyStep('invite tracking initialization', () => initializeInviteTracking(client));

    if (client.config?.features?.music) {
      await runReadyStep('music/Riffy initialization', async () => initRiffyAfterReady(client));
    }

    const reconciliationSummary = await runReadyStep(
      'reaction role reconciliation',
      () => reconcileReactionRoleMessages(client),
    );
    if (reconciliationSummary) {
      startupLog(
        `Reaction role reconciliation: scanned ${reconciliationSummary.scannedMessages}, removed ${reconciliationSummary.removedMessages}, errors ${reconciliationSummary.errors}`
      );
    }

    const ticketPanelSummary = await runReadyStep(
      'ticket panel reconciliation',
      () => reconcileTicketPanels(client),
    );
    if (ticketPanelSummary) {
      startupLog(
        `Ticket panel health: scanned ${ticketPanelSummary.scannedGuilds} guilds, healthy ${ticketPanelSummary.healthyPanels}, deleted ${ticketPanelSummary.deletedPanels}, missing channel ${ticketPanelSummary.missingChannels}, recovered ${ticketPanelSummary.recoveredIds}, errors ${ticketPanelSummary.errors}`
      );
    }

    const verificationPanelSummary = await runReadyStep(
      'verification panel health',
      () => reconcileVerificationPanels(client),
    );
    if (verificationPanelSummary) {
      startupLog(
        `Verification panel health: scanned ${verificationPanelSummary.scannedGuilds} guilds, healthy ${verificationPanelSummary.healthyPanels}, deleted ${verificationPanelSummary.deletedPanels}, missing channel ${verificationPanelSummary.missingChannels}, recovered ${verificationPanelSummary.recoveredIds}, errors ${verificationPanelSummary.errors}`
      );
    }

    const reactionRolePanelSummary = await runReadyStep(
      'reaction role panel health',
      () => reconcileReactionRolePanelHealth(client),
    );
    if (reactionRolePanelSummary) {
      startupLog(
        `Reaction role panel health: scanned ${reactionRolePanelSummary.scannedPanels} panels, healthy ${reactionRolePanelSummary.healthyPanels}, deleted ${reactionRolePanelSummary.deletedPanels}, missing channel ${reactionRolePanelSummary.missingChannels}, recovered ${reactionRolePanelSummary.recoveredIds}, errors ${reactionRolePanelSummary.errors}`
      );
    }

    const levelRoleSummary = await runReadyStep(
      'level role reconciliation',
      () => reconcileLevelRoles(client),
    );
    if (levelRoleSummary) {
      startupLog(
        `Level role sync: scanned ${levelRoleSummary.scannedGuilds} guilds, pruned ${levelRoleSummary.prunedRewardEntries} stale rewards, re-awarded ${levelRoleSummary.rolesReAwarded} roles, errors ${levelRoleSummary.errors}`
      );
    }
  },
};
