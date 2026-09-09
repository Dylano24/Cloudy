import { ChannelType, MessageFlags } from 'discord.js';
import originalCommand from '../JoinToCreate/jointocreate.js';
import { getConfiguration } from '../../services/joinToCreateService.js';

// Keep the channel selector available on desktop and mobile, but never depend on
// Discord.js channel hydration alone. If mobile does not resolve the selection,
// fall back to the single persisted Join to Create trigger for this guild.
const dashboardSubcommand = originalCommand.data.options?.find(option => option?.name === 'dashboard');
const triggerChannelOption = dashboardSubcommand?.options?.find(option => option?.name === 'trigger_channel');
triggerChannelOption?.setRequired(false);

function getRawTriggerChannelId(interaction) {
    const dashboardOption = interaction.options?.data?.find(option => option?.name === 'dashboard');
    const triggerOption = dashboardOption?.options?.find(option => option?.name === 'trigger_channel');
    return triggerOption?.value ? String(triggerOption.value) : null;
}

async function fetchVoiceChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    const channel = await guild.channels.fetch(String(channelId)).catch(() => null);
    return channel?.type === ChannelType.GuildVoice ? channel : null;
}

async function resolveDashboardTriggerChannel(interaction, client) {
    // Desktop and correctly hydrated mobile interactions: honor the selected channel.
    const selectedChannelId = getRawTriggerChannelId(interaction);
    const selectedChannel = await fetchVoiceChannel(interaction.guild, selectedChannelId);
    if (selectedChannel) return selectedChannel;

    // Mobile fallback: use the persisted JTC trigger instead of returning an invalid-ID error.
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

        // Feed the resolved/fallback channel into the existing dashboard implementation.
        // This leaves the dashboard embed, name-template saving and all controls unchanged.
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
