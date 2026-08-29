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

function shortLabel(value, fallback = 'Embed') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return (text || fallback).slice(0, 100);
}

function buildChannelGroups(guild, records) {
    const groups = new Map();
    for (const record of records) {
        const channelId = String(record.channelId);
        if (!groups.has(channelId)) groups.set(channelId, []);
        groups.get(channelId).push(record);
    }

    return [...groups.entries()]
        .map(([channelId, channelRecords]) => ({
            channelId,
            channel: guild.channels.cache.get(channelId) || null,
            records: channelRecords.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)),
        }))
        .sort((a, b) => {
            const aName = a.channel?.name || a.channelId;
            const bName = b.channel?.name || b.channelId;
            return aName.localeCompare(bName);
        });
}

function pageItems(items, page) {
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
    const start = safePage * PAGE_SIZE;
    return { items: items.slice(start, start + PAGE_SIZE), safePage, pageCount, start };
}

function navigationRow(prefix, page, pageCount) {
    if (pageCount <= 1) return null;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`${prefix}:${Math.max(0, page - 1)}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`${prefix}:${Math.min(pageCount - 1, page + 1)}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= pageCount - 1),
    );
}

function buildChannelPayload(guild, records, page = 0) {
    const groups = buildChannelGroups(guild, records);
    const result = pageItems(groups, page);
    const components = [];

    if (result.items.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_modify_channel:${result.safePage}`)
            .setPlaceholder('Choose a channel')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...result.items.map(group => {
                const name = group.channel?.name ? `# ${group.channel.name}` : 'Unknown channel';
                const count = group.records.length;
                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(`${name} • ${count} ${count === 1 ? 'embed' : 'embeds'}`))
                    .setDescription('Open the embeds in this channel')
                    .setValue(group.channelId);
            }));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    const nav = navigationRow('simple_embed_modify_channel_page', result.safePage, result.pageCount);
    if (nav) components.push(nav);

    return {
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription([
                'Choose a channel first, then choose the embed you want to edit.',
                '',
                `**Embeds found:** ${records.length}`,
                `**Channels:** ${groups.length}`,
                `**Page:** ${result.safePage + 1}/${result.pageCount}`,
            ].join('\n'))
            .setColor(getColor('info'))],
        components,
    };
}

function buildEmbedPayload(guild, records, channelId, page = 0) {
    const channel = guild.channels.cache.get(channelId) || null;
    const channelRecords = records
        .filter(record => String(record.channelId) === String(channelId))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const result = pageItems(channelRecords, page);
    const components = [];

    if (result.items.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_modify_embed:${channelId}:${result.safePage}`)
            .setPlaceholder('Choose an embed')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...result.items.map((record, index) => {
                const embedNumber = result.start + index + 1;
                const title = String(record.title || '').trim();
                const label = title ? `Embed ${embedNumber} • ${title}` : `Embed ${embedNumber}`;
                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(label))
                    .setDescription(title ? 'Edit this embed' : `Posted ${record.createdAt ? new Date(record.createdAt).toLocaleDateString('en-GB') : 'earlier'}`)
                    .setValue(`${record.messageId}:${record.embedIndex || 0}`);
            }));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    const nav = navigationRow(`simple_embed_modify_embed_page:${channelId}`, result.safePage, result.pageCount);
    if (nav) components.push(nav);

    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_modify_back')
            .setLabel('Back to channels')
            .setStyle(ButtonStyle.Secondary),
    ));

    return {
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription([
                `**Channel:** ${channel ? `${channel}` : `#${channelId}`}`,
                `**Embeds:** ${channelRecords.length}`,
                `**Page:** ${result.safePage + 1}/${result.pageCount}`,
                '',
                'Choose an embed below. It will open in the existing message builder exactly as it is now.',
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

    try {
        let records = await getEmbedRegistry(guild.id);
        const managerMessage = await buttonInteraction.followUp({
            ...(records.length
                ? buildChannelPayload(guild, records, 0)
                : {
                    embeds: [new EmbedBuilder()
                        .setTitle('Modify embed')
                        .setDescription('No embeds are registered yet. Older embeds are being imported in the background; reopen this menu in a moment.')
                        .setColor(getColor('info'))],
                    components: [],
                }),
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (!managerMessage) return;

        void scanGuildForCloudyEmbeds(guild, buttonInteraction.client.user.id, { maxMessagesPerChannel: 100 })
            .catch(error => logger.error('Background embed history import failed:', error));

        if (!records.length) return;

        const collector = managerMessage.createMessageComponentCollector({
            filter: interaction => interaction.user.id === buttonInteraction.user.id,
            time: MANAGER_TIMEOUT,
        });

        collector.on('collect', async interaction => {
            try {
                if (interaction.customId === 'simple_embed_modify_back') {
                    records = await getEmbedRegistry(guild.id);
                    await interaction.update(buildChannelPayload(guild, records, 0));
                    return;
                }

                if (interaction.customId.startsWith('simple_embed_modify_channel_page:')) {
                    const page = Number(interaction.customId.split(':').at(-1)) || 0;
                    records = await getEmbedRegistry(guild.id);
                    await interaction.update(buildChannelPayload(guild, records, page));
                    return;
                }

                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
                    records = await getEmbedRegistry(guild.id);
                    await interaction.update(buildEmbedPayload(guild, records, channelId, 0));
                    return;
                }

                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {
                    const parts = interaction.customId.split(':');
                    const channelId = parts[1];
                    const page = Number(parts[2]) || 0;
                    records = await getEmbedRegistry(guild.id);
                    await interaction.update(buildEmbedPayload(guild, records, channelId, page));
                    return;
                }

                if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('simple_embed_modify_embed:')) {
                    await interaction.deferUpdate().catch(() => {});
                    return;
                }

                const parts = interaction.customId.split(':');
                const channelId = parts[1];
                const [messageId, embedIndexRaw] = String(interaction.values?.[0] || '').split(':');
                const embedIndex = Number(embedIndexRaw) || 0;
                const record = records.find(item =>
                    String(item.channelId) === String(channelId) &&
                    String(item.messageId) === String(messageId) &&
                    Number(item.embedIndex || 0) === embedIndex,
                );

                await interaction.deferUpdate().catch(() => {});
                const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;

                if (!resolved) {
                    records = await getEmbedRegistry(guild.id);
                    await managerMessage.edit(buildEmbedPayload(guild, records, channelId, 0));
                    return;
                }

                loadEmbedIntoState(state, resolved);
                await refreshBuilder();
                collector.stop('selected');

                await managerMessage.edit({
                    embeds: [new EmbedBuilder()
                        .setTitle('Embed loaded')
                        .setDescription(`The embed from ${resolved.channel} is now open in the message builder. Edit it normally, then press **save changes**.`)
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
        await buttonInteraction.followUp({
            embeds: [new EmbedBuilder()
                .setTitle('Could not load embeds')
                .setDescription('The embeds could not be loaded right now.')
                .setColor(getColor('error'))],
            flags: MessageFlags.Ephemeral,
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

    if (state.mediaBuffer && state.mediaName) data.image = { url: `attachment://${state.mediaName}` };
    else if (state.mediaUrl) data.image = { url: state.mediaUrl };
    else delete data.image;

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
        embedIndex === index ? new EmbedBuilder(applyStateToExistingEmbed(state)) : new EmbedBuilder(embed.toJSON()),
    );

    const payload = { embeds };
    if (state.mediaBuffer && state.mediaName) payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];

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
