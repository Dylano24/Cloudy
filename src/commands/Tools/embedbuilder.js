import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    ComponentType,
    ChannelType,
    EmbedBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';

const CLOUDY_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
const SESSION_TIMEOUT_MINUTES = 15;
const SESSION_TIMEOUT = SESSION_TIMEOUT_MINUTES * 60_000;

function isValidUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function isImageAttachment(attachment) {
    if (!attachment) return true;
    if (attachment.contentType?.startsWith('image/')) return true;
    return /\.(?:png|jpe?g|webp|gif)(?:\?.*)?$/i.test(attachment.url || attachment.name || '');
}

function shortValue(value, maxLength) {
    if (!value) return '`Not set`';
    return `\`${value.length > maxLength ? `${value.slice(0, maxLength)}…` : value}\``;
}

function buildMessageEmbed(state, preview = true) {
    const embed = new EmbedBuilder().setColor(getColor('primary'));

    if (state.title) embed.setTitle(state.title.slice(0, 256));
    if (state.message) embed.setDescription(state.message.slice(0, 4096));
    if (state.showLogo) embed.setThumbnail(CLOUDY_LOGO_URL);
    if (state.bottomLine) embed.setFooter({ text: state.bottomLine.slice(0, 2048) });
    if (state.mediaUrl) embed.setImage(state.mediaUrl);

    if (preview && !state.title && !state.message && !state.mediaUrl) {
        embed.setDescription('*(Use the buttons below to create your message)*');
    }

    return embed;
}

function buildControlEmbed(state) {
    return new EmbedBuilder()
        .setTitle('Message builder — control panel')
        .setDescription([
            `**Title** › ${shortValue(state.title, 40)}`,
            `**Message** › ${state.message ? `${state.message.length} character(s)` : '`Not set`'}`,
            `**Logo** › ${state.showLogo ? 'Enabled' : 'Disabled'}`,
            `**Bottom line** › ${shortValue(state.bottomLine, 40)}`,
            `**Picture / GIF** › ${state.mediaUrl ? 'Set' : '`Not set`'}`,
        ].join('\n'))
        .setColor(getColor('info'))
        .setFooter({
            text: `The preview above updates live · Closes after ${SESSION_TIMEOUT_MINUTES} min of inactivity`,
        });
}

function buildControls(state) {
    const contentRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_content')
            .setLabel('Edit title and message')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_logo')
            .setLabel(state.showLogo ? 'Remove logo' : 'Add logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('☁️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_footer')
            .setLabel('Edit bottom line')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📝'),
    );

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_media')
            .setLabel('Set picture or GIF')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🖼️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_clear_media')
            .setLabel('Remove picture or GIF')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️')
            .setDisabled(!state.mediaUrl),
        new ButtonBuilder()
            .setCustomId('simple_embed_post')
            .setLabel('Post message')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📤'),
        new ButtonBuilder()
            .setCustomId('simple_embed_reset')
            .setLabel('Reset everything')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('♻️'),
    );

    return [contentRow, actionRow];
}

async function refreshBuilder(interaction, state) {
    return InteractionHelper.safeEditReply(interaction, {
        embeds: [buildMessageEmbed(state), buildControlEmbed(state)],
        components: buildControls(state),
    });
}

async function editContent(buttonInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('simple_embed_content_modal')
        .setTitle('Edit title and message')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('simple_embed_title')
                    .setLabel('Title')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.title || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder('Write your title here'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('simple_embed_message')
                    .setLabel('Message')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(state.message ? state.message.slice(0, 4000) : '')
                    .setMaxLength(4000)
                    .setRequired(false)
                    .setPlaceholder('Write your message here'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(buttonInteraction, modal);
    if (!shown) return;

    const submitted = await buttonInteraction.awaitModalSubmit({
        filter: interaction =>
            interaction.customId === 'simple_embed_content_modal' &&
            interaction.user.id === buttonInteraction.user.id,
        time: 120_000,
    }).catch(() => null);

    if (!submitted) return;

    state.title = submitted.fields.getTextInputValue('simple_embed_title').trim() || null;
    state.message = submitted.fields.getTextInputValue('simple_embed_message').trim() || null;

    await submitted.deferUpdate().catch(() => {});
    await refreshBuilder(rootInteraction, state);
}

async function editBottomLine(buttonInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('simple_embed_footer_modal')
        .setTitle('Edit bottom line')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('simple_embed_footer_text')
                    .setLabel('Bottom line (leave blank to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.bottomLine || '')
                    .setMaxLength(2048)
                    .setRequired(false)
                    .setPlaceholder('Cloudy'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(buttonInteraction, modal);
    if (!shown) return;

    const submitted = await buttonInteraction.awaitModalSubmit({
        filter: interaction =>
            interaction.customId === 'simple_embed_footer_modal' &&
            interaction.user.id === buttonInteraction.user.id,
        time: 120_000,
    }).catch(() => null);

    if (!submitted) return;

    state.bottomLine = submitted.fields.getTextInputValue('simple_embed_footer_text').trim() || null;

    await submitted.deferUpdate().catch(() => {});
    await refreshBuilder(rootInteraction, state);
}

async function editMedia(buttonInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('simple_embed_media_modal')
        .setTitle('Set picture or GIF')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('simple_embed_media_url')
                    .setLabel('Picture or GIF link')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.mediaUrl || '')
                    .setRequired(true)
                    .setPlaceholder('https://example.com/picture.gif'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(buttonInteraction, modal);
    if (!shown) return;

    const submitted = await buttonInteraction.awaitModalSubmit({
        filter: interaction =>
            interaction.customId === 'simple_embed_media_modal' &&
            interaction.user.id === buttonInteraction.user.id,
        time: 120_000,
    }).catch(() => null);

    if (!submitted) return;

    const mediaUrl = submitted.fields.getTextInputValue('simple_embed_media_url').trim();
    if (!isValidUrl(mediaUrl)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Enter a valid public `http://` or `https://` picture or GIF link.',
        });
        return;
    }

    state.mediaUrl = mediaUrl;
    await submitted.deferUpdate().catch(() => {});
    await refreshBuilder(rootInteraction, state);
}

async function postMessage(buttonInteraction, state, guild) {
    if (!state.title && !state.message && !state.mediaUrl) {
        await buttonInteraction.deferUpdate().catch(() => {});
        await replyUserError(buttonInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'Add a title, message, picture, or GIF before posting.',
        });
        return;
    }

    await buttonInteraction.deferUpdate();

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('simple_embed_post_channel')
        .setPlaceholder('Select a channel...')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const channelPickerMessage = await buttonInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Post message')
                .setDescription('Select the channel where the message should be posted.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const collector = channelPickerMessage.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: interaction =>
            interaction.user.id === buttonInteraction.user.id &&
            interaction.customId === 'simple_embed_post_channel',
        time: 60_000,
        max: 1,
    });

    collector.on('collect', async channelInteraction => {
        await channelInteraction.deferUpdate();
        const channel = channelInteraction.channels.first();

        if (!channel) {
            await replyUserError(channelInteraction, {
                type: ErrorTypes.USER_INPUT,
                message: 'The selected channel could not be found.',
            });
            return;
        }

        const permissions = channel.permissionsFor(guild.members.me);
        if (!permissions?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            await replyUserError(channelInteraction, {
                type: ErrorTypes.PERMISSION,
                message: `I need **Send messages** and **Embed links** permissions in ${channel}.`,
            });
            return;
        }

        await channel.send({ embeds: [buildMessageEmbed(state, false)] });
        await channelInteraction.followUp({
            embeds: [successEmbed('Message sent', `Your message has been posted to ${channel}.`)],
            flags: MessageFlags.Ephemeral,
        });
    });
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('embedbuilder')
        .setDescription('Build and post a custom Cloudy message')
        .addAttachmentOption(option =>
            option
                .setName('media')
                .setDescription('Optional picture or GIF shown under the message')
                .setRequired(false),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            const deferred = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferred) return;

            const uploadedMedia = interaction.options.getAttachment('media');
            if (!isImageAttachment(uploadedMedia)) {
                await replyUserError(interaction, {
                    type: ErrorTypes.USER_INPUT,
                    message: 'The uploaded file must be a picture or GIF.',
                });
                return;
            }

            const state = {
                title: null,
                message: null,
                showLogo: true,
                bottomLine: 'Cloudy',
                mediaUrl: uploadedMedia?.url || null,
            };

            await refreshBuilder(interaction, state);

            const dashboardMessage = await interaction.fetchReply();
            const collector = dashboardMessage.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: buttonInteraction =>
                    buttonInteraction.user.id === interaction.user.id &&
                    buttonInteraction.customId.startsWith('simple_embed_'),
                time: SESSION_TIMEOUT,
            });

            collector.on('collect', async buttonInteraction => {
                try {
                    switch (buttonInteraction.customId) {
                        case 'simple_embed_content':
                            await editContent(buttonInteraction, interaction, state);
                            break;
                        case 'simple_embed_logo':
                            state.showLogo = !state.showLogo;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(interaction, state);
                            break;
                        case 'simple_embed_footer':
                            await editBottomLine(buttonInteraction, interaction, state);
                            break;
                        case 'simple_embed_media':
                            await editMedia(buttonInteraction, interaction, state);
                            break;
                        case 'simple_embed_clear_media':
                            state.mediaUrl = null;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(interaction, state);
                            break;
                        case 'simple_embed_post':
                            await postMessage(buttonInteraction, state, interaction.guild);
                            break;
                        case 'simple_embed_reset':
                            state.title = null;
                            state.message = null;
                            state.showLogo = true;
                            state.bottomLine = 'Cloudy';
                            state.mediaUrl = null;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(interaction, state);
                            break;
                        default:
                            await buttonInteraction.deferUpdate();
                    }
                } catch (error) {
                    logger.error('Error in simple embed builder:', error);
                    if (!buttonInteraction.replied && !buttonInteraction.deferred) {
                        await buttonInteraction.deferUpdate().catch(() => {});
                    }
                    await replyUserError(buttonInteraction, {
                        type: ErrorTypes.UNKNOWN,
                        message: 'The message builder could not complete that action.',
                    }).catch(() => {});
                }
            });

            collector.on('end', async (_, reason) => {
                if (reason === 'time') {
                    await InteractionHelper.safeEditReply(interaction, { components: [] }).catch(() => {});
                }
            });
        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in simple embed builder:', error);
            throw new TitanBotError(
                `embedbuilder failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the message builder.',
            );
        }
    },
};
