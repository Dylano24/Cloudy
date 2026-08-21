import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import {
    buildTicketDashboardPayload,
    getCurrentTicketDashboardConfig,
} from '../../../services/ticketDashboardService.js';

export default {
    prefixOnly: false,

    async execute(interaction, _config, client) {
        const guildId = interaction.guildId;
        const guildConfig = await getCurrentTicketDashboardConfig(client, guildId);

        if (!guildConfig?.ticketPanelChannelId) {
            throw new TitanBotError(
                'Ticket system not configured',
                ErrorTypes.CONFIGURATION,
                'The ticket system has not been set up yet. Run `/ticket setup` first to configure it.',
            );
        }

        await InteractionHelper.safeEditReply(
            interaction,
            buildTicketDashboardPayload(interaction.guild, guildConfig),
        );
    },
};
