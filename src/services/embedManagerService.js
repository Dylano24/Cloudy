import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from 'discord.js';
import { getColor } from '../config/bot.js';
import { logger } from '../utils/logger.js';
import {
    getEmbedRegistry,
    registerCloudyEmbedMessage,
    resolveEmbedRegistryRecord,
    scanGuildForCloudyEmbeds,
} from './embedRegistryService.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';

const CLOUDY_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo.png';
const PAGE_SIZE = 25;
const MANAGER_TIMEOUT = 120_000;

function cleanFooter(text) {
    const value = String(text || '');
    return value.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)
        ? value.slice(0, -MESSAGE_BUILDER_FOOTER_MARKER.length)
        : value;
}

function shortLabel(value, fallback = 'Untitled embed') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 100);
}

async function resolveRegistryPage(guild, records, page) {
    const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
    const start = safePage * PAGE_SIZE;
    const slice = records.slice(start, start + PAGE_SIZE);
    const resolved = [];

    for (const record of slice) {
        const item = await resolveEmbedRegistryRecord(guild, record);
        if (item) resolved.push(item);
    }

    return { resolved, safePage, pageCount, start };
}

function buildManagerPayload(items, page, pageCount, total) {
    const components = [];

    if (items.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_modify_select:${page}`)
            .setPlaceholder(`Embeds ${page * PAGE_SIZE + 1}-${page * PAGE_SIZE + items.length} of ${total}`)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...items.map(({ record, channel, embed }) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(embed.title || embed.description))
                    .setDescription(`#${channel.name} • ${record.source || 'Cloudy'} • ${record.messageId}`.slice(0, 100))
                    .setValue(`${record.channelId}:${record.messageId}:${record.embedIndex || 0}`),
            ));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`simple_embed_modify_page:${Math.max(0, page - 1)}`)
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page <= 0),
            new ButtonBuilder()
                .setCustomId(`simple_embed_modify_page:${Math.min(pageCount - 1, page + 1)}`)
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(page >= pageCount - 1),
        ));
    }

    return {
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription([
                'Choose an existing Cloudy embed to load into the Message Builder.',
                '',
                `**Embeds found:** ${total}`,
                `**Page:** ${page + 1}/${pageCount}`,
                '',
                'The original Discord message will be updated when you press **Save changes**.',
            ].join('\n'))
            .setColor(getColor('info'))],
        components,
    };
}

function loadEmbedIntoState(state, resolved) {
    const { record, channel, message, embed } = resolved;
    const data = embed.toJSON();
    const footerText = cleanFooter(data.footer?.text || '');

    state.title = data.title || null;
    state.message = data.description || null;
    state.sideColor = Number.isInteger(data.color) ? data.color : getColor('primary');
    state.showLogo = data.thumbnail?.url === CLOUDY_LOGO_URL;
    state.bottomLine = footerText || null;
    state.mediaUrl = data.image?.url || null;
    state.mediaBuffer = null;
    state.mediaName = null;
    state.mediaConvertedFromVideo = false;
    state.modifyTarget = {
        guildId: message.guildId,
        channelId: channel.id,
        messageId: message.id,
        embedIndex: Number(record.embedIndex || 0),
        source: record.source || 'cloudy',
        sourceEmbedData: data,
        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),
    };
}

export async function openEmbedManager(buttonInteraction, state, refreshBuilder) {
    const guild = buttonInteraction.guild;
    if (!guild || !buttonInteraction.client.user?.id) return;

    await buttonInteraction.deferUpdate().catch(() => {});

    const loading = await buttonInteraction.followUp({
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription('Scanning Cloudy messages and loading the embed registry…')
            .setColor(getColor('info'))],
        flags: MessageFlags.Ephemeral,
        fetchReply: true,
    }).catch(() => null);
    if (!loading) return;

    try {
        // Import older existing Cloudy embeds. Future Cloudy embeds are registered automatically.
        await scanGuildForCloudyEmbeds(guild, buttonInteraction.client.user.id);
        let records = await getEmbedRegistry(guild.id);

        if (!records.length) {
            await loading.edit({
                embeds: [new EmbedBuilder()
                    .setTitle('Modify embed')
                    .setDescription('No existing Cloudy embeds could be found in channels Cloudy can read.')
                    .setColor(getColor('info'))],
                components: [],
            });
            return;
        }

        async function showPage(page) {
            records = await getEmbedRegistry(guild.id);
            const result = await resolveRegistryPage(guild, records, page);
            await loading.edit(buildManagerPayload(result.resolved, result.safePage, result.pageCount, records.length));
        }

        await showPage(0);

        const collector = loading.createMessageComponentCollector({
            filter: interaction => interaction.user.id === buttonInteraction.user.id,
            time: MANAGER_TIMEOUT,
        });

        collector.on('collect', async interaction => {
            try {
                if (interaction.customId.startsWith('simple_embed_modify_page:')) {
                    await interaction.deferUpdate().catch(() => {});
                    const page = Number(interaction.customId.split(':')[1]) || 0;
                    await showPage(page);
                    return;
                }

                if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('simple_embed_modify_select:')) {
                    await interaction.deferUpdate().catch(() => {});
                    return;
                }

                const [channelId, messageId, embedIndexRaw] = String(interaction.values?.[0] || '').split(':');
                const embedIndex = Number(embedIndexRaw) || 0;
                const record = records.find(item =>
                    String(item.channelId) === channelId &&
                    String(item.messageId) === messageId &&
                    Number(item.embedIndex || 0) === embedIndex,
                );
                const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;

                if (!resolved) {
                    await interaction.deferUpdate().catch(() => {});
                    await showPage(Number(interaction.customId.split(':')[1]) || 0);
                    return;
                }

                loadEmbedIntoState(state, resolved);
                await interaction.deferUpdate().catch(() => {});
                await refreshBuilder();
                collector.stop('selected');

                await loading.edit({
                    embeds: [new EmbedBuilder()
                        .setTitle('Embed loaded')
                        .setDescription(`Loaded the embed from ${resolved.channel}. Use the existing builder controls, then press **Save changes**.`)
                        .setColor(getColor('success'))],
                    components: [],
                }).catch(() => {});
            } catch (error) {
                logger.error('Embed manager selection failed:', error);
                if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(() => {});
            }
        });
    } catch (error) {
        logger.error('Embed manager failed:', error);
        await loading.edit({
            embeds: [new EmbedBuilder()
                .setTitle('Could not load embeds')
                .setDescription('Cloudy could not scan or load the existing embeds right now.')
                .setColor(getColor('error'))],
            components: [],
        }).catch(() => {});
    }
}

function applyStateToExistingEmbed(state) {
    const target = state.modifyTarget;
    const data = { ...(target?.sourceEmbedData || {}) };

    if (state.title) data.title = state.title.slice(0, 256);
    else delete data.title;

    if (state.message) data.description = state.message.slice(0, 4096);
    else delete data.description;

    data.color = state.sideColor;

    if (state.showLogo) data.thumbnail = { url: CLOUDY_LOGO_URL };
    else if (data.thumbnail?.url === CLOUDY_LOGO_URL) delete data.thumbnail;

    if (state.bottomLine) {
        const marker = target?.hadBuilderMarker ? MESSAGE_BUILDER_FOOTER_MARKER : '';
        const limit = marker ? 2047 : 2048;
        data.footer = { ...(data.footer || {}), text: `${state.bottomLine.slice(0, limit)}${marker}` };
    } else {
        delete data.footer;
    }

    if (state.mediaBuffer && state.mediaName) {
        data.image = { url: `attachment://${state.mediaName}` };
    } else if (state.mediaUrl) {
        data.image = { url: state.mediaUrl };
    } else {
        delete data.image;
    }

    return data;
}

export async function saveModifiedEmbed(guild, state) {
    const target = state.modifyTarget;
    if (!guild || !target) return { ok: false, reason: 'missing-target' };

    const channel = guild.channels.cache.get(target.channelId)
        || await guild.channels.fetch(target.channelId).catch(() => null);
    if (!channel?.messages?.fetch) return { ok: false, reason: 'channel-missing' };

    const message = await channel.messages.fetch(target.messageId).catch(() => null);
    if (!message || message.author?.id !== guild.client.user?.id) return { ok: false, reason: 'message-missing' };

    const index = Number(target.embedIndex || 0);
    if (!message.embeds?.[index]) return { ok: false, reason: 'embed-missing' };

    const embeds = message.embeds.map((embed, embedIndex) =>
        embedIndex === index
            ? new EmbedBuilder(applyStateToExistingEmbed(state))
            : new EmbedBuilder(embed.toJSON()),
    );

    const payload = { embeds };
    if (state.mediaBuffer && state.mediaName) {
        payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
    }

    const edited = await message.edit(payload).catch(error => {
        logger.error('Failed to save modified embed:', error);
        return null;
    });
    if (!edited) return { ok: false, reason: 'edit-failed' };

    const current = edited.embeds?.[index]?.toJSON?.() || applyStateToExistingEmbed(state);
    state.modifyTarget.sourceEmbedData = current;
    await registerCloudyEmbedMessage(edited, 'modified');

    return { ok: true, channel, message: edited };
}
