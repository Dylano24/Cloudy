import { ChannelType, MessageFlags } from 'discord.js';
import originalCommand from '../JoinToCreate/jointocreate.js';
import { getConfiguration } from '../../services/joinToCreateService.js';

// Discord mobile can fail to hydrate a selected channel option even though desktop
// resolves the same option correctly. Keep the selector available, but make it
// optional so the dashboard can always fall back to the one configured JTC trigger.
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
    // First honor an explicit selection. Read the raw snowflake instead of relying
    // on Discord.js resolved-channel hydration, which is the mobile failure path.
    const selectedChannelId = getRawTriggerChannelId(interaction);
    const selectedChannel = await fetchVoiceChannel(interaction.guild, selectedChannelId);
    if (selectedChannel) return selectedChannel;

    // Only one JTC trigger is supported per guild, so a missing/broken mobile
    // selection safely falls back to the persisted configured trigger.
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

        // The existing dashboard code remains untouched. We only normalize the
        // trigger_channel resolver so desktop and mobile feed it the same channel.
        const originalGetChannel = interaction.options.getChannel.bind(interaction.options);
        interaction.options.getChannel = (name, required = false) => {
            if (name === 'trigger_channel') return triggerChannel;
            return originalGetChannel(name, required);
        };

        try {
            return await originalCommand.execute(interaction, config, client);
        } finally {
            delete interaction.options.getChannel;
        }
    },
};
