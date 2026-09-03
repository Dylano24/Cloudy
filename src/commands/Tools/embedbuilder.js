import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    FileUploadBuilder,
    LabelBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
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
import { CLOUDY_LOGO_URL, isCloudyLogoUrl } from '../../services/cloudyLogoService.js';
import {
    DISCORD_EMBED_TOTAL_TEXT_LIMIT,
    fitEmbedToTextBudget,
    getEmbedTextLength,
} from '../../utils/discordEmbedLimits.js';
import {
    getEveryGuildChannel,
    refreshAllTicketChannels,
} from '../../services/ticketChannelBrowserService.js';
import { convertVideoUrlToGif } from '../../services/videoGifService.js';
import { openEmbedManager, saveModifiedEmbed } from '../../services/embedManagerService.js';
import { registerCloudyEmbedMessage } from '../../services/embedRegistryService.js';

const COLOR_PICKER_URL = process.env.PUBLIC_APP_URL || 'https://cloudy-production-b24f.up.railway.app';
const TRANSIENT_RESPONSE_TIMEOUT = 15_000;
const DEFAULT_FOOTER_TEXT = '© Cloudy Inc. • Quality. Innovation. Performance.';
const DISCORD_TEXT_INPUT_LIMIT = 4000;
const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const CHANNEL_PAGE_SIZE = 100;
const CHANNEL_SELECT_SIZE = 25;
const OWNER_SERVER_LIMIT = 125;
const BUILDER_IDLE_TIMEOUT = 30 * 60_000;

function getMediaKind(attachment) {
    if (!attachment) return null;

    const contentType = String(attachment.contentType || '').toLowerCase();
    const source = String(attachment.url || attachment.name || '').toLowerCase();

    if (contentType.startsWith('image/') || /\.(?:png|jpe?g|webp|gif)(?:\?.*)?$/i.test(source)) {
        return 'image';
    }

    if (contentType.startsWith('video/') || /\.(?:mp4|mov|m4v|webm|mkv|avi|3gp|3g2|mts|m2ts|hevc)(?:\?.*)?$/i.test(source)) {
        return 'video';
    }

    return null;
}

function hasMedia(state) {
    return Boolean(state.mediaUrl || state.mediaBuffer);
}

function shortValue(value, maxLength) {
    if (!value) return '`Not set`';
    return `\`${value.length > maxLength ? `${value.slice(0, maxLength)}…` : value}\``;
}

function visibleBuilderTitle(value) {
    if (!value) return '`Not set`';
    // Custom emoji markup must stay outside a code span so Discord renders the
    // emoji itself instead of exposing its internal name and numeric ID.
    return String(value).replace(/\s+/g, ' ').trim();
}

function isPublicToEveryone(guild, channel) {
    try {
        return Boolean(channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel));
    } catch {
        return false;
    }
}

function buildChannelOption(guild, channel) {
    const visibility = isPublicToEveryone(guild, channel) ? 'Public' : 'Private';
    const typeLabel = channel.type === ChannelType.GuildAnnouncement ? 'Announcement' : 'Text';
    const parent = channel.parent?.name ? ` • ${channel.parent.name}` : '';

    return new StringSelectMenuOptionBuilder()
        .setLabel(`${channel.type === ChannelType.GuildAnnouncement ? '📢' : '#'} ${String(channel.name || channel.id)}`.slice(0, 100))
        .setDescription(`${visibility} • ${typeLabel}${parent} • ${channel.id}`.slice(0, 100))
        .setValue(channel.id);
}

function buildChannelPicker(guild, page = 0) {
    const channels = getEveryGuildChannel(guild);
    const pageCount = Math.max(1, Math.ceil(channels.length / CHANNEL_PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
    const pageStart = safePage * CHANNEL_PAGE_SIZE;
    const pageChannels = channels.slice(pageStart, pageStart + CHANNEL_PAGE_SIZE);
    const pageEnd = pageStart + pageChannels.length;
    const components = [];

    for (let offset = 0; offset < pageChannels.length; offset += CHANNEL_SELECT_SIZE) {
        const segment = pageChannels.slice(offset, offset + CHANNEL_SELECT_SIZE);
        const first = pageStart + offset + 1;
        const last = first + segment.length - 1;
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_post_channel:${safePage}:${Math.floor(offset / CHANNEL_SELECT_SIZE)}`)
            .setPlaceholder(`Channels ${first}-${last} of ${channels.length}`)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...segment.map(channel => buildChannelOption(guild, channel)));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    if (pageCount > 1) {
        components.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`simple_embed_channel_page:${Math.max(0, safePage - 1)}`)
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(safePage <= 0),
                new ButtonBuilder()
                    .setCustomId(`simple_embed_channel_page:${Math.min(pageCount - 1, safePage + 1)}`)
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(safePage >= pageCount - 1),
            ),
        );
    }

    return {
        embeds: [
            new EmbedBuilder()
                .setTitle('Post message')
                .setDescription([
                    'Select the channel where the message should be posted.',
                    '',
                    `**Text channels loaded:** ${channels.length}`,
                    `**Showing:** ${channels.length ? `${pageStart + 1}-${pageEnd}` : '0'} of ${channels.length} • Page ${safePage + 1}/${pageCount}`,
                    '',
                    'All public and private text/announcement channels available to Cloudy are included.',
                ].join('\n'))
                .setColor(getColor('info')),
        ],
        components,
        channels,
        page: safePage,
    };
}

function colorToHex(color) {
    const numericColor = Number(color);
    return `#${numericColor.toString(16).padStart(6, '0').slice(-6).toUpperCase()}`;
}

function splitLongText(value, maxLength = DISCORD_EMBED_DESCRIPTION_LIMIT) {
    if (!value) return [];

    const chunks = [];
    let remaining = value;

    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        if (splitAt < Math.floor(maxLength * 0.5)) {
            splitAt = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitAt < Math.floor(maxLength * 0.5)) {
            splitAt = maxLength;
        }

        const chunk = remaining.slice(0, splitAt).trimEnd();
        if (chunk) chunks.push(chunk);
        remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
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

async function replaceSaveFeedback(interaction, message, payload) {
    if (message?.id && interaction.webhook?.editMessage) {
        return interaction.webhook.editMessage(message.id, payload).catch(() => null);
    }
    return message?.edit?.(payload).catch(() => null) || null;
}

// Acknowledging the click immediately makes Save feel instant, while the
// actual message edit still remains the source of truth before we confirm it.
async function saveExistingEmbed(buttonInteraction, guild, state) {
    const saved = await saveModifiedEmbed(guild, state);

    if (!saved.ok) {
        const failure = await buttonInteraction.followUp({
            content: null,
            embeds: [new EmbedBuilder()
                .setTitle('Could not save changes')
                .setDescription('The existing embed could not be updated. It may have been deleted or Cloudy may no longer have access.')
                .setColor(getColor('error'))],
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (failure) removeTransientMessage(buttonInteraction, failure);
        else {
            await replyUserError(buttonInteraction, {
                type: ErrorTypes.UNKNOWN,
                message: 'The existing embed could not be updated. It may have been deleted or Cloudy may no longer have access.',
            });
        }
        return saved;
    }

    void refreshBuilder(buttonInteraction, state).catch(() => {});
    const confirmation = await buttonInteraction.followUp({
        content: null,
        embeds: [successEmbed('Changes saved', `The existing embed in ${saved.channel} was updated.`)],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
    }).catch(() => null);
    if (confirmation) removeTransientMessage(buttonInteraction, confirmation);
    return saved;
}

function buildSingleEmbed(state, description = null, options = {}) {
    const {
        preview = false,
        includeTitle = true,
        includeLogo = true,
        includeFooter = true,
        includeMedia = true,
        posted = false,
    } = options;
    const data = { color: state.sideColor };

    if (includeTitle && state.title) data.title = state.title.slice(0, 256);
    if (description) data.description = description.slice(0, DISCORD_EMBED_DESCRIPTION_LIMIT);
    if (includeLogo && state.showLogo) data.thumbnail = { url: CLOUDY_LOGO_URL };
    if (includeFooter && state.bottomLine) {
        const footerLimit = posted ? 2047 : 2048;
        const marker = posted ? MESSAGE_BUILDER_FOOTER_MARKER : '';
        data.footer = { text: `${state.bottomLine.slice(0, footerLimit)}${marker}` };
    }
    if (includeMedia && state.mediaBuffer && state.mediaName) {
        data.image = { url: `attachment://${state.mediaName}` };
    } else if (includeMedia && state.mediaUrl) {
        data.image = { url: state.mediaUrl };
    }

    return new EmbedBuilder(data);
}

function buildPreviewEmbed(state) {
    const chunks = splitLongText(state.message);
    const firstChunk = chunks[0] || null;

    if (state.modifyTarget?.sourceEmbedData) {
        const source = state.modifyTarget.sourceEmbedData;
        const data = { ...source, color: state.sideColor };

        if (state.title) data.title = state.title.slice(0, 256);
        else delete data.title;

        if (firstChunk) data.description = firstChunk.slice(0, DISCORD_EMBED_DESCRIPTION_LIMIT);
        else delete data.description;

        if (Array.isArray(state.embedFields) && state.embedFields.length) {
            data.fields = state.embedFields.slice(0, 25).map(field => ({
                name: String(field.name || '\u200B').slice(0, 256),
                value: String(field.value || '\u200B').slice(0, 1024),
                inline: Boolean(field.inline),
            }));
        } else {
            delete data.fields;
        }

        if (state.removeExistingLogo) {
            delete data.thumbnail;
        } else if (state.showLogo) {
            data.thumbnail = { url: CLOUDY_LOGO_URL };
        } else if (isCloudyLogoUrl(data.thumbnail?.url)) {
            delete data.thumbnail;
        }

        if (chunks.length <= 1) {
            if (state.bottomLine) {
                data.footer = { ...(data.footer || {}), text: state.bottomLine.slice(0, 2048) };
            } else {
                delete data.footer;
            }
        }

        if (state.mediaBuffer && state.mediaName) {
            data.image = { url: `attachment://${state.mediaName}` };
        } else if (state.mediaUrl) {
            data.image = { url: state.mediaUrl };
        } else {
            delete data.image;
        }

        return new EmbedBuilder(data);
    }

    const embed = buildSingleEmbed(state, firstChunk, {
        preview: true,
        includeFooter: chunks.length <= 1,
        includeMedia: true,
    });

    if (chunks.length > 1) {
        embed.addFields({
            name: 'Long message',
            value: `This message continues for ${chunks.length - 1} more part(s) when posted.`,
        });
    }

    return embed;
}

export function buildPostedEmbeds(state) {
    const baseEmbed = buildSingleEmbed(state, null, { posted: true });
    const descriptionLimit = Math.max(
        1,
        Math.min(
            DISCORD_EMBED_DESCRIPTION_LIMIT,
            DISCORD_EMBED_TOTAL_TEXT_LIMIT - getEmbedTextLength(baseEmbed),
        ),
    );
    const chunks = splitLongText(state.message, descriptionLimit);
    const descriptions = chunks.length > 0 ? chunks : [null];

    return descriptions.map((description, index) => {
        const isFirst = index === 0;
        const isLast = index === descriptions.length - 1;
        return buildSingleEmbed(state, description, {
            includeTitle: isFirst,
            includeLogo: isFirst,
            includeFooter: isLast,
            includeMedia: isLast,
            posted: true,
        });
    });
}

async function postBuiltMessage(channel, state, guild) {
    const permissions = channel.permissionsFor(guild.members.me);
    const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.SendMessages,
    ];

    if (state.mediaBuffer) requiredPermissions.push(PermissionFlagsBits.AttachFiles);

    if (!permissions?.has(requiredPermissions)) {
        return { ok: false };
    }

    const embeds = buildPostedEmbeds(state);
    for (let index = 0; index < embeds.length; index += 1) {
        const isLast = index === embeds.length - 1;
        const payload = { embeds: [embeds[index]] };

        if (isLast && state.mediaBuffer && state.mediaName) {
            payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
        }

        const sent = await channel.send(payload);
        await registerCloudyEmbedMessage(sent, 'embed-builder');
    }

    return { ok: true, destination: channel };
}

function buildControlEmbed(state) {
    const mediaLabel = state.mediaConvertedFromVideo
        ? 'Video converted to GIF'
        : hasMedia(state)
            ? 'Picture / GIF set'
            : '`Not set`';

    return new EmbedBuilder()
        .setTitle('Message builder')
        .setDescription([
            `**Mode** › ${state.modifyTarget ? 'Editing existing embed' : 'New embed'}`,
            `**Title** › ${visibleBuilderTitle(state.title)}`,
            `**Message** › ${state.message ? `${state.message.length} character(s)` : '`Not set`'}`,
            `**Side color** › \`${colorToHex(state.sideColor)}\``,
            `**Logo** › ${state.showLogo ? 'Enabled' : 'Disabled'}`,
            `**Footer** › ${shortValue(state.bottomLine, 40)}`,
            `**Media** › ${mediaLabel}`,
        ].join('\n'))
        .setColor(0xFFFFFF)
        .setFooter({ text: 'Preview the embed above live' });
}

export function buildBuilderEmbeds(state) {
    const controlEmbed = buildControlEmbed(state);
    const previewBudget = DISCORD_EMBED_TOTAL_TEXT_LIMIT - getEmbedTextLength(controlEmbed);
    const previewData = fitEmbedToTextBudget(buildPreviewEmbed(state), previewBudget);
    return [new EmbedBuilder(previewData), controlEmbed];
}

function buildControls(state) {
    const sourceHasLogo = Boolean(state.modifyTarget?.sourceEmbedData?.thumbnail?.url);
    const hasLogo = !state.removeExistingLogo && (state.showLogo || sourceHasLogo);
    const contentRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setURL(state.contentEditorUrl)
            .setLabel('Edit title and message')
            .setStyle(ButtonStyle.Link)
            .setEmoji('✍🏼'),
        new ButtonBuilder()
            .setCustomId('simple_embed_logo')
            .setLabel('Add Cloudy logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('☁️')
            .setDisabled(state.showLogo && !state.removeExistingLogo),
        new ButtonBuilder()
            .setCustomId('simple_embed_remove_logo')
            .setLabel('Remove logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️')
            .setDisabled(!hasLogo),
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
            .setLabel('Set picture/video GIF')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📷'),
        new ButtonBuilder()
            .setCustomId('simple_embed_clear_media')
            .setLabel('Remove media')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️')
            .setDisabled(!hasMedia(state)),
        new ButtonBuilder()
            .setCustomId('simple_embed_post')
            .setLabel(state.modifyTarget ? 'Save changes' : 'Post message')
            .setStyle(ButtonStyle.Success)
            .setEmoji(state.modifyTarget ? '💾' : '📤'),
        new ButtonBuilder()
            .setCustomId('simple_embed_reset')
            .setLabel('Reset everything')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('♻️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_modify')
            .setLabel('Modify embed')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛠️'),
    );

    return [contentRow, actionRow];
}

function getPreviewUpdateQueue(state) {
    if (!state.previewUpdateQueue) {
        state.previewUpdateQueue = {
            pending: null,
            running: false,
        };
    }
    return state.previewUpdateQueue;
}

async function flushPreviewUpdateQueue(state) {
    const queue = getPreviewUpdateQueue(state);
    if (queue.running) return;
    queue.running = true;

    try {
        while (queue.pending) {
            const update = queue.pending;
            queue.pending = null;
            let updated = false;
            try {
                updated = await InteractionHelper.safeEditReply(update.interaction, update.payload);
            } catch {
                updated = false;
            }
            // A newer state is already queued. Its edit is authoritative, so a
            // failed/superseded older update must not make the editor look dead.
            update.resolve(updated || Boolean(queue.pending));
        }
    } finally {
        queue.running = false;
    }
}

function refreshBuilder(interaction, state) {
    if (state.colorSessionToken) {
        state.colorPickerUrl = `${COLOR_PICKER_URL}/embed-color?session=${state.colorSessionToken}&color=${encodeURIComponent(colorToHex(state.sideColor))}`;
    }

    const payload = {
        embeds: buildBuilderEmbeds(state),
        components: buildControls(state),
        attachments: [],
    };

    if (state.mediaBuffer && state.mediaName) {
        payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
    }

    const queue = getPreviewUpdateQueue(state);
    return new Promise(resolve => {
        // Keep only the newest complete preview while one Discord edit is in
        // flight. This preserves all state, but prevents an older selected
        // embed from rendering after the user has already switched again.
        if (queue.pending) queue.pending.resolve(true);
        queue.pending = { interaction, payload, resolve };
        void flushPreviewUpdateQueue(state);
    });
}

async function editContent(buttonInteraction, state) {
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
                    .setValue(state.message ? state.message.slice(0, DISCORD_TEXT_INPUT_LIMIT) : '')
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
    await refreshBuilder(submitted, state);
    await browseOwnerServers(submitted, submitted, state);
}

async function editBottomLine(buttonInteraction, state) {
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
    await refreshBuilder(submitted, state);
}

async function editMedia(buttonInteraction, state) {
    const upload = new FileUploadBuilder()
        .setCustomId('simple_embed_media_file')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const modal = new ModalBuilder()
        .setCustomId('simple_embed_media_modal')
        .setTitle('Set picture/video GIF')
        .addLabelComponents(
            new LabelBuilder()
                .setLabel('Upload picture, video or GIF')
                .setDescription('Videos are converted to GIF and shown inside the embed')
                .setFileUploadComponent(upload),
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

    const uploadedFiles = submitted.fields.getUploadedFiles('simple_embed_media_file', true);
    const uploadedMedia = uploadedFiles?.first?.() || null;
    const mediaKind = getMediaKind(uploadedMedia);

    if (!mediaKind) {
        const invalidMediaMessage = await submitted.reply({
            embeds: [
                new EmbedBuilder({
                    title: 'Invalid media file',
                    description: 'Upload a picture, GIF, or video file.',
                    color: getColor('error'),
                }),
            ],
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (invalidMediaMessage) removeTransientMessage(submitted, invalidMediaMessage);
        return;
    }

    if (mediaKind === 'video') {
        await submitted.deferUpdate().catch(() => {});

        try {
            const converted = await convertVideoUrlToGif(uploadedMedia.url);
            state.mediaUrl = null;
            state.mediaBuffer = converted.buffer;
            state.mediaName = converted.filename;
            state.mediaConvertedFromVideo = true;
            await refreshBuilder(submitted, state);
        } catch (error) {
            logger.error('Video to GIF conversion failed:', error);
            const message = error?.code === 'VIDEO_TOO_SHORT'
                ? 'The video must be at least 1 second long.'
                : error?.code === 'VIDEO_TOO_LONG'
                    ? 'The video must be no longer than 6 seconds.'
                    : error?.code === 'GIF_TOO_LARGE'
                        ? 'The converted GIF is too large. Try a shorter video.'
                        : 'Cloudy could not convert that video to a GIF.';

            const failedMessage = await submitted.followUp({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Video conversion failed')
                        .setDescription(message)
                        .setColor(getColor('error')),
                ],
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            }).catch(() => null);
            if (failedMessage) removeTransientMessage(submitted, failedMessage);
        }
        return;
    }

    state.mediaUrl = uploadedMedia.url;
    state.mediaBuffer = null;
    state.mediaName = uploadedMedia.name || null;
    state.mediaConvertedFromVideo = false;

    await submitted.deferUpdate().catch(() => {});
    await refreshBuilder(submitted, state);
}

async function getSharedOwnerGuilds(client, userId) {
    const shared = [];

    for (const guild of client.guilds.cache.values()) {
        const member = guild.members.cache.get(userId)
            || await guild.members.fetch(userId).catch(() => null);
        if (member) shared.push(guild);
    }

    return shared.sort((a, b) => a.name.localeCompare(b.name));
}

function buildEmojiEmbeds(guild, emojis) {
    const values = [...emojis.values()];
    if (!values.length) {
        return [
            new EmbedBuilder()
                .setTitle(`${guild.name} • Emojis`.slice(0, 256))
                .setDescription('This server has no custom emojis available to Cloudy.')
                .setColor(getColor('info')),
        ];
    }

    const embeds = [];
    for (let offset = 0; offset < values.length && embeds.length < 4; offset += 100) {
        const segment = values.slice(offset, offset + 100);
        embeds.push(
            new EmbedBuilder()
                .setTitle(offset === 0 ? `${guild.name} • Emojis (${values.length})`.slice(0, 256) : `Emojis ${offset + 1}-${offset + segment.length}`)
                .setDescription(segment.map(emoji => `${emoji} \`${emoji.name}\``).join('  ').slice(0, 4096))
                .setColor(getColor('info')),
        );
    }

    if (values.length > 400) {
        embeds[embeds.length - 1].setFooter({ text: `Showing 400 of ${values.length} emojis` });
    }

    return embeds;
}

function buildOwnerEmojiPayload(guild, emojis) {
    const values = [...emojis.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const components = [];

    for (let offset = 0; offset < values.length && components.length < 5; offset += 25) {
        const segment = values.slice(offset, offset + 25);
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_owner_emoji:${guild.id}:${Math.floor(offset / 25)}`)
            .setPlaceholder(`Emojis ${offset + 1}-${offset + segment.length} of ${values.length}`)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...segment.map(emoji =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`:${emoji.name || 'emoji'}:`.slice(0, 100))
                    .setDescription('Add this custom emoji to the embed message')
                    .setValue(emoji.id),
            ));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    const infoEmbed = new EmbedBuilder()
        .setTitle(`Discord emojis • ${guild.name}`.slice(0, 256))
        .setDescription([
            `**Custom emojis:** ${values.length}`,
            '',
            values.length
                ? 'Select an emoji below to add it to your embed message.'
                : 'This server has no custom emojis available to Cloudy.',
            values.length > 125 ? `Showing the first 125 of ${values.length} emojis.` : null,
        ].filter(Boolean).join('\n'))
        .setColor(getColor('info'));

    return {
        embeds: [infoEmbed, ...buildEmojiEmbeds(guild, emojis)].slice(0, 5),
        components,
    };
}

async function browseOwnerServers(buttonInteraction, rootInteraction, state) {
    if (!buttonInteraction.deferred && !buttonInteraction.replied) {
        await buttonInteraction.deferUpdate().catch(() => {});
    }
    const sharedGuilds = await getSharedOwnerGuilds(buttonInteraction.client, buttonInteraction.user.id);

    if (!sharedGuilds.length) {
        const noServersMessage = await buttonInteraction.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('No shared servers found')
                    .setDescription('Cloudy can only show custom emojis from servers where both you and Cloudy are members.')
                    .setColor(getColor('error')),
            ],
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (noServersMessage) removeTransientMessage(buttonInteraction, noServersMessage);
        return;
    }

    const visibleGuilds = sharedGuilds.slice(0, OWNER_SERVER_LIMIT);
    const rows = [];
    for (let offset = 0; offset < visibleGuilds.length && rows.length < 5; offset += 25) {
        const segment = visibleGuilds.slice(offset, offset + 25);
        rows.push(
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`simple_embed_owner_server:${Math.floor(offset / 25)}`)
                    .setPlaceholder(`Servers ${offset + 1}-${offset + segment.length} of ${sharedGuilds.length}`)
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(...segment.map(guild =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(guild.name.slice(0, 100))
                            .setDescription(`${guild.memberCount || 0} members • ${guild.id}`.slice(0, 100))
                            .setValue(guild.id),
                    )),
            ),
        );
    }

    const browserMessage = await buttonInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Discord emoji browser')
                .setDescription([
                    'Choose a Discord server that both you and Cloudy are in.',
                    '',
                    `**Shared servers:** ${sharedGuilds.length}`,
                    'After selecting a server, its custom Discord emojis will be shown.',
                ].join('\n'))
                .setColor(getColor('info')),
        ],
        components: rows,
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
    }).catch(() => null);

    if (!browserMessage) return;

    let currentEmojis = null;

    const collector = browserMessage.createMessageComponentCollector({
        filter: interaction => interaction.user.id === buttonInteraction.user.id,
        time: 120_000,
    });

    collector.on('collect', async componentInteraction => {
        try {
            if (componentInteraction.isStringSelectMenu() && componentInteraction.customId.startsWith('simple_embed_owner_server:')) {
                const guildId = componentInteraction.values?.[0];
                const guild = guildId ? buttonInteraction.client.guilds.cache.get(guildId) : null;
                if (!guild) {
                    await componentInteraction.deferUpdate().catch(() => {});
                    return;
                }

                currentEmojis = await guild.emojis.fetch().catch(() => guild.emojis.cache);
                await componentInteraction.update(buildOwnerEmojiPayload(guild, currentEmojis));
                return;
            }

            if (componentInteraction.isStringSelectMenu() && componentInteraction.customId.startsWith('simple_embed_owner_emoji:')) {
                const emojiId = componentInteraction.values?.[0];
                const emoji = emojiId && currentEmojis ? currentEmojis.get(emojiId) : null;
                if (!emoji) {
                    await componentInteraction.deferUpdate().catch(() => {});
                    return;
                }

                const emojiText = emoji.toString();
                state.message = state.message ? `${state.message} ${emojiText}` : emojiText;
                await componentInteraction.deferUpdate().catch(() => {});
                await refreshBuilder(rootInteraction, state);
            }
        } catch (error) {
            logger.error('Discord emoji browser failed:', error);
            if (!componentInteraction.replied && !componentInteraction.deferred) {
                await componentInteraction.deferUpdate().catch(() => {});
            }
        }
    });
}

async function postMessage(buttonInteraction, state, guild) {
    if (state.modifyTarget) {
        await buttonInteraction.deferUpdate().catch(() => {});
        await saveExistingEmbed(buttonInteraction, guild, state);
        return;
    }

    if (!state.title && !state.message && !hasMedia(state)) {
        await buttonInteraction.deferUpdate().catch(() => {});
        await replyUserError(buttonInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'Add a title, message, picture, GIF, or video before posting.',
        });
        return;
    }

    await buttonInteraction.deferUpdate();
    await refreshAllTicketChannels(guild, true);

    const initialPicker = buildChannelPicker(guild, 0);
    const channelPickerMessage = await buttonInteraction.followUp({
        embeds: initialPicker.embeds,
        components: initialPicker.components,
        flags: MessageFlags.Ephemeral,
    });
    removeTransientMessage(buttonInteraction, channelPickerMessage);

    if (!initialPicker.channels.length) return;

    const collector = channelPickerMessage.createMessageComponentCollector({
        filter: interaction =>
            interaction.user.id === buttonInteraction.user.id &&
            (
                interaction.customId.startsWith('simple_embed_post_channel:') ||
                interaction.customId.startsWith('simple_embed_channel_page:')
            ),
        time: 60_000,
    });

    collector.on('collect', async channelInteraction => {
        if (channelInteraction.customId.startsWith('simple_embed_channel_page:')) {
            const page = Number(channelInteraction.customId.split(':')[1]) || 0;
            const picker = buildChannelPicker(guild, page);
            await channelInteraction.update({
                embeds: picker.embeds,
                components: picker.components,
            });
            return;
        }

        await channelInteraction.deferUpdate();
        const channelId = channelInteraction.values?.[0];
        const channel = channelId
            ? guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null)
            : null;

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

        collector.stop('posted');
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
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            const deferred = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferred) return;

            const state = {
                title: null,
                message: null,
                embedFields: [],
                sideColor: 0xFFFFFF,
                showLogo: true,
                removeExistingLogo: false,
                bottomLine: DEFAULT_FOOTER_TEXT,
                mediaUrl: null,
                mediaBuffer: null,
                mediaName: null,
                mediaConvertedFromVideo: false,
                modifyTarget: null,
                colorSessionToken: null,
            };

            const guildEmojis = interaction.guild
                ? await interaction.guild.emojis.fetch().catch(() => interaction.guild.emojis.cache)
                : new Map();
            const editorEmojis = [...guildEmojis.values()].map(emoji => ({
                id: emoji.id,
                name: emoji.name || 'emoji',
                animated: Boolean(emoji.animated),
            }));

            const colorSessionToken = createEmbedColorPickerSession({
                userId: interaction.user.id,
                emojis: editorEmojis,
                getEditorState: () => ({
                    title: state.title || '',
                    message: state.message || '',
                    footer: state.bottomLine || '',
                    fields: Array.isArray(state.embedFields) ? state.embedFields : [],
                }),
                onEditorUpdate: async (field, value) => {
                    if (field === 'title') state.title = value.trim() || null;
                    if (field === 'message') state.message = value || null;
                    if (field === 'footer') state.bottomLine = value.trim() || null;
                    const fieldMatch = String(field).match(/^embed_field_(name|value):(\d{1,2})$/);
                    if (fieldMatch && Number(fieldMatch[2]) < (state.embedFields?.length || 0)) {
                        state.embedFields[Number(fieldMatch[2])][fieldMatch[1]] = value;
                    }
                    const refreshed = await refreshBuilder(interaction, state);
                    if (!refreshed) {
                        const error = new Error('The message builder session has expired.');
                        error.code = 'EMBED_BUILDER_EXPIRED';
                        throw error;
                    }
                },
                onColor: async color => {
                    state.sideColor = color;
                    const refreshed = await refreshBuilder(interaction, state);
                    if (!refreshed) {
                        const error = new Error('The message builder session has expired.');
                        error.code = 'EMBED_BUILDER_EXPIRED';
                        throw error;
                    }
                },
            });
            state.colorSessionToken = colorSessionToken;
            state.colorPickerUrl = `${COLOR_PICKER_URL}/embed-color?session=${colorSessionToken}&color=${encodeURIComponent(colorToHex(state.sideColor))}`;
            state.contentEditorUrl = `${COLOR_PICKER_URL}/embed-color?session=${colorSessionToken}&mode=content`;

            await refreshBuilder(interaction, state);

            const dashboardMessage = await interaction.fetchReply();
            const collector = dashboardMessage.createMessageComponentCollector({
                filter: buttonInteraction =>
                    buttonInteraction.isButton() &&
                    buttonInteraction.user.id === interaction.user.id &&
                    buttonInteraction.customId.startsWith('simple_embed_'),
                idle: BUILDER_IDLE_TIMEOUT,
            });

            collector.on('collect', async buttonInteraction => {
                try {
                    switch (buttonInteraction.customId) {
                        case 'simple_embed_content':
                            await editContent(buttonInteraction, state);
                            break;
                        case 'simple_embed_logo':
                            state.showLogo = true;
                            state.removeExistingLogo = false;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(buttonInteraction, state);
                            break;
                        case 'simple_embed_remove_logo':
                            state.showLogo = false;
                            state.removeExistingLogo = true;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(buttonInteraction, state);
                            break;
                        case 'simple_embed_footer':
                            await editBottomLine(buttonInteraction, state);
                            break;
                        case 'simple_embed_media':
                            await editMedia(buttonInteraction, state);
                            break;
                        case 'simple_embed_clear_media':
                            state.mediaUrl = null;
                            state.mediaBuffer = null;
                            state.mediaName = null;
                            state.mediaConvertedFromVideo = false;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(buttonInteraction, state);
                            break;
                        case 'simple_embed_modify':
                            await openEmbedManager(
                                buttonInteraction,
                                state,
                                () => refreshBuilder(buttonInteraction, state),
                            );
                            break;
                        case 'simple_embed_post':
                            if (state.modifyTarget) {
                                await buttonInteraction.deferUpdate().catch(() => {});
                                await saveExistingEmbed(buttonInteraction, interaction.guild, state);
                                break;
                            }
                            await postMessage(buttonInteraction, state, interaction.guild);
                            break;
                        case 'simple_embed_reset':
                            state.title = null;
                            state.message = null;
                            state.embedFields = [];
                            state.sideColor = 0xFFFFFF;
                            state.showLogo = true;
                            state.removeExistingLogo = false;
                            state.bottomLine = DEFAULT_FOOTER_TEXT;
                            state.mediaUrl = null;
                            state.mediaBuffer = null;
                            state.mediaName = null;
                            state.mediaConvertedFromVideo = false;
                            state.modifyTarget = null;
                            await buttonInteraction.deferUpdate();
                            await refreshBuilder(buttonInteraction, state);
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
                if (state.activeEmbedManager) {
                    state.activeEmbedManager.closed = true;
                    state.activeEmbedManager.collector?.stop('builder-ended');
                    state.activeEmbedManager = null;
                }
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
