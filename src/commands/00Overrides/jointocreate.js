import { ChannelType, MessageFlags } from 'discord.js';
import originalCommand from '../JoinToCreate/jointocreate.js';
import { getConfiguration } from '../../services/joinToCreateService.js';

const dashboardSubcommand = originalCommand.data.options?.find(option => option?.name === 'dashboard');
const triggerChannelOption = dashboardSubcommand?.options?.find(option => option?.name === 'trigger_channel');
if (triggerChannelOption) {
    triggerChannelOption.setRequired(false);
    // Do not publish a Discord-side channel-type restriction here. Discord mobile can
    // reject an otherwise valid selected channel before the interaction reaches the bot.
    // The bot validates/resolves the actual configured voice trigger below instead.
    triggerChannelOption.channel_types = undefined;
}

function getRawTriggerChannelId(interaction) {
    const dashboardOption = interaction.options?.data?.find(option => option?.name === 'dashboard');
    const triggerOption = dashboardOption?.options?.find(option => option?.name === 'trigger_channel');
    const value = triggerOption?.value;
    if (value == null) return null;
    const id = String(value).trim();
    return /^\d{17,20}$/.test(id) ? id : null;
}

async function fetchChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    return guild.channels.cache?.get(channelId)
        || await guild.channels.fetch(channelId).catch(() => null);
}

async function fetchVoiceChannel(guild, channelId) {
    const channel = await fetchChannel(guild, channelId);
    return channel?.type === ChannelType.GuildVoice ? channel : null;
}

async function resolveDashboardTriggerChannel(interaction, client) {
    // Accept the selected channel object when Discord supplied it correctly.
    const hydrated = interaction.options.getChannel('trigger_channel', false);
    if (hydrated?.type === ChannelType.GuildVoice) return hydrated;

    // Resolve the raw selected snowflake ourselves. This covers Discord mobile where
    // the option can arrive without the same resolved-channel hydration as desktop.
    const selectedId = getRawTriggerChannelId(interaction);
    const selected = await fetchVoiceChannel(interaction.guild, selectedId);
    if (selected) return selected;

    // If mobile supplied no usable selection, use the persisted JTC trigger. The
    // service supports one active trigger per guild, so this opens the same dashboard.
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
