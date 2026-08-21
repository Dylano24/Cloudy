import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import { recoverTicketDashboardConfig } from '../../../services/ticketDashboardRecoveryService.js';
import { refreshAllTicketChannels } from '../../../services/ticketChannelBrowserService.js';
import { logger } from '../../../utils/logger.js';

export default {
    prefixOnly: false,

    async execute(interaction, recoveredConfig, client) {
        // Render immediately from the config already supplied by the command
        // router. Never block the visible dashboard on channel scans/recovery.
        const guildConfig = recoveredConfig && typeof recoveredConfig === 'object'
            ? recoveredConfig
            : {};

        await InteractionHelper.safeEditReply(
            interaction,
            buildTicketDashboardPayload(interaction.guild, guildConfig),
        );

        // Warm the complete channel cache in the background. This keeps every
        // dashboard click fast while ensuring newly-created/private channels are
        // available when the user opens a channel setting.
        void refreshAllTicketChannels(interaction.guild).catch(() => {});

        if (!guildConfig?.ticketPanelChannelId) {
            void (async () => {
                try {
                    const recovered = await recoverTicketDashboardConfig(
                        client,
                        interaction.guild,
                        interaction.channelId,
                    );

                    // Recovery must update the dashboard the user is already
                    // looking at; requiring them to rerun /ticket dashboard made
                    // valid settings appear as "Not set" indefinitely.
                    if (recovered && interaction.deferred) {
                        await InteractionHelper.safeEditReply(
                            interaction,
                            buildTicketDashboardPayload(interaction.guild, recovered),
                        );
                    }
                } catch (error) {
                    logger.warn('Background ticket dashboard recovery failed', {
                        guildId: interaction.guildId,
                        error: error.message,
                    });
                }
            })();
        }
    },
};
