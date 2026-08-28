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
import {
    createEmbedColorPickerSession,
    deleteEmbedColorPickerSession,
} from '../../services/embedColorPickerSessionService.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from '../../services/cloudyBrandingService.js';

const CLOUDY_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
const COLOR_PICKER_URL = process.env.PUBLIC_APP_URL || 'https://cloudy-production-b24f.up.railway.app';
const TRANSIENT_RESPONSE_TIMEOUT = 15_000;
const DEFAULT_FOOTER_TEXT = '© Cloudy Inc. • Quality. Innovation. Performance.';
const POSTABLE_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
];
const THREAD_CONTAINER_TYPES = new Set([ChannelType.GuildForum, ChannelType.GuildMedia]);
const MEDIA_PAGE_HOSTS = new Set([
    'tenor.com',
    'www.tenor.com',
    'giphy.com',
    'www.giphy.com',
    'imgur.com',
    'www.imgur.com',
]);

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

function isDirectImageUrl(url) {
    return /\.(?:png|jpe?g|webp|gif)$/i.test(url.pathname);
}

function decodeHtmlUrl(value) {
    return value
        .replace(/&amp;/gi, '&')
        .replace(/&#x2f;/gi, '/')
        .replace(/&#47;/g, '/')
        .replace(/&quot;/gi, '"');
}

function findPageImage(html) {
    const propertyFirst = html.match(
        /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
    );
    if (propertyFirst?.[1]) return propertyFirst[1];

    const contentFirst = html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/i,
    );
    return contentFirst?.[1] || null;
}

async function resolveMediaUrl(value) {
    if (!isValidUrl(value)) return null;

    const url = new URL(value);
    if (isDirectImageUrl(url)) return url.toString();
    if (!MEDIA_PAGE_HOSTS.has(url.hostname.toLowerCase())) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);

    try {
        const response = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'user-agent': 'Cloudy Discord bot' },
        });
        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || '';
        if (contentType.startsWith('image/')) return response.url;
        if (!contentType.includes('text/html')) return null;

        const pageImage = findPageImage((await response.text()).slice(0, 1_000_000));
        if (!pageImage) return null;

        const resolved = new URL(decodeHtmlUrl(pageImage), response.url);
        return isValidUrl(resolved.toString()) ? resolved.toString() : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function shortValue(value, maxLength) {
    if (!value) return '`Not set`';
    return `\`${value.length > maxLength ? `${value.slice(0, maxLength)}…` : value}\``;
}

function colorToHex(color) {
    const numericColor = Number(color);
    return `#${numericColor.toString(16).padStart(6, '0').slice(-6).toUpperCase()}`;
}

function removeTransientMessage(interaction, message) {
    const timer = setTimeout(async () => {
        if (message?.id && interaction.webhook?.deleteMessage) {
            const deleted = await interaction.webhook.deleteMessage(message.id)
                .then(() => true)
                .catch(() => false);
            if (deleted) return;
        }
        await message?.delete?.().catch(() => {});
    }, TRANSIENT_RESPONSE_TIMEOUT);
    timer.unref?.();
}

function buildMessageEmbed(state, preview = true) {
    const data = { color: state.sideColor };

    if (state.title) data.title = state.title.slice(0, 256);
    if (state.message) data.description = state.message.slice(0, 4096);
    if (state.showLogo) data.thumbnail = { url: CLOUDY_LOGO_URL };
    if (state.bottomLine) data.footer = { text: state.bottomLine.slice(0, 2048) };
    if (state.mediaUrl) data.image = { url: state.mediaUrl };

    if (preview && !state.title && !state.message && !state.mediaUrl) {
        data.description = '*(Use the buttons below to create your message)*';
    }

    return new EmbedBuilder(data);
}

function buildPostedMessagePayload(state) {
    const embed = buildMessageEmbed(state, false).toJSON();

    if (state.bottomLine) {
        embed.footer = { text: `${state.bottomLine.slice(0, 2047)}${MESSAGE_BUILDER_FOOTER_MARKER}` };
    } else {
        delete embed.footer;
    }

    return { embeds: [embed] };
}

async function postBuiltMessage(channel, state, guild) {
    const permissions = channel.permissionsFor(guild.members.me);
    const requiredPermissions = THREAD_CONTAINER_TYPES.has(channel.type)
        ? [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.SendMessagesInThreads,
        ]
        : [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.EmbedLinks,
            channel.isThread?.()
                ? PermissionFlagsBits.SendMessagesInThreads
                : PermissionFlagsBits.SendMessages,
        ];

    if (!permissions?.has(requiredPermissions)) {
        return { ok: false };
    }

    const payload = buildPostedMessagePayload(state);
    if (THREAD_CONTAINER_TYPES.has(channel.type)) {
        const thread = await channel.threads.create({
            name: (state.title || 'Cloudy message').slice(0, 100),
            message: payload,
        });
        return { ok: true, destination: thread };
    }

    await channel.send(payload);
    return { ok: true, destination: channel };
}

function buildControlEmbed(state) {
    return new EmbedBuilder()
        .setTitle('Message builder')
        .setDescription([
            `**Title** › ${shortValue(state.title, 40)}`,
            `**Message** › ${state.message ? `${state.message.length} character(s)` : '`Not set`'}`,
            `**Side color** › \`${colorToHex(state.sideColor)}\``,
            `**Logo** › ${state.showLogo ? 'Enabled' : 'Disabled'}`,
            `**Footer** › ${shortValue(state.bottomLine, 40)}`,
            `**Picture / GIF** › ${state.mediaUrl ? 'Set' : '`Not set`'}`,
        ].join('\n'))
        .setColor(getColor('info'))
        .setFooter({
            text: 'Preview the embed above live',
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
            .setLabel('Edit footer')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📝'),
        new ButtonBuilder()
            .setURL(state.colorPickerUrl)
            .setLabel('Set side color')
            .setStyle(ButtonStyle.Link)
            .setEmoji('🎨'),
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
        .setTitle('Edit footer')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('simple_embed_footer_text')
                    .setLabel('Footer (leave blank to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.bottomLine || '')
                    .setMaxLength(2048)
                    .setRequired(false)
                    .setPlaceholder(DEFAULT_FOOTER_TEXT),
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
    await submitted.deferUpdate().catch(() => {});

    const resolvedMediaUrl = await resolveMediaUrl(mediaUrl);
    if (!resolvedMediaUrl) {
        const invalidMediaMessage = await submitted.followUp({
            embeds: [
                new EmbedBuilder({
                    title: 'Invalid picture or GIF link',
                    description: 'Use a direct `.png`, `.jpg`, `.webp`, or `.gif` link, a Tenor/Giphy/Imgur link, or upload the file with `/embedbuilder media:`.',
                    color: getColor('error'),
                }),
            ],
            flags: MessageFlags.Ephemeral,
        });
        removeTransientMessage(submitted, invalidMediaMessage);
        return;
    }

    state.mediaUrl = resolvedMediaUrl;
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
        .addChannelTypes(...POSTABLE_CHANNEL_TYPES);

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
    removeTransientMessage(buttonInteraction, channelPickerMessage);

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

        const posted = await postBuiltMessage(channel, state, guild).catch(() => ({ ok: false }));
        if (!posted.ok) {
            await replyUserError(channelInteraction, {
                type: ErrorTypes.PERMISSION,
                message: `I need permission to post embeds in ${channel}.`,
            });
            return;
        }

        const sentMessage = await channelInteraction.followUp({
            embeds: [successEmbed('Message sent', `Your message has been posted to ${posted.destination}.`)],
            flags: MessageFlags.Ephemeral,
        });
        removeTransientMessage(channelInteraction, sentMessage);
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
                sideColor: getColor('primary'),
                showLogo: true,
                bottomLine: DEFAULT_FOOTER_TEXT,
                mediaUrl: uploadedMedia?.url || null,
            };

            const colorSessionToken = createEmbedColorPickerSession({
                userId: interaction.user.id,
                onColor: async color => {
                    state.sideColor = color;
                    await refreshBuilder(interaction, state);
                },
            });
            state.colorPickerUrl = `${COLOR_PICKER_URL}/embed-color?session=${colorSessionToken}&color=${encodeURIComponent(colorToHex(state.sideColor))}`;

            await refreshBuilder(interaction, state);

            const dashboardMessage = await interaction.fetchReply();
            const collector = dashboardMessage.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: buttonInteraction =>
                    buttonInteraction.user.id === interaction.user.id &&
                    buttonInteraction.customId.startsWith('simple_embed_'),
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
                            state.sideColor = getColor('primary');
                            state.showLogo = true;
                            state.bottomLine = DEFAULT_FOOTER_TEXT;
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

            collector.on('end', async () => {
                deleteEmbedColorPickerSession(colorSessionToken);
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
