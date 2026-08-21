import { InteractionHelper } from '../../../utils/interactionHelper.js';
import {
    buildTicketDashboardPayload,
    getCurrentTicketDashboardConfig,
} from '../../../services/ticketDashboardService.js';

export default {
    prefixOnly: false,

    async execute(interaction, recoveredConfig, client) {
        const guildId = interaction.guildId;

        // /ticket already attempts to recover an existing Cloudy ticket panel
        // before opening the dashboard. Use that recovered config directly.
        // Never force admins to run /ticket setup again just because part of the
        // persistent configuration is missing; the dashboard itself supports
        // incomplete settings and is the place where they should be repaired.
        const guildConfig = recoveredConfig && typeof recoveredConfig === 'object'
            ? recoveredConfig
            : await getCurrentTicketDashboardConfig(client, guildId);

        await InteractionHelper.safeEditReply(
            interaction,
            buildTicketDashboardPayload(interaction.guild, guildConfig || {}),
        );
    },
};
