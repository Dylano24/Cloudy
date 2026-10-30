import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { CloudyError, ErrorTypes } from '../../utils/errorHandler.js';
import { saveGiveaway } from '../../utils/giveaways.js';
import {
    parseDuration,
    validatePrize,
    validateWinnerCount,
    createGiveawayEmbed,
    createGiveawayButtons,
    giveawayPing,
    giveawayText,
} from '../../services/giveawayService.js';
import { canManageGiveaways } from '../../services/giveawayActions.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { botConfig } from '../../config/bot.js';

const GIVEAWAY_MIN_WINNERS = botConfig.giveaways?.minimumWinners ?? 1;
const GIVEAWAY_MAX_WINNERS = botConfig.giveaways?.maximumWinners ?? 10;

export default {
    data: new SlashCommandBuilder()
        .setName('gcreate')
        .setDescription('Starts a new giveaway.')
        .addStringOption(option => option
            .setName('prize')
            .setDescription('What the winner gets, e.g. 1 month VIP.')
            .setMaxLength(256)
            .setRequired(true))
        .addStringOption(option => option
            .setName('duration')
            .setDescription('How long the giveaway runs, e.g. 30m, 2h, 5d.')
            .setRequired(true))
        .addIntegerOption(option => option
            .setName('winners')
            .setDescription('The number of winners to pick.')
            .setMinValue(GIVEAWAY_MIN_WINNERS)
            .setMaxValue(GIVEAWAY_MAX_WINNERS)
            .setRequired(true))
        .addRoleOption(option => option
            .setName('ping')
            .setDescription('Role to tag, e.g. @giveaway. Choose @everyone to tag everyone.'))
        .addStringOption(option => option
            .setName('description')
            .setDescription('Text under "Giveaway time !". Use \\n for a new line.')
            .setMaxLength(1000))
        .addStringOption(option => option
            .setName('requirements')
            .setDescription('What members need to win (default: None).')
            .setMaxLength(500))
        .addStringOption(option => option
            .setName('claim')
            .setDescription('How winners claim their prize; shown when they are tagged.')
            .setMaxLength(500))
        .addChannelOption(option => option
            .setName('channel')
            .setDescription('Channel for the giveaway (default: this channel).')
            .addChannelTypes(ChannelType.GuildText))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        // Sending the giveaway and saving it can take longer than Discord's 3 seconds.
        await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

        if (!interaction.inGuild()) {
            throw new CloudyError('Giveaway command used outside guild', ErrorTypes.VALIDATION,
                'This command can only be used in a server.', { userId: interaction.user.id });
        }
        if (!canManageGiveaways(interaction.member, interaction.guild)) {
            throw new CloudyError('User cannot manage giveaways', ErrorTypes.PERMISSION,
                'Only staff can start a giveaway.', { userId: interaction.user.id, guildId: interaction.guildId });
        }

        const options = interaction.options;
        const durationString = options.getString('duration');
        const durationMs = parseDuration(durationString);
        const winnerCount = options.getInteger('winners');
        validateWinnerCount(winnerCount);
        const prizeName = validatePrize(options.getString('prize'));
        const targetChannel = options.getChannel('channel') || interaction.channel;
        if (!targetChannel?.isTextBased?.()) {
            throw new CloudyError('Target channel is not text-based', ErrorTypes.VALIDATION,
                'The channel must be a text channel.', { channelId: targetChannel?.id });
        }

        const pingRole = options.getRole?.('ping') || null;
        const ping = giveawayPing(pingRole, interaction.guildId);
        const endTime = Date.now() + durationMs;
        const giveaway = {
            messageId: 'placeholder',
            channelId: targetChannel.id,
            guildId: interaction.guildId,
            prize: prizeName,
            description: giveawayText(options.getString('description'), 1000),
            requirements: giveawayText(options.getString('requirements'), 500),
            claim: giveawayText(options.getString('claim'), 500),
            pingRoleId: pingRole?.id || null,
            hostId: interaction.user.id,
            endTime,
            endsAt: endTime,
            winnerCount,
            participants: [],
            isEnded: false,
            ended: false,
            createdAt: new Date().toISOString(),
        };

        const giveawayMessage = await targetChannel.send({
            ...(ping.content ? { content: ping.content } : {}),
            embeds: [createGiveawayEmbed(giveaway, 'active')],
            components: createGiveawayButtons(giveaway, { ended: false }),
            allowedMentions: ping.allowedMentions,
        });

        giveaway.messageId = giveawayMessage.id;
        const saved = await saveGiveaway(interaction.client, interaction.guildId, giveaway);
        if (!saved) {
            logger.warn(`Failed to save giveaway to database: ${giveawayMessage.id}`);
            await giveawayMessage.delete().catch(() => {});
            throw new CloudyError('Giveaway persistence failed', ErrorTypes.DATABASE,
                'The giveaway could not be saved. Please try again.');
        }

        await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed('Giveaway Started',
                `The giveaway for **${prizeName}** is live in ${targetChannel} and ends <t:${Math.floor(endTime / 1000)}:R>.`)],
            flags: MessageFlags.Ephemeral,
        });

        try {
            await logEvent({
                client: interaction.client,
                guildId: interaction.guildId,
                eventType: EVENT_TYPES.GIVEAWAY_CREATE,
                data: {
                    description: `Giveaway created: ${prizeName}`,
                    channelId: targetChannel.id,
                    userId: interaction.user.id,
                    fields: [
                        { name: 'Prize', value: prizeName, inline: true },
                        { name: 'Winners', value: String(winnerCount), inline: true },
                        { name: 'Duration', value: durationString, inline: true },
                        { name: 'Channel', value: targetChannel.toString(), inline: true },
                    ],
                },
            });
        } catch (logError) {
            logger.debug('Error logging giveaway creation event:', logError);
        }
    },
};
