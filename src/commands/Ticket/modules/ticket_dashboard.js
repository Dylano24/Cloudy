import { InteractionHelper } from '../../../utils/interactionHelper.js';
import {
    buildTicketDashboardPayload,
    getCurrentTicketDashboardConfig,
} from '../../../services/ticketDashboardService.js';
import { recoverTicketDashboardConfig } from '../../../services/ticketDashboardRecoveryService.js';

export default {
    prefixOnly: false,

    async execute(interaction, recoveredConfig, client) {
        const guildId = interaction.guildId;

        let guildConfig = recoveredConfig && typeof recoveredConfig === 'object'
            ? recoveredConfig
            : await getCurrentTicketDashboardConfig(client, guildId);

        // A partial/default config must not make the dashboard pretend the
        // ticket system does not exist. Recover the existing Contact the support
        // / Start Chat panel directly from Discord, prioritizing the channel in
        // which the command was used.
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
