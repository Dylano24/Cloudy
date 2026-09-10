import { ChannelType, MessageFlags, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import originalCommand from '../JoinToCreate/jointocreate.js';
import { getConfiguration } from '../../services/joinToCreateService.js';

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
        .setDescription('Configure an existing Join to Create system.')
        .addChannelOption(option =>
            option
                .setName('trigger_channel')
                .setDescription('Voice channel to configure. Leave empty to use the active Join to Create channel.')
                .setRequired(false)
                .addChannelTypes(ChannelType.GuildVoice)
        )
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

async function resolveDashboardChannel(interaction, client) {
    const selectedChannel = interaction.options.getChannel('trigger_channel', false);
    if (selectedChannel?.type === ChannelType.GuildVoice) {
        return selectedChannel;
    }
    return resolveConfiguredTrigger(interaction, client);
}

function createDashboardInteractionView(interaction, triggerChannel) {
    const optionView = new Proxy(interaction.options, {
        get(target, property) {
            if (property === 'getChannel') {
                return (name, required = false) => {
                    if (name === 'trigger_channel') return triggerChannel;
                    return target.getChannel(name, required);
                };
            }

            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });

    return new Proxy(interaction, {
        get(target, property) {
            if (property === 'options') return optionView;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

export default {
    ...originalCommand,
    data,

    async execute(interaction, config, client) {
        if (interaction.options.getSubcommand() !== 'dashboard') {
            return originalCommand.execute(interaction, config, client);
        }

        const triggerChannel = await resolveDashboardChannel(interaction, client);
        if (!triggerChannel) {
            const content = 'No active Join to Create channel is configured for this server. Run `/jointocreate setup` first.';
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content, embeds: [], components: [] });
            }
            return interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }

        // Delegate through a read-only interaction/options view instead of mutating
        // Discord.js interaction state. The original dashboard therefore receives
        // the resolved voice channel exactly as before without a shared-state race.
        const dashboardInteraction = createDashboardInteractionView(interaction, triggerChannel);
        return originalCommand.execute(dashboardInteraction, config, client);
    },
};
