import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    MessageFlags,
    EmbedBuilder,
} from 'discord.js';
import { getGuildConfig, setGuildConfig } from '../../services/config/guildConfig.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import {
    buildCloudyTicketEmbed,
    scheduleTicketReplyDeletion,
} from '../../utils/ticket/ticketBranding.js';
import ticketConfig from './modules/ticket_dashboard.js';
import {
    formatTicketHealthLines,
    runTicketHealth,
} from '../../services/ticketHealthService.js';
import { buildTicketPanelPayload } from '../../services/ticketPanelBuilder.js';

const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

function persistentDatabaseAvailable(client) {
    if (!client?.db) return false;
    if (client.db.isDegraded?.()) return false;
    if (typeof client.db.isAvailable === 'function' && !client.db.isAvailable()) return false;
    return typeof client.db.set === 'function';
}

function normalizeDisabledHealthReport(report) {
    if (report?.config?.ticketSystemDisabled !== true) return report;

    const checks = (report.checks || []).map(check => {
        if (check.id !== 'panel') return check;
        return {
            ...check,
            status: 'info',
            detail: 'Ticket system is intentionally disabled. Saved ticket settings are preserved.',
            fix: null,
        };
    });
    const critical = checks.filter(check => check.status === 'critical').length;
    const warnings = checks.filter(check => check.status === 'warning').length;

    return {
        ...report,
        checks,
        critical,
        warnings,
        overall: critical > 0 ? 'critical' : warnings > 0 ? 'degraded' : 'healthy',
    };
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

    async execute(interaction, routerConfig, client) {
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
                let report = await runTicketHealth(client, interaction.guild);
                report = normalizeDisabledHealthReport(report);
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
            return ticketConfig.execute(interaction, routerConfig || {}, client);
        }

        if (subcommand !== 'setup') return;

        const existingConfig = routerConfig && typeof routerConfig === 'object'
            ? routerConfig
            : await getGuildConfig(client, interaction.guildId);

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

        const nextConfig = {
            ...existingConfig,
            ticketCategoryId: categoryChannel?.id || null,
            ticketClosedCategoryId: closedCategoryChannel?.id || null,
            ticketStaffRoleId: staffRole?.id || null,
            ticketPanelChannelId: panelChannel.id,
            ticketPanelMessageId: null,
            ticketPanelMessage: panelMessage,
            ticketButtonLabel: buttonLabel,
            maxTicketsPerUser,
            dmOnClose: false,
        };

        let sentPanel = null;

        try {
            sentPanel = await panelChannel.send(
                buildTicketPanelPayload(client, interaction.guildId, nextConfig),
            );

            nextConfig.ticketPanelMessageId = sentPanel.id;
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
                content: '',
                embeds: [buildCloudyTicketEmbed({
                    title: 'Ticket Panel Set Up',
                    description: successMessage,
                })],
                components: [],
            });
            scheduleTicketReplyDeletion(interaction);

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
