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
    closeTicket,
    reopenTicket,
    deleteTicket,
    claimTicket,
    unclaimTicket,
    updateTicketPriority,
} from '../../services/ticket.js';
import {
    renameTicketChannel,
    addTicketMember,
    removeTicketMember,
    createTicketTranscriptAttachment,
    getTicketInfo,
} from '../../services/ticketActionsService.js';

function hasCreateTicketButton(message) {
    return message?.components?.some((row) =>
        row.components?.some((component) => component.customId === 'create_ticket')
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

async function recoverExistingTicketPanel(interaction, client, guildConfig) {
    const guild = interaction.guild;
    if (!guild || !client?.user?.id) return guildConfig;

    const textChannels = guild.channels.cache
        .filter((channel) =>
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

        const found = messages.find((message) =>
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
        .flatMap((row) => row.components || [])
        .find((component) => component.customId === 'create_ticket');

    const categories = guild.channels.cache.filter((channel) => channel.type === ChannelType.GuildCategory);
    const openCategory = categories.find((channel) => /support.*help|help.*support|open.*ticket|ticket.*open/i.test(channel.name));
    const closedCategory = categories.find((channel) => /closed.*ticket|ticket.*closed/i.test(channel.name));
    const ownerRole = guild.roles.cache.find((role) => role.name.trim().toLowerCase() === 'owner');
    const logsChannel = guild.channels.cache.find((channel) =>
        channel.type === ChannelType.GuildText && /^(ticket|tickets)[-_ ]?logs$/i.test(channel.name)
    );
    const transcriptChannel = guild.channels.cache.find((channel) =>
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
        dmOnClose: guildConfig.dmOnClose ?? false,
    };

    await setGuildConfig(client, interaction.guildId, recoveredConfig);
    logger.info('Recovered existing ticket panel into persistent guild configuration', {
        guildId: interaction.guildId,
        panelChannelId: panelChannel.id,
        panelMessageId: panelMessage.id,
    });
    return recoveredConfig;
}

const data = new SlashCommandBuilder()
    .setName('ticket')
    .setDescription("Manage the server's complete ticket system")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((subcommand) =>
        subcommand
            .setName('setup')
            .setDescription('Set up the ticket creation panel')
            .addChannelOption((option) =>
                option
                    .setName('panel_channel')
                    .setDescription('Channel where the ticket panel is sent')
                    .addChannelTypes(ChannelType.GuildText)
                    .setRequired(true)
            )
            .addStringOption((option) =>
                option.setName('panel_message').setDescription('Ticket panel description').setRequired(true)
            )
            .addStringOption((option) =>
                option.setName('button_label').setDescription('Ticket button label (default: Start Chat)')
            )
            .addChannelOption((option) =>
                option.setName('category').setDescription('Category for open tickets').addChannelTypes(ChannelType.GuildCategory)
            )
            .addChannelOption((option) =>
                option.setName('closed_category').setDescription('Category for closed tickets').addChannelTypes(ChannelType.GuildCategory)
            )
            .addRoleOption((option) =>
                option.setName('staff_role').setDescription('Role allowed to manage tickets')
            )
            .addIntegerOption((option) =>
                option.setName('max_tickets_per_user').setDescription('Maximum open tickets per user').setMinValue(1).setMaxValue(10)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('dashboard').setDescription('Open the interactive ticket system dashboard')
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('close')
            .setDescription('Close the current ticket')
            .addStringOption((option) => option.setName('reason').setDescription('Close reason').setMaxLength(500))
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('reopen').setDescription('Reopen the current closed ticket')
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('delete').setDescription('Delete the current ticket and save its configured transcript')
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('claim').setDescription('Claim the current ticket')
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('unclaim').setDescription('Release your claim on the current ticket')
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('rename')
            .setDescription('Rename the current ticket channel')
            .addStringOption((option) => option.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(90))
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('add')
            .setDescription('Add a member to the current ticket')
            .addUserOption((option) => option.setName('user').setDescription('Member to add').setRequired(true))
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('remove')
            .setDescription('Remove a member from the current ticket')
            .addUserOption((option) => option.setName('user').setDescription('Member to remove').setRequired(true))
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('transcript').setDescription('Generate and download an HTML transcript now')
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('priority')
            .setDescription('Set the current ticket priority')
            .addStringOption((option) =>
                option
                    .setName('level')
                    .setDescription('Priority level')
                    .setRequired(true)
                    .addChoices(
                        { name: 'None', value: 'none' },
                        { name: 'Low', value: 'low' },
                        { name: 'Medium', value: 'medium' },
                        { name: 'High', value: 'high' },
                        { name: 'Urgent', value: 'urgent' },
                    )
            )
    )
    .addSubcommand((subcommand) =>
        subcommand.setName('info').setDescription('Show current ticket details and access')
    );

export default {
    data,
    category: 'Ticket',

    async execute(interaction, _config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
            return replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the `Manage Channels` permission for this action.',
            });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'dashboard') {
                if (!persistentDatabaseAvailable(client)) {
                    return replyUserError(interaction, {
                        type: ErrorTypes.CONFIGURATION,
                        message: 'The persistent database is unavailable. Ticket configuration cannot be changed until PostgreSQL is connected.',
                    });
                }
                let existingConfig = await getGuildConfig(client, interaction.guildId);
                if (!existingConfig?.ticketPanelChannelId) {
                    existingConfig = await recoverExistingTicketPanel(interaction, client, existingConfig);
                }
                return ticketConfig.execute(interaction, existingConfig, client);
            }

            if (subcommand === 'setup') {
                if (!persistentDatabaseAvailable(client)) {
                    return replyUserError(interaction, {
                        type: ErrorTypes.CONFIGURATION,
                        message: 'The persistent database is unavailable. Ticket settings cannot be changed until PostgreSQL is connected.',
                    });
                }

                const existingConfig = await getGuildConfig(client, interaction.guildId);
                if (existingConfig?.ticketPanelChannelId) {
                    return replyUserError(interaction, {
                        type: ErrorTypes.CONFIGURATION,
                        message: `This server already has a ticket panel in <#${existingConfig.ticketPanelChannelId}>. Use \`/ticket dashboard\` to edit it.`,
                    });
                }

                const panelChannel = interaction.options.getChannel('panel_channel', true);
                const categoryChannel = interaction.options.getChannel('category');
                const closedCategoryChannel = interaction.options.getChannel('closed_category');
                const staffRole = interaction.options.getRole('staff_role');
                const panelMessage = interaction.options.getString('panel_message', true);
                const buttonLabel = interaction.options.getString('button_label') || 'Start Chat';
                const maxTicketsPerUser = interaction.options.getInteger('max_tickets_per_user') || 3;
                const { embed, row } = buildTicketPanel(client, panelMessage, buttonLabel);
                let sentPanel = null;

                try {
                    sentPanel = await panelChannel.send({ embeds: [embed], components: [row] });
                    await setGuildConfig(client, interaction.guildId, {
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
                    });

                    const details = [
                        `Panel: ${panelChannel}`,
                        categoryChannel ? `Open category: **${categoryChannel.name}**` : 'Open category: automatic/default',
                        closedCategoryChannel ? `Closed category: **${closedCategoryChannel.name}**` : null,
                        staffRole ? `Staff: ${staffRole}` : null,
                        `Max tickets/member: **${maxTicketsPerUser}**`,
                    ].filter(Boolean).join('\n');

                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [successEmbed('Ticket Panel Set Up', details)],
                    });
                } catch (error) {
                    if (sentPanel) await sentPanel.delete().catch(() => {});
                    throw error;
                }
            }

            if (subcommand === 'close') {
                const reason = interaction.options.getString('reason') || 'No reason provided';
                await closeTicket(interaction.channel, interaction.user, reason);
                return InteractionHelper.safeEditReply(interaction, { content: '✅ Ticket closed.' });
            }

            if (subcommand === 'reopen') {
                await reopenTicket(interaction.channel, interaction.user);
                return InteractionHelper.safeEditReply(interaction, { content: '✅ Ticket reopened.' });
            }

            if (subcommand === 'delete') {
                await deleteTicket(interaction.channel, interaction.user);
                return InteractionHelper.safeEditReply(interaction, { content: '🗑️ Ticket deletion scheduled. A transcript will be saved if a transcript channel is configured.' });
            }

            if (subcommand === 'claim') {
                await claimTicket(interaction.channel, interaction.member);
                return InteractionHelper.safeEditReply(interaction, { content: '✅ Ticket claimed.' });
            }

            if (subcommand === 'unclaim') {
                await unclaimTicket(interaction.channel, interaction.member);
                return InteractionHelper.safeEditReply(interaction, { content: '✅ Ticket unclaimed.' });
            }

            if (subcommand === 'rename') {
                const result = await renameTicketChannel(
                    interaction.channel,
                    interaction.options.getString('name', true),
                    interaction.user,
                );
                return InteractionHelper.safeEditReply(interaction, { content: `✅ Ticket renamed to **#${result.name}**.` });
            }

            if (subcommand === 'add') {
                const user = interaction.options.getUser('user', true);
                await addTicketMember(interaction.channel, user, interaction.user);
                return InteractionHelper.safeEditReply(interaction, { content: `✅ ${user} added to this ticket.` });
            }

            if (subcommand === 'remove') {
                const user = interaction.options.getUser('user', true);
                await removeTicketMember(interaction.channel, user, interaction.user);
                return InteractionHelper.safeEditReply(interaction, { content: `✅ ${user} removed from this ticket.` });
            }

            if (subcommand === 'transcript') {
                const result = await createTicketTranscriptAttachment(interaction.channel);
                return InteractionHelper.safeEditReply(interaction, {
                    content: `📜 Transcript generated with **${result.messageCount} messages**.`,
                    files: [result.attachment],
                });
            }

            if (subcommand === 'priority') {
                const level = interaction.options.getString('level', true);
                await updateTicketPriority(interaction.channel, level, interaction.user);
                return InteractionHelper.safeEditReply(interaction, { content: `✅ Ticket priority changed to **${level}**.` });
            }

            if (subcommand === 'info') {
                const info = await getTicketInfo(interaction.channel);
                const access = (info.memberAccess || []).map((id) => `<@${id}>`).join(', ') || 'No additional member overwrites';
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('🎫 Ticket Information')
                            .addFields(
                                { name: 'Creator', value: `<@${info.userId}>`, inline: true },
                                { name: 'Status', value: info.status || 'open', inline: true },
                                { name: 'Priority', value: info.priority || 'none', inline: true },
                                { name: 'Claimed By', value: info.claimedBy ? `<@${info.claimedBy}>` : 'Not claimed', inline: true },
                                { name: 'Created', value: info.createdAt ? `<t:${Math.floor(new Date(info.createdAt).getTime() / 1000)}:F>` : 'Unknown', inline: false },
                                { name: 'Member Access', value: access.slice(0, 1000), inline: false },
                            ),
                    ],
                });
            }
        } catch (error) {
            logger.error(`Ticket /${subcommand} failed`, {
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                userId: interaction.user.id,
                error: error?.message || String(error),
            });
            return InteractionHelper.safeEditReply(interaction, {
                content: `❌ ${error?.userMessage || error?.message || 'Ticket action failed.'}`,
                embeds: [],
                components: [],
            });
        }
    },
};
