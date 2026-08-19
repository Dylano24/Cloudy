import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getGuildConfig, setGuildConfig } from '../../../services/config/guildConfig.js';
import { startDashboardSession } from '../../../utils/dashboardSession.js';

const DASHBOARD_TIMEOUT_MS = 10 * 60 * 1000;

function replaceConfig(target, source) {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
}

async function persistConfig(client, guildId, guildConfig) {
    guildConfig.dmOnClose = false;
    await setGuildConfig(client, guildId, guildConfig);
    const fresh = await getGuildConfig(client, guildId);
    replaceConfig(guildConfig, fresh);
    return guildConfig;
}

function buildPanelEmbed(client, config) {
    const avatarUrl = client.user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
    const embed = new EmbedBuilder()
        .setTitle('Contact the support')
        .setDescription(config.ticketPanelMessage || 'Click the button below to create a support ticket.')
        .setColor(getColor('info'))
        .setFooter({
            text: 'Cloudy Support',
            ...(avatarUrl ? { iconURL: avatarUrl } : {}),
        });

    if (avatarUrl) embed.setThumbnail(avatarUrl);
    return embed;
}

function buildPanelButtonRow(config) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel(config.ticketButtonLabel || 'Start Chat')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('💬'),
    );
}

function hasCreateTicketButton(message) {
    return message?.components?.some(row =>
        row.components?.some(component => component.customId === 'create_ticket')
    );
}

async function findPanelMessage(client, guild, config) {
    if (!config.ticketPanelChannelId) return null;

    const channel = await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.messages?.fetch) return null;

    if (config.ticketPanelMessageId) {
        const configured = await channel.messages.fetch(config.ticketPanelMessageId).catch(() => null);
        if (configured && hasCreateTicketButton(configured)) return configured;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    return messages?.find(message =>
        message.author?.id === client.user.id && hasCreateTicketButton(message)
    ) || null;
}

async function updateLivePanel(client, guild, config, guildId) {
    const panel = await findPanelMessage(client, guild, config);
    if (!panel) return false;

    await panel.edit({
        embeds: [buildPanelEmbed(client, config)],
        components: [buildPanelButtonRow(config)],
    });

    if (config.ticketPanelMessageId !== panel.id) {
        config.ticketPanelMessageId = panel.id;
        await persistConfig(client, guildId, config);
    }

    return true;
}

async function repostPanel(client, guild, config, guildId) {
    const channel = await guild.channels.fetch(config.ticketPanelChannelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.isSendable?.()) {
        throw new TitanBotError(
            'Ticket panel channel unavailable',
            ErrorTypes.CONFIGURATION,
            'The configured ticket panel channel is unavailable. Choose a new panel channel first.',
        );
    }

    const oldPanel = await findPanelMessage(client, guild, config);
    const sent = await channel.send({
        embeds: [buildPanelEmbed(client, config)],
        components: [buildPanelButtonRow(config)],
    });

    try {
        config.ticketPanelMessageId = sent.id;
        await persistConfig(client, guildId, config);
    } catch (error) {
        await sent.delete().catch(() => {});
        throw error;
    }

    if (oldPanel && oldPanel.id !== sent.id) {
        await oldPanel.delete().catch(() => {});
    }

    return sent;
}

function formatConfigValue(value, fallback = '`Not set`') {
    return value || fallback;
}

function buildDashboardEmbed(config, guild) {
    const panelMessage = config.ticketPanelMessage || 'Click the button below to create a support ticket.';
    const shortMessage = panelMessage.length > 90 ? `${panelMessage.slice(0, 90)}…` : panelMessage;

    return new EmbedBuilder()
        .setTitle('🎫 Ticket System Dashboard')
        .setDescription(`Manage the ticket system for **${guild.name}**. Every change is saved to PostgreSQL immediately.`)
        .setColor(getColor('info'))
        .addFields(
            { name: 'Panel Channel', value: config.ticketPanelChannelId ? `<#${config.ticketPanelChannelId}>` : '`Not set`', inline: true },
            { name: 'Staff Role', value: config.ticketStaffRoleId ? `<@&${config.ticketStaffRoleId}>` : '`Not set`', inline: true },
            { name: 'Private Close DMs', value: 'Disabled', inline: true },
            { name: 'Open Tickets Category', value: config.ticketCategoryId ? `<#${config.ticketCategoryId}>` : '`Not set`', inline: true },
            { name: 'Closed Tickets Category', value: config.ticketClosedCategoryId ? `<#${config.ticketClosedCategoryId}>` : '`Not set`', inline: true },
            { name: 'Max Tickets/User', value: String(config.maxTicketsPerUser || 3), inline: true },
            { name: 'Ticket Logs Channel', value: config.ticketLogsChannelId ? `<#${config.ticketLogsChannelId}>` : '`Not set`', inline: true },
            { name: 'Transcript Channel', value: config.ticketTranscriptChannelId ? `<#${config.ticketTranscriptChannelId}>` : '`Not set`', inline: true },
            { name: 'Button Label', value: `\`${config.ticketButtonLabel || 'Start Chat'}\``, inline: true },
            { name: 'Panel Message', value: `\`${shortMessage.replace(/`/g, "'")}\``, inline: false },
        )
        .setFooter({ text: 'Cloudy Support • Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

function buildSelectMenu(guildId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`ticket_config_${guildId}`)
        .setPlaceholder('Select a setting to configure...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Edit Panel Message').setDescription('Change the panel description').setValue('panel_message').setEmoji('📝'),
            new StringSelectMenuOptionBuilder().setLabel('Edit Button Label').setDescription('Change the Start Chat button label').setValue('button_label').setEmoji('🏷️'),
            new StringSelectMenuOptionBuilder().setLabel('Change Panel Channel').setDescription('Move the support panel to another channel').setValue('panel_channel').setEmoji('💬'),
            new StringSelectMenuOptionBuilder().setLabel('Change Open Tickets Category').setDescription('Category where new tickets are created').setValue('open_category').setEmoji('📁'),
            new StringSelectMenuOptionBuilder().setLabel('Change Closed Tickets Category').setDescription('Category where closed tickets are moved').setValue('closed_category').setEmoji('📂'),
            new StringSelectMenuOptionBuilder().setLabel('Set Max Tickets per User').setDescription('Limit open tickets per member').setValue('max_tickets').setEmoji('🔢'),
            new StringSelectMenuOptionBuilder().setLabel('Set Ticket Logs Channel').setDescription('Channel for ticket lifecycle logs').setValue('logs_channel').setEmoji('🎫'),
            new StringSelectMenuOptionBuilder().setLabel('Set Transcript Channel').setDescription('Channel for ticket transcripts').setValue('transcript_channel').setEmoji('📜'),
        );
}

function buildButtonRow(guildId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket_cfg_repost_${guildId}`).setLabel('Repost Panel').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
        new ButtonBuilder().setCustomId(`ticket_cfg_staff_${guildId}`).setLabel('Staff Role').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
        new ButtonBuilder().setCustomId(`ticket_cfg_delete_${guildId}`).setLabel('Delete System').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );
}

async function refreshDashboard(rootInteraction, guildConfig, guildId, client) {
    const fresh = await getGuildConfig(client, guildId);
    replaceConfig(guildConfig, fresh);

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(guildConfig, rootInteraction.guild)],
        components: [
            buildButtonRow(guildId),
            new ActionRowBuilder().addComponents(buildSelectMenu(guildId)),
        ],
    });
}

async function showTextModal(selectInteraction, {
    customId,
    title,
    inputId,
    label,
    value = '',
    placeholder,
    maxLength,
    style = TextInputStyle.Short,
}) {
    const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
    const input = new TextInputBuilder()
        .setCustomId(inputId)
        .setLabel(label)
        .setStyle(style)
        .setRequired(true)
        .setMaxLength(maxLength);

    if (placeholder) input.setPlaceholder(placeholder);
    if (value) input.setValue(String(value).slice(0, maxLength));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await selectInteraction.showModal(modal);

    return await selectInteraction.awaitModalSubmit({
        filter: modalInteraction =>
            modalInteraction.user.id === selectInteraction.user.id
            && modalInteraction.customId === customId,
        time: 60_000,
    }).catch(() => null);
}

async function handlePanelMessage(selectInteraction, rootInteraction, config, guildId, client) {
    const modalId = `ticket_panel_message_${selectInteraction.id}`;
    const modalInteraction = await showTextModal(selectInteraction, {
        customId: modalId,
        title: 'Edit Panel Message',
        inputId: 'panel_message',
        label: 'Panel message',
        value: config.ticketPanelMessage || '',
        placeholder: 'Enter the support panel message...',
        maxLength: 2000,
        style: TextInputStyle.Paragraph,
    });
    if (!modalInteraction) return;

    await modalInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    config.ticketPanelMessage = modalInteraction.fields.getTextInputValue('panel_message').trim();
    await persistConfig(client, guildId, config);
    await updateLivePanel(client, rootInteraction.guild, config, guildId);
    await modalInteraction.editReply({ embeds: [successEmbed('Panel Message Updated', 'The support panel message has been updated and saved.')] });
    await refreshDashboard(rootInteraction, config, guildId, client);
}

async function handleButtonLabel(selectInteraction, rootInteraction, config, guildId, client) {
    const modalId = `ticket_button_label_${selectInteraction.id}`;
    const modalInteraction = await showTextModal(selectInteraction, {
        customId: modalId,
        title: 'Edit Button Label',
        inputId: 'button_label',
        label: 'Button label',
        value: config.ticketButtonLabel || 'Start Chat',
        placeholder: 'Start Chat',
        maxLength: 80,
    });
    if (!modalInteraction) return;

    await modalInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    config.ticketButtonLabel = modalInteraction.fields.getTextInputValue('button_label').trim() || 'Start Chat';
    await persistConfig(client, guildId, config);
    await updateLivePanel(client, rootInteraction.guild, config, guildId);
    await modalInteraction.editReply({ embeds: [successEmbed('Button Label Updated', 'The panel button label has been updated and saved.')] });
    await refreshDashboard(rootInteraction, config, guildId, client);
}

async function handleMaxTickets(selectInteraction, rootInteraction, config, guildId, client) {
    const modalId = `ticket_max_${selectInteraction.id}`;
    const modalInteraction = await showTextModal(selectInteraction, {
        customId: modalId,
        title: 'Max Tickets per User',
        inputId: 'max_tickets',
        label: 'Maximum open tickets (1-10)',
        value: String(config.maxTicketsPerUser || 3),
        placeholder: '3',
        maxLength: 2,
    });
    if (!modalInteraction) return;

    await modalInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    const value = Number.parseInt(modalInteraction.fields.getTextInputValue('max_tickets'), 10);

    if (!Number.isInteger(value) || value < 1 || value > 10) {
        await modalInteraction.editReply({ content: 'Enter a number from 1 to 10.' });
        return;
    }

    config.maxTicketsPerUser = value;
    await persistConfig(client, guildId, config);
    await modalInteraction.editReply({ embeds: [successEmbed('Maximum Updated', `Members can now have up to **${value}** open ticket${value === 1 ? '' : 's'}.`)] });
    await refreshDashboard(rootInteraction, config, guildId, client);
}

async function promptChannel(selectInteraction, rootInteraction, config, guildId, client, {
    field,
    title,
    channelTypes,
}) {
    await selectInteraction.deferUpdate();
    const customId = `ticket_channel_${field}_${selectInteraction.id}`;
    const menu = new ChannelSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(title)
        .addChannelTypes(...channelTypes)
        .setMinValues(1)
        .setMaxValues(1);

    await selectInteraction.followUp({
        content: title,
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: interaction =>
            interaction.user.id === selectInteraction.user.id
            && interaction.customId === customId,
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async channelInteraction => {
        try {
            await channelInteraction.update({ components: [] });
            const channelId = channelInteraction.values[0];
            config[field] = channelId;
            await persistConfig(client, guildId, config);

            await channelInteraction.followUp({
                embeds: [successEmbed('Ticket Setting Updated', `${title.replace('Select ', '')} has been saved.`)],
                flags: MessageFlags.Ephemeral,
            });
            await refreshDashboard(rootInteraction, config, guildId, client);
        } catch (error) {
            logger.error('Ticket dashboard channel selection failed', { field, error: error.message });
            await channelInteraction.followUp({ content: 'Could not save that channel. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    });
}

async function handlePanelChannel(selectInteraction, rootInteraction, config, guildId, client) {
    await selectInteraction.deferUpdate();
    const customId = `ticket_panel_channel_${selectInteraction.id}`;
    const menu = new ChannelSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('Select the new panel channel...')
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);

    await selectInteraction.followUp({
        content: 'Select the new panel channel.',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: interaction =>
            interaction.user.id === selectInteraction.user.id
            && interaction.customId === customId,
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async channelInteraction => {
        let sentPanel = null;
        try {
            await channelInteraction.update({ components: [] });
            const newChannelId = channelInteraction.values[0];
            const newChannel = await rootInteraction.guild.channels.fetch(newChannelId).catch(() => null);
            if (!newChannel?.isTextBased?.() || !newChannel.isSendable?.()) {
                throw new Error('Selected channel is not sendable.');
            }

            const oldPanel = await findPanelMessage(client, rootInteraction.guild, config);
            const previousChannelId = config.ticketPanelChannelId;
            const previousMessageId = config.ticketPanelMessageId;

            sentPanel = await newChannel.send({
                embeds: [buildPanelEmbed(client, config)],
                components: [buildPanelButtonRow(config)],
            });

            try {
                config.ticketPanelChannelId = newChannelId;
                config.ticketPanelMessageId = sentPanel.id;
                await persistConfig(client, guildId, config);
            } catch (error) {
                config.ticketPanelChannelId = previousChannelId;
                config.ticketPanelMessageId = previousMessageId;
                await sentPanel.delete().catch(() => {});
                throw error;
            }

            if (oldPanel && oldPanel.id !== sentPanel.id) {
                await oldPanel.delete().catch(() => {});
            }

            await channelInteraction.followUp({
                embeds: [successEmbed('Panel Channel Updated', `The support panel has been moved to <#${newChannelId}>.`)],
                flags: MessageFlags.Ephemeral,
            });
            await refreshDashboard(rootInteraction, config, guildId, client);
        } catch (error) {
            if (sentPanel) await sentPanel.delete().catch(() => {});
            logger.error('Ticket panel channel update failed', { error: error.message });
            await channelInteraction.followUp({ content: 'Could not move the support panel to that channel.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    });
}

async function handleStaffRole(componentInteraction, rootInteraction, config, guildId, client) {
    if (!componentInteraction.deferred && !componentInteraction.replied) {
        await componentInteraction.deferUpdate();
    }

    const customId = `ticket_staff_role_${componentInteraction.id}`;
    const menu = new RoleSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('Select the Ticket Staff Role...')
        .setMinValues(1)
        .setMaxValues(1);

    await componentInteraction.followUp({
        content: 'Select the role that can manage Claim, Pin and Priority.',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.RoleSelect,
        filter: interaction =>
            interaction.user.id === componentInteraction.user.id
            && interaction.customId === customId,
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async roleInteraction => {
        try {
            await roleInteraction.update({ components: [] });
            config.ticketStaffRoleId = roleInteraction.values[0];
            await persistConfig(client, guildId, config);
            await roleInteraction.followUp({
                embeds: [successEmbed('Staff Role Updated', `Ticket staff role set to <@&${config.ticketStaffRoleId}>.`)],
                flags: MessageFlags.Ephemeral,
            });
            await refreshDashboard(rootInteraction, config, guildId, client);
        } catch (error) {
            logger.error('Ticket staff role update failed', { error: error.message });
            await roleInteraction.followUp({ content: 'Could not save that staff role.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    });
}

async function handleRepost(btnInteraction, rootInteraction, config, guildId, client) {
    await btnInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    const panel = await repostPanel(client, rootInteraction.guild, config, guildId);
    await btnInteraction.editReply({ embeds: [successEmbed('Panel Reposted', `A fresh support panel was posted in ${panel.channel}.`)] });
    await refreshDashboard(rootInteraction, config, guildId, client);
}

async function handleDelete(btnInteraction, rootInteraction, config, guildId, client) {
    await btnInteraction.deferReply({ flags: MessageFlags.Ephemeral });
    const panel = await findPanelMessage(client, rootInteraction.guild, config);
    if (panel) await panel.delete().catch(() => {});

    const cleared = {
        ...config,
        ticketPanelChannelId: null,
        ticketPanelMessageId: null,
        ticketPanelMessage: null,
        ticketButtonLabel: 'Start Chat',
        ticketCategoryId: null,
        ticketClosedCategoryId: null,
        ticketStaffRoleId: null,
        ticketLogsChannelId: null,
        ticketTranscriptChannelId: null,
        maxTicketsPerUser: 3,
        dmOnClose: false,
    };

    await persistConfig(client, guildId, cleared);
    replaceConfig(config, cleared);

    await btnInteraction.editReply({ embeds: [successEmbed('Ticket System Deleted', 'The ticket panel and saved ticket-system configuration have been removed.')] });
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [new EmbedBuilder().setTitle('Ticket System Deleted').setDescription('Run `/ticket setup` to create a new ticket system.').setColor(getColor('error'))],
        components: [],
    });
}

export default {
    prefixOnly: false,

    async execute(interaction, _config, client) {
        const guildId = interaction.guildId;
        const guildConfig = await getGuildConfig(client, guildId);

        if (!guildConfig?.ticketPanelChannelId) {
            throw new TitanBotError(
                'Ticket system not configured',
                ErrorTypes.CONFIGURATION,
                'The ticket system has not been set up yet. Run `/ticket setup` first to configure it.',
            );
        }

        await startDashboardSession({
            interaction,
            embeds: [buildDashboardEmbed(guildConfig, interaction.guild)],
            components: [
                buildButtonRow(guildId),
                new ActionRowBuilder().addComponents(buildSelectMenu(guildId)),
            ],
            timeoutMs: DASHBOARD_TIMEOUT_MS,
            selectMenuId: `ticket_config_${guildId}`,
            buttonMatcher: customId =>
                customId === `ticket_cfg_repost_${guildId}`
                || customId === `ticket_cfg_staff_${guildId}`
                || customId === `ticket_cfg_delete_${guildId}`,
            onSelect: async selectInteraction => {
                const selected = selectInteraction.values[0];

                switch (selected) {
                    case 'panel_message':
                        await handlePanelMessage(selectInteraction, interaction, guildConfig, guildId, client);
                        break;
                    case 'button_label':
                        await handleButtonLabel(selectInteraction, interaction, guildConfig, guildId, client);
                        break;
                    case 'panel_channel':
                        await handlePanelChannel(selectInteraction, interaction, guildConfig, guildId, client);
                        break;
                    case 'open_category':
                        await promptChannel(selectInteraction, interaction, guildConfig, guildId, client, {
                            field: 'ticketCategoryId',
                            title: 'Select the open tickets category...',
                            channelTypes: [ChannelType.GuildCategory],
                        });
                        break;
                    case 'closed_category':
                        await promptChannel(selectInteraction, interaction, guildConfig, guildId, client, {
                            field: 'ticketClosedCategoryId',
                            title: 'Select the closed tickets category...',
                            channelTypes: [ChannelType.GuildCategory],
                        });
                        break;
                    case 'max_tickets':
                        await handleMaxTickets(selectInteraction, interaction, guildConfig, guildId, client);
                        break;
                    case 'logs_channel':
                        await promptChannel(selectInteraction, interaction, guildConfig, guildId, client, {
                            field: 'ticketLogsChannelId',
                            title: 'Select the ticket logs channel...',
                            channelTypes: [ChannelType.GuildText],
                        });
                        break;
                    case 'transcript_channel':
                        await promptChannel(selectInteraction, interaction, guildConfig, guildId, client, {
                            field: 'ticketTranscriptChannelId',
                            title: 'Select the transcript channel...',
                            channelTypes: [ChannelType.GuildText],
                        });
                        break;
                    default:
                        await selectInteraction.deferUpdate().catch(() => {});
                }
            },
            onButton: async btnInteraction => {
                if (btnInteraction.customId === `ticket_cfg_repost_${guildId}`) {
                    await handleRepost(btnInteraction, interaction, guildConfig, guildId, client);
                } else if (btnInteraction.customId === `ticket_cfg_staff_${guildId}`) {
                    await handleStaffRole(btnInteraction, interaction, guildConfig, guildId, client);
                } else if (btnInteraction.customId === `ticket_cfg_delete_${guildId}`) {
                    await handleDelete(btnInteraction, interaction, guildConfig, guildId, client);
                }
            },
        });

        // Do not make the dashboard wait for Discord message edits.
        updateLivePanel(client, interaction.guild, guildConfig, guildId).catch(error => {
            logger.warn('Could not normalize live ticket panel after dashboard open', {
                guildId,
                error: error.message,
            });
        });
    },
};
