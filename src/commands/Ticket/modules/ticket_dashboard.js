import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import { recoverTicketDashboardConfig } from '../../../services/ticketDashboardRecoveryService.js';
import { logger } from '../../../utils/logger.js';

export default {
    prefixOnly: false,

    async execute(interaction, recoveredConfig, client) {
        // Never block the visible dashboard on database reads, channel scans or
        // legacy-panel recovery. The command router already supplied the latest
        // config it has; render that immediately.
        const guildConfig = recoveredConfig && typeof recoveredConfig === 'object'
            ? recoveredConfig
            : {};

        await InteractionHelper.safeEditReply(
            interaction,
            buildTicketDashboardPayload(interaction.guild, guildConfig),
        );

        // Recovery is useful, but it must never make the user stare at a loading
        // interaction. Persist any recovered panel/config in the background.
        if (!guildConfig?.ticketPanelChannelId) {
            void recoverTicketDashboardConfig(
                client,
                interaction.guild,
                interaction.channelId,
            ).catch(error => {
                logger.warn('Background ticket dashboard recovery failed', {
                    guildId: interaction.guildId,
                    error: error.message,
                });
            });
        }
    },
};
