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
                .setName('picture')
                .setDescription('Change the bot profile picture')
                .addAttachmentOption((option) =>
                    option
                        .setName('image')
                        .setDescription('Upload a PNG, JPG, WEBP, or GIF')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('banner')
                .setDescription('Change the bot profile banner')
                .addAttachmentOption((option) =>
                    option
                        .setName('image')
                        .setDescription('Upload a PNG, JPG, WEBP, or GIF')
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('status')
                .setDescription('Set the bot custom status')
                .addStringOption((option) =>
                    option
                        .setName('text')
                        .setDescription('The custom status text')
                        .setMaxLength(128)
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName('activity')
                .setDescription('Change the bot activity text')
                .addStringOption((option) =>
                    option
                        .setName('text')
                        .setDescription('The activity text')
                        .setMaxLength(128)
                        .setRequired(true)
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

            if (subcommand === 'picture' || subcommand === 'banner') {
                const image = interaction.options.getAttachment('image', true);
                const allowedTypes = new Set([
                    'image/png',
                    'image/jpeg',
                    'image/webp',
                    'image/gif',
                ]);

                if (!allowedTypes.has(image.contentType)) {
                    await interaction.editReply(
                        'Please upload a PNG, JPG, WEBP, or GIF image.'
                    );
                    return;
                }

                if (image.size > 10 * 1024 * 1024) {
                    await interaction.editReply(
                        'The image must be smaller than 10 MB.'
                    );
                    return;
                }

                const response = await fetch(image.url);
                if (!response.ok) {
                    throw new Error(`Could not download the uploaded image (HTTP ${response.status})`);
                }

                const imageBuffer = Buffer.from(await response.arrayBuffer());

                if (subcommand === 'picture') {
                    await interaction.client.user.setAvatar(imageBuffer);
                    await interaction.editReply('Bot profile picture updated.');
                } else {
                    await interaction.client.user.setBanner(imageBuffer);
                    await interaction.editReply('Bot profile banner updated.');
                }
                return;
            }

            if (subcommand === 'status') {
                const text = interaction.options.getString('text', true);
                const savedPresence =
                    await interaction.client.db.get('global:bot:profile:presence') ||
                    {};
                const presence = {
                    status: savedPresence.status || 'online',
                    activities: [{
                        name: 'Custom Status',
                        state: text,
                        type: ActivityType.Custom,
                    }],
                };

                interaction.client.user.setPresence(presence);
                await interaction.client.db.set(
                    'global:bot:profile:presence',
                    presence
                );
                await interaction.editReply(
                    `Bot custom status changed to: **${text}**.`
                );
                return;
            }

            const text = interaction.options.getString('text', true);
            const savedPresence =
                await interaction.client.db.get('global:bot:profile:presence') ||
                {};
            const presence = {
                status: savedPresence.status || 'online',
                activities: [{
                    name: text,
                    type: ActivityType.Playing,
                }],
            };

            interaction.client.user.setPresence(presence);
            await interaction.client.db.set(
                'global:bot:profile:presence',
                presence
            );
            await interaction.editReply(
                `Bot activity changed to: **${text}**.`
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
