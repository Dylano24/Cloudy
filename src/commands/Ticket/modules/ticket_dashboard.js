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

        // The command is already deferred by /ticket. Render the controls directly
        // before any recovery/network work so Discord never stays on "thinking".
        await interaction.editReply(
            buildTicketDashboardPayload(interaction.guild, guildConfig),
        );

        void refreshAllTicketChannels(interaction.guild).catch(() => {});

        // Recovery is intentionally background-only. A slow channel/database lookup
        // must never block the dashboard that the administrator is trying to use.
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
                    await interaction.editReply(
                        buildTicketDashboardPayload(interaction.guild, latest),
                    ).catch(() => {});
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