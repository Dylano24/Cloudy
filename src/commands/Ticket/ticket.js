import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import { getColor } from '../../config/bot.js';
import { successEmbed } from '../../utils/embeds.js';
import { getGuildConfig, setGuildConfig } from '../../services/config/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import ticketConfig from './modules/ticket_dashboard.js';
import {
    formatTicketHealthLines,
    runTicketHealth,
} from '../../services/ticketHealthService.js';

const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

function hasCreateTicketButton(message) {
    return message?.components?.some(row =>
        row.components?.some(component => component.customId === 'create_ticket')
    );
}

function persistentDatabaseAvailable(client) {
    if (!client?.db) return false;
    if (client.db.isDegraded?.()) return false;
    if (typeof client.db.isAvailable === 'function' && !client.db.isAvailable()) return false;
    return typeof client.db.set === 'function';
}

function buildTicketPanel(client, panelMessage, buttonLabel) {
    const avatarUrl = client.user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;

    const embed = new EmbedBuilder()
        .setTitle('Contact the support')
        .setDescription(panelMessage)
        .setColor(getColor('info'))
        .setFooter({
            text: 'Cloudy Support',
            ...(avatarUrl ? { iconURL: avatarUrl } : {}),
        });

    if (avatarUrl) embed.setThumbnail(avatarUrl);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('create_ticket')
            .setLabel(buttonLabel)
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('💬'),
    );

    return { embed, row };
}

function buildHealthEmbed(report, detailed = false) {
    const overall = report.overall === 'healthy'
        ? 'Healthy'
        : report.overall === 'degraded'
            ? 'Degraded'
            : 'Critical';
    const icon = report.overall === 'healthy' ? '✅' : report.overall === 'degraded' ? '⚠️' : '❌';
    const lines = formatTicketHealthLines(report, { includeFixes: detailed });

    const statsLines = [
        `**Overall:** ${icon} ${overall}`,
        `**Critical issues:** ${report.critical}`,
        `**Warnings:** ${report.warnings}`,
        `**Gateway:** ${report.gatewayPing == null ? 'Unknown' : `${report.gatewayPing}ms`}`,
    ];

    if (report.stats) {
        statsLines.push(
            `**Open tickets:** ${report.stats.openCount ?? 0}`,
            `**Closed tickets:** ${report.stats.closedCount ?? 0}`,
        );
    }

    return new EmbedBuilder()
        .setTitle(detailed ? 'Ticket System Debug' : 'Ticket System Health')
        .setDescription(`${statsLines.join('\n')}\n\n${lines.join('\n\n')}`.slice(0, 4096))
        .setColor(report.overall === 'healthy' ? 0x57F287 : report.overall === 'degraded' ? 0xFEE75C : 0xED4245)
        .setFooter({ text: CLOUDY_FOOTER })
        .setTimestamp();
}

async function recoverExistingTicketPanel(interaction, client, guildConfig) {
    const guild = interaction.guild;
    if (!guild || !client?.user?.id) return guildConfig;

    await guild.channels.fetch().catch(() => {});

    const textChannels = guild.channels.cache
        .filter(channel =>
            channel.type === ChannelType.GuildText
            && channel.isTextBased?.()
            && channel.messages?.fetch
        )
        .sort((a, b) => a.rawPosition - b.rawPosition);

    let panelChannel = null;
    let panelMessage = null;

    for (const channel of textChannels.values()) {
        const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (!messages) continue;

        const found = messages.find(message =>
            message.author?.id === client.user.id && hasCreateTicketButton(message)
        );

        if (found) {
            panelChannel = channel;
            panelMessage = found;
            break;
        }
    }

    if (!panelChannel || !panelMessage) return guildConfig;

    const panelButton = panelMessage.components
        .flatMap(row => row.components || [])
        .find(component => component.customId === 'create_ticket');

    const categories = guild.channels.cache.filter(channel => channel.type === ChannelType.GuildCategory);
    const openCategory = categories.find(channel => /support.*help|help.*support|open.*ticket|ticket.*open/i.test(channel.name));
    const closedCategory = categories.find(channel => /closed.*ticket|ticket.*closed/i.test(channel.name));
    const ownerRole = guild.roles.cache.find(role => role.name.trim().toLowerCase() === 'owner');
    const logsChannel = guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildText && /^(ticket|tickets)[-_ ]?logs$/i.test(channel.name)
    );
    const transcriptChannel = guild.channels.cache.find(channel =>
        channel.type === ChannelType.GuildText && /^(ticket|tickets)[-_ ]?transcripts?$/i.test(channel.name)
    );

    const recoveredConfig = {
        ...guildConfig,
        ticketPanelChannelId: panelChannel.id,
        ticketPanelMessageId: panelMessage.id,
        ticketPanelMessage:
            panelMessage.embeds?.[0]?.description
            || guildConfig.ticketPanelMessage
            || 'Click the button below to create a support ticket.',
        ticketButtonLabel:
            panelButton?.label
            || guildConfig.ticketButtonLabel
            || 'Start Chat',
        ticketCategoryId: guildConfig.ticketCategoryId || openCategory?.id || null,
        ticketClosedCategoryId: guildConfig.ticketClosedCategoryId || closedCategory?.id || null,
        ticketStaffRoleId: guildConfig.ticketStaffRoleId || ownerRole?.id || null,
        ticketLogsChannelId: guildConfig.ticketLogsChannelId || logsChannel?.id || null,
        ticketTranscriptChannelId: guildConfig.ticketTranscriptChannelId || transcriptChannel?.id || null,
        dmOnClose: false,
    };

    await setGuildConfig(client, interaction.guildId, recoveredConfig);

    logger.info('Recovered existing ticket panel into persistent guild configuration', {
        guildId: interaction.guildId,
        panelChannelId: panelChannel.id,
        panelMessageId: panelMessage.id,
    });

    return recoveredConfig;
}

export default {
    data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription("Manages the server's ticket system.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Sets up the ticket creation panel in a specified channel.')
                .addChannelOption(option =>
                    option
                        .setName('panel_channel')
                        .setDescription('The channel where the ticket panel will be sent.')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('panel_message')
                        .setDescription('The main message/description for the ticket panel.')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('button_label')
                        .setDescription('The ticket button label (default: Start Chat).')
                        .setRequired(false)
                )
                .addChannelOption(option =>
                    option
                        .setName('category')
                        .setDescription('Category where new tickets will be created.')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false)
                )
                .addChannelOption(option =>
                    option
                        .setName('closed_category')
                        .setDescription('Category where closed tickets will be moved.')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option
                        .setName('staff_role')
                        .setDescription('Role allowed to manage tickets.')
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option
                        .setName('max_tickets_per_user')
                        .setDescription('Maximum open tickets per user (default: 3).')
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Open the interactive ticket system dashboard')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('health')
                .setDescription('Check ticket-system setup, database and permissions')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('debug')
                .setDescription('Show a detailed ticket-system diagnostic report')
        ),

    category: 'ticket',

    async execute(interaction, _config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the `Manage Channels` permission for this action.',
            });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'health' || subcommand === 'debug') {
            try {
                const report = await runTicketHealth(client, interaction.guild);
                await InteractionHelper.safeEditReply(interaction, {
                    content: '',
                    embeds: [buildHealthEmbed(report, subcommand === 'debug')],
                    components: [],
                });
            } catch (error) {
                logger.error('Ticket health diagnostic failed', {
                    guildId: interaction.guildId,
                    error: error.message,
                });
                await InteractionHelper.safeEditReply(interaction, {
                    content: `Ticket diagnostic failed: ${error.message}`,
                    embeds: [],
                    components: [],
                });
            }
            return;
        }

        if (!persistentDatabaseAvailable(client)) {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: 'The persistent database is currently unavailable. Ticket settings cannot be changed until PostgreSQL is connected.',
            });
        }

        if (subcommand === 'dashboard') {
            let existingConfig = await getGuildConfig(client, interaction.guildId);
            if (!existingConfig?.ticketPanelChannelId) {
                existingConfig = await recoverExistingTicketPanel(interaction, client, existingConfig);
            }
            return ticketConfig.execute(interaction, existingConfig, client);
        }

        if (subcommand !== 'setup') return;

        const existingConfig = await getGuildConfig(client, interaction.guildId);
        if (existingConfig?.ticketPanelChannelId) {
            return await replyUserError(interaction, {
                type: ErrorTypes.CONFIGURATION,
                message: `This server already has a ticket system set up in <#${existingConfig.ticketPanelChannelId}>. Use \`/ticket dashboard\` to edit it.`,
            });
        }

        const panelChannel = interaction.options.getChannel('panel_channel');
        const categoryChannel = interaction.options.getChannel('category');
        const closedCategoryChannel = interaction.options.getChannel('closed_category');
        const staffRole = interaction.options.getRole('staff_role');
        const panelMessage = interaction.options.getString('panel_message')
            || 'Click the button below to create a support ticket.';
        const buttonLabel = interaction.options.getString('button_label') || 'Start Chat';
        const maxTicketsPerUser = interaction.options.getInteger('max_tickets_per_user') || 3;

        const { embed, row } = buildTicketPanel(client, panelMessage, buttonLabel);
        let sentPanel = null;

        try {
            sentPanel = await panelChannel.send({ embeds: [embed], components: [row] });

            const nextConfig = {
                ...existingConfig,
                ticketCategoryId: categoryChannel?.id || null,
                ticketClosedCategoryId: closedCategoryChannel?.id || null,
                ticketStaffRoleId: staffRole?.id || null,
                ticketPanelChannelId: panelChannel.id,
                ticketPanelMessageId: sentPanel.id,
                ticketPanelMessage: panelMessage,
                ticketButtonLabel: buttonLabel,
                maxTicketsPerUser,
                dmOnClose: false,
            };

            await setGuildConfig(client, interaction.guildId, nextConfig);

            let successMessage = `The ticket creation panel has been sent to ${panelChannel}.`;
            successMessage += categoryChannel
                ? `\nNew tickets will be created in **${categoryChannel.name}**.`
                : '\nNew tickets will use the default Tickets category.';
            if (closedCategoryChannel) {
                successMessage += `\nClosed tickets will be moved to **${closedCategoryChannel.name}**.`;
            }
            if (staffRole) {
                successMessage += `\n**${staffRole.name}** can manage tickets.`;
            }
            successMessage += `\n\n**Max Tickets Per User:** ${maxTicketsPerUser}`;
            successMessage += '\n**Private close DMs:** Disabled';

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('Ticket Panel Set Up', successMessage)],
            });

            logger.info('Ticket panel setup completed', {
                guildId: interaction.guildId,
                panelChannelId: panelChannel.id,
                categoryId: categoryChannel?.id || null,
                closedCategoryId: closedCategoryChannel?.id || null,
                staffRoleId: staffRole?.id || null,
                maxTicketsPerUser,
                dmOnClose: false,
            });
        } catch (error) {
            if (sentPanel) {
                await sentPanel.delete().catch(() => {});
            }

            logger.error('Ticket setup failed', {
                guildId: interaction.guildId,
                error: error.message,
            });

            await replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'Could not create and persist the ticket system. Check the panel channel permissions and PostgreSQL connection.',
            });
        }
    },
};
