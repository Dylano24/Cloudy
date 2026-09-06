import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    initializeJoinToCreate,
    getChannelConfiguration,
    updateChannelConfig,
    removeTriggerChannel,
    hasManageGuildPermission,
    logConfigurationChange,
    getConfiguration
} from '../../services/joinToCreateService.js';

const TRANSIENT_RESPONSE_TTL_MS = 10_000;

function buildConfigEmbed(triggerChannel, currentConfig) {
    const channelConfig = currentConfig.channelConfig || {};

    return new EmbedBuilder()
        .setTitle('Join to create configuration')
        .setDescription(`Configuration for ${triggerChannel}`)
        .setColor(getColor('info'))
        .addFields(
            {
                name: 'Channel name template',
                value: `\`${channelConfig.nameTemplate || currentConfig.channelNameTemplate || "{username}'s Room"}\``,
                inline: false
            },
            {
                name: 'User limit',
                value: `${(channelConfig.userLimit ?? currentConfig.userLimit ?? 0) === 0 ? 'Unlimited' : (channelConfig.userLimit ?? currentConfig.userLimit ?? 0) + ' users'}`,
                inline: true
            },
            {
                name: 'Bitrate',
                value: `${(channelConfig.bitrate ?? currentConfig.bitrate ?? 64000) / 1000} kbps`,
                inline: true
            }
        )
        .setFooter({ text: 'Use the buttons below to modify settings • Only one trigger channel is supported per guild' })
        .setTimestamp();
}

function scheduleTransientDeletion(interaction, message = null) {
    const timer = setTimeout(async () => {
        try {
            if (message?.id && interaction.webhook?.deleteMessage) {
                const deleted = await interaction.webhook.deleteMessage(message.id)
                    .then(() => true)
                    .catch(() => false);
                if (deleted) return;
            }

            if (message?.delete) {
                const deleted = await message.delete()
                    .then(() => true)
                    .catch(() => false);
                if (deleted) return;
            }

            if (interaction.deleteReply) {
                await interaction.deleteReply().catch(() => {});
            }
        } catch (error) {
            logger.debug('Could not auto-delete Join to create response', { error: error?.message });
        }
    }, TRANSIENT_RESPONSE_TTL_MS);
    timer.unref?.();
}

async function replyTransient(interaction, payload) {
    const message = await interaction.reply({
        ...payload,
        flags: MessageFlags.Ephemeral,
        fetchReply: true
    }).catch(() => null);

    if (message) scheduleTransientDeletion(interaction, message);
    return message;
}

async function refreshDashboard(message, triggerChannel, client) {
    if (!message?.edit) return null;

    const latestConfig = await getChannelConfiguration(client, triggerChannel.guild.id, triggerChannel.id);
    await message.edit({ embeds: [buildConfigEmbed(triggerChannel, latestConfig)] }).catch(() => null);
    return latestConfig;
}

export default {
    data: new SlashCommandBuilder()
        .setName("jointocreate")
        .setDescription("Manage Join to Create voice channels system.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("setup")
                .setDescription("Set up a new Join to Create voice channel.")
                .addChannelOption((option) =>
                    option
                        .setName("category")
                        .setDescription("Category to create the channel in.")
                        .addChannelTypes(ChannelType.GuildCategory)
                )
                .addStringOption((option) =>
                    option
                        .setName("channel_name")
                        .setDescription("Select a template for naming temporary voice channels.")
                        .addChoices(
                            { name: "{username}'s Room (Default)", value: "{username}'s Room" },
                            { name: "{username}'s Channel", value: "{username}'s Channel" },
                            { name: "{username}'s Lounge", value: "{username}'s Lounge" },
                            { name: "{username}'s Space", value: "{username}'s Space" },
                            { name: "{displayName}'s Room", value: "{displayName}'s Room" },
                            { name: "{username}'s VC", value: "{username}'s VC" },
                            { name: "{username}'s Music Room", value: "{username}'s Music Room" },
                            { name: "{username}'s Gaming Room", value: "{username}'s Gaming Room" },
                            { name: "{username}'s Chat Room", value: "{username}'s Chat Room" },
                            { name: "{username}'s Private Room", value: "{username}'s Private Room" }
                        )
                )
                .addIntegerOption((option) =>
                    option
                        .setName("user_limit")
                        .setDescription("Maximum number of users in temporary channels. (0 = unlimited)")
                )
                .addIntegerOption((option) =>
                    option
                        .setName("bitrate")
                        .setDescription("Bitrate for temporary channels in kbps (8-96).")
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("dashboard")
                .setDescription("Configure an existing Join to Create system.")
                .addChannelOption((option) =>
                    option
                        .setName("trigger_channel")
                        .setDescription("The Join to Create trigger channel to configure.")
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildVoice)
                )
        ),
    category: "utility",

    async execute(interaction, config, client) {
        try {
            if (!hasManageGuildPermission(interaction.member)) {
                throw new TitanBotError(
                    'User lacks ManageGuild permission',
                    ErrorTypes.PERMISSION,
                    'You need **Manage Server** permission to use this command.'
                );
            }

            const subcommand = interaction.options.getSubcommand();
            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

            if (subcommand === "setup") {
                await handleSetupSubcommand(interaction, client);
                return;
            } else if (subcommand === "dashboard") {
                await handleConfigSubcommand(interaction, client);
                return;
            }
        } catch (error) {
            try {
                let errorMessage = 'An error occurred while executing this command.';

                if (error instanceof TitanBotError) {
                    errorMessage = error.userMessage || 'An error occurred. Please try again.';
                    logger.debug(`TitanBotError [${error.type}]: ${error.message}`, error.context || {});
                } else {
                    logger.error('Unexpected error in jointocreate command:', error);
                    errorMessage = 'An unexpected error occurred. Please try again or contact support.';
                }

                return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: errorMessage });
            } catch (replyError) {
                logger.error('Failed to send error message:', replyError);
            }
        }
    }
};

async function handleSetupSubcommand(interaction, client) {
    try {
        const category = interaction.options.getChannel('category');
        const nameTemplate = interaction.options.getString('channel_name') || "{username}'s Room";
        const userLimit = interaction.options.getInteger('user_limit') || 0;
        const bitrate = interaction.options.getInteger('bitrate') || 64;
        const guildId = interaction.guild.id;

        logger.debug(`Setting up Join to Create in guild ${guildId} with template: ${nameTemplate}`);

        const existingConfig = await getConfiguration(client, guildId);

        if (Array.isArray(existingConfig.triggerChannels) && existingConfig.triggerChannels.length > 0) {
            const activeTriggerChannels = [];
            const staleTriggerChannelIds = [];

            for (const existingChannelId of existingConfig.triggerChannels) {
                const existingChannel = await interaction.guild.channels.fetch(existingChannelId).catch(() => null);
                if (existingChannel) activeTriggerChannels.push(existingChannel);
                else staleTriggerChannelIds.push(existingChannelId);
            }

            if (staleTriggerChannelIds.length > 0) {
                for (const staleChannelId of staleTriggerChannelIds) {
                    logger.info(`Cleaning up stale JTC trigger ${staleChannelId} from guild ${guildId}`);
                    await removeTriggerChannel(client, guildId, staleChannelId);
                }
            }

            if (activeTriggerChannels.length > 0) {
                const primaryTrigger = activeTriggerChannels[0];
                const errorMessage = `This server already has a Join to Create channel set up: ${primaryTrigger}\n\nUse \`/jointocreate dashboard\` to modify it, or remove it first before creating a new one.`;

                throw new TitanBotError(
                    'Guild already has a Join to Create channel',
                    ErrorTypes.VALIDATION,
                    errorMessage,
                    { guildId, activeTriggerCount: activeTriggerChannels.length, expected: true, suppressErrorLog: true }
                );
            }
        }

        const triggerChannel = await interaction.guild.channels.create({
            name: 'Join to Create',
            type: ChannelType.GuildVoice,
            parent: category?.id,
            userLimit: 0,
            bitrate: 64000,
            permissionOverwrites: [{
                id: interaction.guild.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
            }],
        });

        await initializeJoinToCreate(client, guildId, triggerChannel.id, {
            nameTemplate,
            userLimit,
            bitrate: bitrate * 1000,
            categoryId: category?.id
        });

        await logConfigurationChange(client, guildId, interaction.user.id, 'Initialized Join to Create', {
            channelId: triggerChannel.id,
            nameTemplate,
            userLimit,
            bitrate
        });

        const responseEmbed = successEmbed(
            'Setup complete',
            `Created Join to Create channel: ${triggerChannel}\n\n` +
            `**Settings:**\n` +
            `• Template: \`${nameTemplate}\`\n` +
            `• User limit: ${userLimit === 0 ? 'Unlimited' : userLimit + ' users'}\n` +
            `• Bitrate: ${bitrate} kbps\n` +
            `${category ? `• Category: ${category.name}` : '• Category: Root level'}`
        );

        await InteractionHelper.safeEditReply(interaction, { embeds: [responseEmbed] });
        const responseMessage = await interaction.fetchReply().catch(() => null);
        if (responseMessage) scheduleTransientDeletion(interaction, responseMessage);
        return responseMessage;
    } catch (error) {
        logger.error('Error in handleSetupSubcommand:', error);
        if (error instanceof TitanBotError) throw error;
        throw new TitanBotError(
            `Setup failed: ${error.message}`,
            ErrorTypes.DISCORD_API,
            'Failed to set up Join to Create system. Please check bot permissions.'
        );
    }
}

async function handleConfigSubcommand(interaction, client) {
    try {
        const triggerChannel = interaction.options.getChannel('trigger_channel');
        const guildId = interaction.guild.id;
        const currentConfig = await getChannelConfiguration(client, guildId, triggerChannel.id);
        const configEmbed = buildConfigEmbed(triggerChannel, currentConfig);

        const nameButton = new ButtonBuilder()
            .setCustomId(`jtc_config_name_${triggerChannel.id}`)
            .setLabel('📝 Name template')
            .setStyle(ButtonStyle.Secondary);
        const limitButton = new ButtonBuilder()
            .setCustomId(`jtc_config_limit_${triggerChannel.id}`)
            .setLabel('👥 User limit')
            .setStyle(ButtonStyle.Secondary);
        const bitrateButton = new ButtonBuilder()
            .setCustomId(`jtc_config_bitrate_${triggerChannel.id}`)
            .setLabel('🎵 Bitrate')
            .setStyle(ButtonStyle.Secondary);
        const deleteButton = new ButtonBuilder()
            .setCustomId(`jtc_config_delete_${triggerChannel.id}`)
            .setLabel('🗑️ Remove channel')
            .setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(nameButton, limitButton, bitrateButton, deleteButton);

        await InteractionHelper.safeEditReply(interaction, { embeds: [configEmbed], components: [row] });
        const message = await interaction.fetchReply();

        if (!message || typeof message.createMessageComponentCollector !== 'function') {
            throw new TitanBotError(
                'Failed to fetch interaction reply for collector setup',
                ErrorTypes.DISCORD_API,
                'Failed to open configuration controls. Please run `/jointocreate dashboard` again.'
            );
        }

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 300000
        });

        collector.on('collect', async (buttonInteraction) => {
            try {
                if (!hasManageGuildPermission(buttonInteraction.member)) {
                    await replyTransient(buttonInteraction, {
                        content: '❌ You need **Manage Server** permission to use these controls.'
                    });
                    return;
                }

                // Always refresh from storage before acting. An older dashboard may never
                // overwrite the latest value just because another administrator opened it first.
                await refreshDashboard(message, triggerChannel, client);

                const customId = buttonInteraction.customId;
                if (customId.includes('jtc_config_name_')) {
                    await handleNameTemplateModal(buttonInteraction, triggerChannel, client, message);
                } else if (customId.includes('jtc_config_limit_')) {
                    await handleUserLimitModal(buttonInteraction, triggerChannel, client, message);
                } else if (customId.includes('jtc_config_bitrate_')) {
                    await handleBitrateModal(buttonInteraction, triggerChannel, client, message);
                } else if (customId.includes('jtc_config_delete_')) {
                    await handleChannelDeletion(buttonInteraction, triggerChannel, client);
                }
            } catch (error) {
                const userMessage = error instanceof TitanBotError
                    ? error.userMessage || 'An error occurred.'
                    : 'An error occurred while processing your request.';

                if (error instanceof TitanBotError) {
                    logger.debug(`Button interaction validation error: ${error.message}`, error.context || {});
                } else {
                    logger.error('Unexpected error in config button interaction:', error);
                }

                if (!buttonInteraction.replied && !buttonInteraction.deferred) {
                    await replyTransient(buttonInteraction, { content: `❌ ${userMessage}` });
                }
            }
        });

        collector.on('end', async () => {
            const disabledRow = new ActionRowBuilder().addComponents(
                nameButton.setDisabled(true),
                limitButton.setDisabled(true),
                bitrateButton.setDisabled(true),
                deleteButton.setDisabled(true)
            );

            const latestConfig = await getChannelConfiguration(client, guildId, triggerChannel.id).catch(() => currentConfig);
            message.edit({
                components: [disabledRow],
                embeds: [buildConfigEmbed(triggerChannel, latestConfig).setFooter({ text: 'Configuration session expired. Run the command again to make changes.' })]
            }).catch(() => {});
        });
    } catch (error) {
        if (error instanceof TitanBotError) throw error;
        throw new TitanBotError(
            `Config failed: ${error.message}`,
            ErrorTypes.DATABASE,
            'Failed to load configuration.'
        );
    }
}

async function handleNameTemplateModal(interaction, triggerChannel, client, dashboardMessage) {
    try {
        const latestConfig = await getChannelConfiguration(client, interaction.guild.id, triggerChannel.id);
        const currentTemplate = latestConfig.channelConfig?.nameTemplate
            || latestConfig.channelNameTemplate
            || "{username}'s Room";

        const modal = new ModalBuilder()
            .setCustomId(`jtc_name_modal_${triggerChannel.id}`)
            .setTitle('Channel name template')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('name_template')
                    .setLabel('Channel name template')
                    .setPlaceholder("Example: {username}'s Room")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(100)
                    .setValue(String(currentTemplate).substring(0, 100))
            ));

        await interaction.showModal(modal);
        const modalSubmission = await interaction.awaitModalSubmit({
            filter: (i) => i.customId === `jtc_name_modal_${triggerChannel.id}` && i.user.id === interaction.user.id,
            time: 60000
        });

        if (!hasManageGuildPermission(modalSubmission.member)) {
            await replyTransient(modalSubmission, {
                content: '❌ You need **Manage Server** permission to modify these settings.'
            });
            return;
        }

        const newTemplate = modalSubmission.fields.getTextInputValue('name_template').trim();
        if (!newTemplate) {
            throw new TitanBotError(
                'Channel name template cannot be empty',
                ErrorTypes.VALIDATION,
                'Channel name template cannot be empty.'
            );
        }

        await updateChannelConfig(client, interaction.guild.id, triggerChannel.id, { nameTemplate: newTemplate });
        await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Updated channel name template', {
            channelId: triggerChannel.id,
            newTemplate
        });

        await refreshDashboard(dashboardMessage, triggerChannel, client);
        await replyTransient(modalSubmission, {
            embeds: [successEmbed('Updated', `Channel name template changed to \`${newTemplate}\``)]
        });
    } catch (error) {
        if (error.code === 'INTERACTION_COLLECTOR_ERROR') return;
        if (error instanceof TitanBotError) throw error;
        logger.error('Unexpected error in name template modal:', error);
        throw new TitanBotError(
            `Modal error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            'An error occurred while updating the template.'
        );
    }
}

async function handleUserLimitModal(interaction, triggerChannel, client, dashboardMessage) {
    try {
        const latestConfig = await getChannelConfiguration(client, interaction.guild.id, triggerChannel.id);
        const currentLimit = latestConfig.channelConfig?.userLimit ?? latestConfig.userLimit ?? 0;

        const modal = new ModalBuilder()
            .setCustomId(`jtc_limit_modal_${triggerChannel.id}`)
            .setTitle('Configure user limit')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('user_limit')
                    .setLabel('Enter user limit (0-99, 0 = unlimited)')
                    .setPlaceholder('Enter a number between 0 and 99')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(2)
                    .setValue(currentLimit.toString())
            ));

        await interaction.showModal(modal);
        const modalSubmission = await interaction.awaitModalSubmit({
            filter: (i) => i.customId === `jtc_limit_modal_${triggerChannel.id}` && i.user.id === interaction.user.id,
            time: 60000
        });

        if (!hasManageGuildPermission(modalSubmission.member)) {
            await replyTransient(modalSubmission, {
                content: '❌ You need **Manage Server** permission to modify these settings.'
            });
            return;
        }

        const userInput = modalSubmission.fields.getTextInputValue('user_limit').trim();
        await updateChannelConfig(client, interaction.guild.id, triggerChannel.id, { userLimit: parseInt(userInput) });
        await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Updated user limit', {
            channelId: triggerChannel.id,
            userLimit: parseInt(userInput)
        });

        await refreshDashboard(dashboardMessage, triggerChannel, client);
        await replyTransient(modalSubmission, {
            embeds: [successEmbed('Updated', `User limit changed to ${parseInt(userInput) === 0 ? 'Unlimited' : parseInt(userInput) + ' users'}`)]
        });
    } catch (error) {
        if (error.code === 'INTERACTION_COLLECTOR_ERROR') return;
        if (error instanceof TitanBotError) throw error;
        logger.error('Unexpected error in user limit modal:', error);
        throw new TitanBotError(
            `Modal error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            'An error occurred while updating the user limit.'
        );
    }
}

async function handleBitrateModal(interaction, triggerChannel, client, dashboardMessage) {
    try {
        const latestConfig = await getChannelConfiguration(client, interaction.guild.id, triggerChannel.id);
        const currentBitrate = ((latestConfig.channelConfig?.bitrate ?? latestConfig.bitrate ?? 64000) / 1000);

        const modal = new ModalBuilder()
            .setCustomId(`jtc_bitrate_modal_${triggerChannel.id}`)
            .setTitle('Configure bitrate')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('bitrate')
                    .setLabel('Enter bitrate in kbps (8-384)')
                    .setPlaceholder('Enter a number between 8 and 384')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(3)
                    .setValue(currentBitrate.toString())
            ));

        await interaction.showModal(modal);
        const modalSubmission = await interaction.awaitModalSubmit({
            filter: (i) => i.customId === `jtc_bitrate_modal_${triggerChannel.id}` && i.user.id === interaction.user.id,
            time: 60000
        });

        if (!hasManageGuildPermission(modalSubmission.member)) {
            await replyTransient(modalSubmission, {
                content: '❌ You need **Manage Server** permission to modify these settings.'
            });
            return;
        }

        const userInput = modalSubmission.fields.getTextInputValue('bitrate').trim();
        await updateChannelConfig(client, interaction.guild.id, triggerChannel.id, { bitrate: parseInt(userInput) * 1000 });
        await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Updated bitrate', {
            channelId: triggerChannel.id,
            bitrate: parseInt(userInput)
        });

        await refreshDashboard(dashboardMessage, triggerChannel, client);
        await replyTransient(modalSubmission, {
            embeds: [successEmbed('Updated', `Bitrate changed to ${parseInt(userInput)} kbps`)]
        });
    } catch (error) {
        if (error.code === 'INTERACTION_COLLECTOR_ERROR') return;
        if (error instanceof TitanBotError) throw error;
        logger.error('Unexpected error in bitrate modal:', error);
        throw new TitanBotError(
            `Modal error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            'An error occurred while updating the bitrate.'
        );
    }
}

async function handleChannelDeletion(interaction, triggerChannel, client) {
    try {
        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`jtc_delete_confirm_${triggerChannel.id}`)
                .setLabel('🗑️ Yes, delete')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`jtc_delete_cancel_${triggerChannel.id}`)
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Secondary)
        );

        await InteractionHelper.safeReply(interaction, {
            embeds: [warningEmbed('Confirm deletion', `Are you sure you want to remove **${triggerChannel.name}** from the Join to Create system?\n\nThis action cannot be undone.`)],
            components: [confirmRow],
            flags: MessageFlags.Ephemeral
        });

        const message = await interaction.fetchReply();
        scheduleTransientDeletion(interaction, message);

        const deleteCollector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === interaction.user.id &&
                (i.customId === `jtc_delete_confirm_${triggerChannel.id}` || i.customId === `jtc_delete_cancel_${triggerChannel.id}`),
            time: TRANSIENT_RESPONSE_TTL_MS,
            max: 1
        });

        deleteCollector.on('collect', async (buttonInteraction) => {
            try {
                if (!hasManageGuildPermission(buttonInteraction.member)) {
                    await replyTransient(buttonInteraction, {
                        content: '❌ You need **Manage Server** permission to remove channels.'
                    });
                    return;
                }

                if (buttonInteraction.customId === `jtc_delete_confirm_${triggerChannel.id}`) {
                    await removeTriggerChannel(client, interaction.guild.id, triggerChannel.id);
                    await logConfigurationChange(client, interaction.guild.id, interaction.user.id, 'Removed Join to Create trigger', {
                        channelId: triggerChannel.id,
                        channelName: triggerChannel.name
                    });

                    try {
                        if (triggerChannel.members.size === 0) {
                            await triggerChannel.delete('Join to Create trigger removed by administrator');
                        }
                    } catch (deleteError) {
                        logger.warn(`Could not delete channel ${triggerChannel.id}: ${deleteError.message}`);
                    }

                    await buttonInteraction.update({
                        embeds: [successEmbed('Removed', `**${triggerChannel.name}** has been removed from the Join to Create system.`)],
                        components: []
                    });
                } else {
                    await buttonInteraction.update({
                        embeds: [successEmbed('Cancelled', 'Channel removal has been cancelled.')],
                        components: []
                    });
                }
            } catch (collectError) {
                logger.error('Error handling delete confirmation:', collectError);
                if (!buttonInteraction.replied && !buttonInteraction.deferred) {
                    await replyTransient(buttonInteraction, {
                        content: '❌ An error occurred while processing your request.'
                    });
                }
            }
        });

        deleteCollector.on('end', (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                interaction.webhook?.deleteMessage(message.id).catch(() => {});
            }
        });
    } catch (error) {
        if (error instanceof TitanBotError) throw error;
        logger.error('Unexpected error in handleChannelDeletion:', error);
        throw new TitanBotError(
            `Deletion error: ${error.message}`,
            ErrorTypes.UNKNOWN,
            'An error occurred while removing the channel.'
        );
    }
}
