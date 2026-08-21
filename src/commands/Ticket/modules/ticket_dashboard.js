import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import { recoverTicketDashboardConfig } from '../../../services/ticketDashboardRecoveryService.js';
import { refreshAllTicketChannels } from '../../../services/ticketChannelBrowserService.js';
import { ensureTicketDestinationConfig } from '../../../services/ticketDestinationAutoConfig.js';
import { logger } from '../../../utils/logger.js';

export default {
    prefixOnly: false,

    async execute(interaction, recoveredConfig, client) {
        const guildConfig = recoveredConfig && typeof recoveredConfig === 'object'
            ? recoveredConfig
            : {};

        await InteractionHelper.safeEditReply(
            interaction,
            buildTicketDashboardPayload(interaction.guild, guildConfig),
        );

        void refreshAllTicketChannels(interaction.guild).catch(() => {});

        void (async () => {
            try {
                let latest = await ensureTicketDestinationConfig(
                    client,
                    interaction.guild,
                    { refreshIfMissing: false },
                );

                if (!latest?.ticketPanelChannelId) {
                    latest = await recoverTicketDashboardConfig(
                        client,
                        interaction.guild,
                        interaction.channelId,
                    );
                    latest = await ensureTicketDestinationConfig(
                        client,
                        interaction.guild,
                        { refreshIfMissing: false },
                    );
                }

                if (latest && interaction.deferred) {
                    await InteractionHelper.safeEditReply(
                        interaction,
                        buildTicketDashboardPayload(interaction.guild, latest),
                    );
                }
            } catch (error) {
                logger.warn('Background ticket dashboard recovery failed', {
                    guildId: interaction.guildId,
                    error: error.message,
                });
            }
        })();
    },
};
