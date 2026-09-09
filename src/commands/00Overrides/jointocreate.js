import { ChannelType, MessageFlags, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import originalCommand from '../JoinToCreate/jointocreate.js';
import { getConfiguration } from '../../services/joinToCreateService.js';

// IMPORTANT: Discord validates CHANNEL options in the client before the bot receives
// the interaction. Discord iOS can reject a selected channel with "A specified channel
// ID is invalid". Publish dashboard without a CHANNEL option and resolve the single
// persisted JTC trigger in the bot instead. Setup keeps its original options unchanged.
const originalJson = originalCommand.data.toJSON();
const setupJson = originalJson.options?.find(option => option.name === 'setup');

const data = new SlashCommandBuilder()
    .setName('jointocreate')
    .setDescription('Manage Join to Create voice channels system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);

if (setupJson) {
    data.addSubcommand(subcommand => {
        subcommand.setName('setup').setDescription(setupJson.description);
        for (const option of setupJson.options || []) {
            if (option.type === 7) {
                subcommand.addChannelOption(builder => {
                    builder.setName(option.name).setDescription(option.description);
                    if (option.required) builder.setRequired(true);
                    if (Array.isArray(option.channel_types) && option.channel_types.length) builder.addChannelTypes(...option.channel_types);
                    return builder;
                });
            } else if (option.type === 3) {
                subcommand.addStringOption(builder => {
                    builder.setName(option.name).setDescription(option.description);
                    if (option.required) builder.setRequired(true);
                    if (Array.isArray(option.choices) && option.choices.length) builder.addChoices(...option.choices);
                    return builder;
                });
            } else if (option.type === 4) {
                subcommand.addIntegerOption(builder => {
                    builder.setName(option.name).setDescription(option.description);
                    if (option.required) builder.setRequired(true);
                    return builder;
                });
            }
        }
        return subcommand;
    });
}

data.addSubcommand(subcommand =>
    subcommand
        .setName('dashboard')
        .setDescription('Configure the active Join to Create system.')
);

async function fetchVoiceChannel(guild, channelId) {
    if (!guild || !channelId) return null;
    const channel = guild.channels.cache?.get(String(channelId))
        || await guild.channels.fetch(String(channelId)).catch(() => null);
    return channel?.type === ChannelType.GuildVoice ? channel : null;
}

async function resolveConfiguredTrigger(interaction, client) {
    const configuration = await getConfiguration(client, interaction.guild.id).catch(() => null);
    const triggerIds = Array.isArray(configuration?.triggerChannels) ? configuration.triggerChannels : [];
    for (const triggerId of triggerIds) {
        const channel = await fetchVoiceChannel(interaction.guild, triggerId);
        if (channel) return channel;
    }
    return null;
}

export default {
    ...originalCommand,
    data,

    async execute(interaction, config, client) {
        if (interaction.options.getSubcommand() !== 'dashboard') {
            return originalCommand.execute(interaction, config, client);
        }

        const triggerChannel = await resolveConfiguredTrigger(interaction, client);
        if (!triggerChannel) {
            const content = 'No active Join to Create channel is configured for this server. Run `/jointocreate setup` first.';
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content, embeds: [], components: [] });
            }
            return interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }

        // Keep the existing dashboard implementation, including persisted name-template
        // display/update behavior. It receives the resolved configured trigger exactly as before.
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
