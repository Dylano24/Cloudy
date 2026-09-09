import { ChannelType, MessageFlags } from 'discord.js';
import originalCommand from '../JoinToCreate/jointocreate.js';
import { getConfiguration } from '../../services/joinToCreateService.js';

const dashboardSubcommand = originalCommand.data.options?.find(option => option?.name === 'dashboard');
const triggerChannelOption = dashboardSubcommand?.options?.find(option => option?.name === 'trigger_channel');
triggerChannelOption?.setRequired(false);

function getRawTriggerChannelId(interaction) {
    const dashboardOption = interaction.options?.data?.find(option => option?.name === 'dashboard');
    const triggerOption = dashboardOption?.options?.find(option => option?.name === 'trigger_channel');
    const value = triggerOption?.value;
    if (value == null) return null;
    const id = String(value).trim();
    return /^\d{17,20}$/.test(id) ? id : null;
}

async function fetchVoiceChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    const cached = guild.channels.cache?.get(channelId);
    const channel = cached || await guild.channels.fetch(channelId).catch(() => null);
    return channel?.type === ChannelType.GuildVoice ? channel : null;
}

async function resolveDashboardTriggerChannel(interaction, client) {
    // Prefer Discord.js' resolved channel. This is the canonical path on desktop
    // and on mobile clients that hydrate the selected option correctly.
    const hydrated = interaction.options.getChannel('trigger_channel', false);
    if (hydrated?.type === ChannelType.GuildVoice) return hydrated;

    // Some Discord mobile interactions contain only the selected channel snowflake.
    // Resolve that exact selected ID ourselves instead of treating it as invalid.
    const selectedId = getRawTriggerChannelId(interaction);
    const selected = await fetchVoiceChannel(interaction.guild, selectedId);
    if (selected) return selected;

    // Last-resort fallback for the one-trigger-per-guild JTC configuration.
    const configuration = await getConfiguration(client, interaction.guild.id).catch(() => null);
    const triggerIds = Array.isArray(configuration?.triggerChannels) ? configuration.triggerChannels : [];
    for (const triggerId of triggerIds) {
        const configured = await fetchVoiceChannel(interaction.guild, String(triggerId));
        if (configured) return configured;
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
            const content = 'No active Join to Create channel is configured for this server. Run `/jointocreate setup` first.';
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content, embeds: [], components: [] });
            }
            return interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }

        // Normalize only trigger_channel for the existing implementation. Everything
        // else, including persisted name-template display/update behavior, stays intact.
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
