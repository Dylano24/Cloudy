import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { getCurrentTicketDashboardConfig } from '../../../services/ticketDashboardService.js';
import { buildTicketDashboardPayload } from '../../../services/ticketDashboardViewService.js';
import { recoverTicketDashboardConfig } from '../../../services/ticketDashboardRecoveryService.js';

export default {
    prefixOnly: false,

    async execute(interaction, recoveredConfig, client) {
        const guildId = interaction.guildId;

        let guildConfig = recoveredConfig && typeof recoveredConfig === 'object'
            ? recoveredConfig
            : await getCurrentTicketDashboardConfig(client, guildId);

        if (!guildConfig?.ticketPanelChannelId) {
            guildConfig = await recoverTicketDashboardConfig(
                client,
                interaction.guild,
                interaction.channelId,
            );
        }

        await InteractionHelper.safeEditReply(
            interaction,
            buildTicketDashboardPayload(interaction.guild, guildConfig || {}),
        );
    },
};
