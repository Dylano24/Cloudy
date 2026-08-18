import {
    ActivityType,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
} from 'discord.js';
import { botConfig } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';

const activityTypes = {
    playing: ActivityType.Playing,
    listening: ActivityType.Listening,
    watching: ActivityType.Watching,
    competing: ActivityType.Competing,
    custom: ActivityType.Custom,
};

function canManageBot(interaction) {
    const isConfiguredOwner = botConfig.commands.owners.includes(interaction.user.id);
    const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
    const isAdministrator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

    return isConfiguredOwner || isGuildOwner || isAdministrator;
}

export default {
    data: new SlashCommandBuilder()
        .setName('botprofile')
        .setDescription('Change the bot name, bio, or status')
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName('name')
                .setDescription('Change the bot username')
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('The new bot name')
                        .setMinLength(2)
                        .setMaxLength(32)
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('bio')
                .setDescription('Change the bot profile bio')
                .addStringOption((option) =>
                    option
                        .setName('text')
                        .setDescription('The new bio')
                        .setMaxLength(400)
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('status')
                .setDescription('Change the bot activity and online status')
                .addStringOption((option) =>
                    option
                        .setName('text')
                        .setDescription('The status text')
                        .setMaxLength(128)
                        .setRequired(true)
                )
                .addStringOption((option) =>
                    option
                        .setName('type')
                        .setDescription('The activity type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Custom', value: 'custom' },
                            { name: 'Playing', value: 'playing' },
                            { name: 'Listening', value: 'listening' },
                            { name: 'Watching', value: 'watching' },
                            { name: 'Competing', value: 'competing' }
                        )
                )
                .addStringOption((option) =>
                    option
                        .setName('availability')
                        .setDescription('The online indicator')
                        .addChoices(
                            { name: 'Online', value: 'online' },
                            { name: 'Idle', value: 'idle' },
                            { name: 'Do Not Disturb', value: 'dnd' },
                            { name: 'Invisible', value: 'invisible' }
                        )
                )
        ),

    async execute(interaction) {
        if (!canManageBot(interaction)) {
            await interaction.reply({
                content: 'You do not have permission to change the bot profile.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            if (subcommand === 'name') {
                const name = interaction.options.getString('name', true);
                await interaction.client.user.setUsername(name);
                await interaction.editReply(`Bot name changed to **${name}**.`);
                return;
            }

            if (subcommand === 'bio') {
                const bio = interaction.options.getString('text', true);
                await interaction.client.application.edit({ description: bio });
                await interaction.editReply('Bot bio updated.');
                return;
            }

            const text = interaction.options.getString('text', true);
            const typeName = interaction.options.getString('type', true);
            const availability = interaction.options.getString('availability') || 'online';
            const type = activityTypes[typeName];

            const activity = type === ActivityType.Custom
                ? { name: 'Custom Status', state: text, type }
                : { name: text, type };

            interaction.client.user.setPresence({
                status: availability,
                activities: [activity],
            });

            await interaction.editReply(
                `Bot status updated to **${typeName}**: ${text} (${availability}).`
            );
        } catch (error) {
            logger.error('Bot profile command failed:', error);
            const message = error?.rawError?.message || error?.message || 'Unknown Discord API error';
            await interaction.editReply(
                `Discord rejected that profile change: ${message}`
            ).catch(() => {});
        }
    },
};
