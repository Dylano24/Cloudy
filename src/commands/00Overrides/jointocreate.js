import { ChannelType, MessageFlags } from 'discord.js';
import originalCommand from '../JoinToCreate/jointocreate.js';
import { getConfiguration } from '../../services/joinToCreateService.js';

// The dashboard always manages the single persisted Join to Create trigger for the
// guild. Do not expose trigger_channel in the registered slash-command schema.
// This avoids Discord mobile sending a missing/stale channel value and makes the
// command behave identically no matter which text channel it is executed from.
const dashboardSubcommand = originalCommand.data.options?.find(option => option?.name === 'dashboard');
if (dashboardSubcommand && Array.isArray(dashboardSubcommand.options)) {
    dashboardSubcommand.options = dashboardSubcommand.options.filter(option => option?.name !== 'trigger_channel');
}

async function fetchVoiceChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    const channel = await guild.channels.fetch(String(channelId)).catch(() => null);
    return channel?.type === ChannelType.GuildVoice ? channel : null;
}

async function resolveDashboardTriggerChannel(interaction, client) {
    const configuration = await getConfiguration(client, interaction.guild.id).catch(() => null);
    const triggerIds = Array.isArray(configuration?.triggerChannels)
        ? configuration.triggerChannels
        : [];

    for (const triggerId of triggerIds) {
        const configuredChannel = await fetchVoiceChannel(interaction.guild, triggerId);
        if (configuredChannel) return configuredChannel;
    }

    return null;
}

export default {
    ...originalCommand,
    data: originalCommand.data,

    async execute(interaction, config, client) {
        if (interaction.options.getSubcommand() !== 'dashboard') {
            return originalCommand.execute(interaction, config, client);
        }

        const triggerChannel = await resolveDashboardTriggerChannel(interaction, client);
        if (!triggerChannel) {
            const payload = {
                content: 'No active Join to Create channel is configured for this server. Run `/jointocreate setup` first.',
                flags: MessageFlags.Ephemeral,
            };

            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: payload.content, embeds: [], components: [] });
            }
            return interaction.reply(payload);
        }

        // Keep the existing dashboard implementation untouched. Internally supply
        // the persisted trigger channel whenever it asks for trigger_channel.
        const originalGetChannel = interaction.options.getChannel.bind(interaction.options);
        interaction.options.getChannel = (name, required = false) => {
            if (name === 'trigger_channel') return triggerChannel;
            return originalGetChannel(name, required);
        };

        try {
            return await originalCommand.execute(interaction, config, client);
        } finally {
            interaction.options.getChannel = originalGetChannel;
        }
    },
};
