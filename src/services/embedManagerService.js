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
    getEmbedRegistrySnapshot,
    reconcileEmbedRegistry,
    registerCloudyEmbedMessage,
    resolveEmbedRegistryRecord,
    scanGuildForCloudyEmbeds,
} from './embedRegistryService.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from './cloudyBrandingService.js';
import { saveEmbedTemplateDecoration } from './embedTemplateService.js';
import {
    syncSystemEmbedCatalogMessage,
    systemEmbedResponseSignature,
} from './systemEmbedCatalogService.js';
import {
    markInternalResponsePayload,
    stripInternalResponsePayloadMarker,
} from './internalResponsePayloadService.js';

const CLOUDY_LOGO_URL = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';
const PAGE_SIZE = 25;
const MANAGER_IDLE_TIMEOUT = 30 * 60_000;
const HISTORY_SCAN_TTL = 5 * 60_000;
const CLOSED_MANAGER_ERROR_CODES = new Set([10008, 10062, 50027]);
const historyScanTimes = new Map();
const historyScanJobs = new Map();
const TEMPLATE_CHANNEL_IDS = new Set([
    '1539375620885323826',
    '1539371111240831078',
    '1539259457404412036',
    '1539372511089926244',
    '1539371572442435646',
]);

const TEMPLATE_RULES = new Map([
    ['1539375620885323826', [
        { key: 'kick-log', label: 'Kick log', match: /\bkick\s+log\b/i },
    ]],
    ['1539371111240831078', [
        { key: 'untimeout-log', label: 'Untimeout log', match: /\bun[-\s]?time[-\s]?out\s+log\b|\buntimeout\s+log\b/i },
        { key: 'timeout-log', label: 'Timeout log', match: /\btime[-\s]?out\s+log\b|\btimeout\s+log\b/i },
    ]],
    ['1539259457404412036', [
        { key: 'unban-log', label: 'Unban log', match: /\bunban\s+log\b/i },
        { key: 'ban-log', label: 'Ban log', match: /\bban\s+log\b/i },
    ]],
    ['1539372511089926244', [
        { key: 'report-log', label: 'Report log', match: /\breport(?:s)?\s+log\b|\breport\b/i },
    ]],
    ['1539371572442435646', [
        { key: 'invite-created', label: 'Invite created', match: /\binvite\s+created\b/i },
        { key: 'member-joined-using-invite', label: 'Member joined using invite', match: /\bmember\s+joined\s+using\s+invite\b/i },
    ]],
]);

const GLOBAL_TEMPLATE_RULES = [
    { key: 'welcome-cloudy', label: 'Welcome to Cloudy Inc.', match: /^welcome to cloudy(?:\s+inc\.?)?$/i },
];

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

function recordName(record) {
    return String(record?.name || record?.title || '').replace(/\s+/g, ' ').trim();
}

function stripCustomEmojiMarkup(value) {
    return String(value || '')
        .replace(/<a?:[^:>]+:\d+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getChannelTemplateRule(channelId, value) {
    const rules = TEMPLATE_RULES.get(String(channelId)) || [];
    const cleaned = stripCustomEmojiMarkup(value);
    return rules.find(rule => rule.match.test(cleaned)) || null;
}

function getTemplateRule(channelId, value) {
    const cleaned = stripCustomEmojiMarkup(value);
    return getChannelTemplateRule(channelId, cleaned)
        || GLOBAL_TEMPLATE_RULES.find(rule => rule.match.test(cleaned))
        || null;
}

function getTemplateRuleByKey(channelId, key) {
    const rules = [
        ...(TEMPLATE_RULES.get(String(channelId)) || []),
        ...GLOBAL_TEMPLATE_RULES,
    ];
    return rules.find(rule => rule.key === key) || null;
}

function stableSystemTemplateKey(data = {}) {
    const authorName = String(data?.author?.name || '');
    const match = authorName.match(/^Cloudy\s+template\s+key:\s*([^|]+)/i);
    return match?.[1]?.trim() ? `system:${match[1].trim().toLowerCase()}` : null;
}

function dynamicTemplateText(value) {
    return stripCustomEmojiMarkup(value)
        .replace(/\{dynamic\}/gi, '{dynamic}')
        .replace(/<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|[$€£][\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b/gi, '{dynamic}')
        .replace(/@[a-z0-9_.-]{2,32}(?:#\d{4})?/gi, '{dynamic}')
        .replace(/\b[a-z0-9_.-]{2,32}'s\b/gi, '{dynamic}')
        .replace(/\s*[—–-]\s*/g, ' — ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function recordEmbedData(record) {
    const snapshot = getEmbedRegistrySnapshot(record) || {};
    return {
        ...snapshot,
        title: snapshot.title || record?.title || record?.name || '',
        fields: Array.isArray(snapshot.fields) ? snapshot.fields : [],
    };
}

function templateIdentity(channelId, value) {
    const data = value && typeof value === 'object' ? value : { title: value };
    const stableKey = stableSystemTemplateKey(data);
    if (stableKey) return stableKey;

    const title = String(data.title || '');
    const rule = getTemplateRule(channelId, title);
    if (rule) return rule.key;

    const titleShape = dynamicTemplateText(title);
    if (titleShape) return titleShape;

    const fieldShape = (data.fields || [])
        .map(field => dynamicTemplateText(field?.name || ''))
        .filter(Boolean)
        .join('|');
    const descriptionShape = dynamicTemplateText(data.description || '');
    return `${fieldShape}::${descriptionShape}`;
}

function collapseDisplayRecords(channelRecords, channelId = null) {
    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const groups = new Map();

    for (const record of channelRecords) {
        const rawName = recordName(record);
        const data = recordEmbedData(record);
        const isCatalog = record.source === 'system-catalog';
        const stableKey = stableSystemTemplateKey(data);
        const rule = strictTemplateMode
            ? getChannelTemplateRule(channelId, rawName)
            : getTemplateRule(channelId, rawName);

        if (isCatalog) {
            const identity = stableKey || systemEmbedResponseSignature(data);
            const key = `catalog:${identity}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    label: rawName || 'Untitled embed',
                    records: [],
                    templateMode: true,
                    templateOnly: true,
                });
            }
            groups.get(key).records.push(record);
            continue;
        }

        if (strictTemplateMode) {
            if (!rule) continue;
            if (!groups.has(rule.key)) groups.set(rule.key, { label: rule.label, records: [], templateMode: true });
            groups.get(rule.key).records.push(record);
            continue;
        }

        if (rule) {
            const key = 'template:' + rule.key;
            if (!groups.has(key)) groups.set(key, { label: rule.label, records: [], templateMode: true });
            groups.get(key).records.push(record);
            continue;
        }

        const name = rawName || 'Untitled embed';
        const key = `template:${templateIdentity(channelId, data)}`;
        if (!groups.has(key)) groups.set(key, { label: name, records: [], templateMode: false });
        groups.get(key).records.push(record);
    }

    return [...groups.values()].map(group => {
        group.records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const representative = group.records.at(-1);
        const templateOnly = Boolean(group.templateOnly);
        return {
            ...representative,
            name: group.label,
            duplicateCount: group.records.length,
            templateCount: group.records.length,
            templateMode: Boolean(group.templateMode) || group.records.length > 1 || representative.source === 'system-catalog',
            templateOnly,
        };
    });
}

function countDisplayRecordKinds(displayRecords) {
    return displayRecords.reduce((counts, record) => {
        if (record.templateOnly) counts.cloudyTemplates += 1;
        else counts.embeds += 1;
        return counts;
    }, { embeds: 0, cloudyTemplates: 0 });
}

function formatRecordCounts(counts) {
    const parts = [`${counts.embeds} ${counts.embeds === 1 ? 'embed' : 'embeds'}`];
    if (counts.cloudyTemplates) {
        parts.push(`${counts.cloudyTemplates} Cloudy ${counts.cloudyTemplates === 1 ? 'template' : 'templates'}`);
    }
    return parts.join(' • ');
}

function channelOrderTuple(channel) {
    if (!channel) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, ''];
    const parentPosition = channel.parent
        ? (Number.isFinite(channel.parent.rawPosition) ? channel.parent.rawPosition : (channel.parent.position ?? 0))
        : -1;
    const channelPosition = Number.isFinite(channel.rawPosition) ? channel.rawPosition : (channel.position ?? 0);
    return [parentPosition, channelPosition, String(channel.id)];
}

function compareChannelsByDiscordOrder(a, b) {
    const aKey = channelOrderTuple(a.channel);
    const bKey = channelOrderTuple(b.channel);
    if (aKey[0] !== bKey[0]) return aKey[0] - bKey[0];
    if (aKey[1] !== bKey[1]) return aKey[1] - bKey[1];
    return aKey[2].localeCompare(bKey[2]);
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
        .filter(group => collapseDisplayRecords(group.records, group.channelId).length > 0)
        .sort(compareChannelsByDiscordOrder);
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

export function buildChannelPayload(guild, records, page = 0) {
    const groups = buildChannelGroups(guild, records);
    const groupDisplays = new Map(groups.map(group => [
        group.channelId,
        collapseDisplayRecords(group.records, group.channelId),
    ]));
    const totals = countDisplayRecordKinds([...groupDisplays.values()].flat());
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
                const counts = countDisplayRecordKinds(groupDisplays.get(group.channelId));
                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(`${name} • ${formatRecordCounts(counts)}`))
                    .setDescription('Open the embeds in this channel')
                    .setValue(group.channelId);
            }));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    const nav = navigationRow('simple_embed_modify_channel_page', result.safePage, result.pageCount);
    if (nav) components.push(nav);

    return markInternalResponsePayload({
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription([
                'Choose a channel first, then choose the embed you want to edit.',
                '',
                `**Embeds found:** ${totals.embeds}`,
                `**Cloudy templates:** ${totals.cloudyTemplates}`,
                `**Channels:** ${groups.length}`,
                `**Page:** ${result.safePage + 1}/${result.pageCount}`,
            ].join('\n'))
            .setColor(0xFFFFFF)],
        components,
    });
}

export function buildEmbedPayload(guild, records, channelId, page = 0) {
    const channel = guild.channels.cache.get(channelId) || null;
    const channelRecords = records
        .filter(record => String(record.channelId) === String(channelId))
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const strictTemplateMode = TEMPLATE_CHANNEL_IDS.has(String(channelId));
    const displayRecords = collapseDisplayRecords(channelRecords, channelId);
    const counts = countDisplayRecordKinds(displayRecords);
    const result = pageItems(displayRecords, page);
    const components = [];

    if (result.items.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(`simple_embed_modify_embed:${channelId}:${result.safePage}`)
            .setPlaceholder('Choose an embed')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(...result.items.map(record => {
                const name = recordName(record) || record.name || 'Untitled embed';
                const isTemplate = Boolean(record.templateMode);
                const displayName = isTemplate ? record.name : stripCustomEmojiMarkup(name);
                const description = record.templateOnly
                    ? 'Edit this Cloudy template'
                    : isTemplate
                    ? `Edit this template • applies to ${record.templateCount || 1} matching embed(s)`
                    : 'Edit this embed';
                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(displayName, 'Untitled embed'))
                    .setDescription(description.slice(0, 100))
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

    return markInternalResponsePayload({
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription([
                `**Channel:** ${channel ? `${channel}` : `#${channelId}`}`,
                `**Embeds:** ${counts.embeds}`,
                `**Cloudy templates:** ${counts.cloudyTemplates}`,
                `**Page:** ${result.safePage + 1}/${result.pageCount}`,
                '',
                strictTemplateMode
                    ? 'Only real log templates for this channel are shown. Old unrelated embeds and duplicates are ignored.'
                    : 'Only unique embeds are shown. Repeated Cloudy templates are grouped automatically.',
            ].join('\n'))
            .setColor(0xFFFFFF)],
        components,
    });
}

function loadEmbedIntoState(state, resolved) {
    const { record, channel, message, embed } = resolved;
    const data = embed.toJSON();
    const footerText = cleanFooter(data.footer?.text || '');
    const templateChannelId = String(record.channelId || channel.id);
    const backingChannelId = record.backingChannelId ? String(record.backingChannelId) : null;
    const templateRule = getTemplateRule(templateChannelId, recordName(record) || data.title);

    state.title = data.title || null;
    state.message = data.description || null;
    state.embedFields = Array.isArray(data.fields)
        ? data.fields.map(field => ({
            name: String(field.name || '').slice(0, 256),
            value: String(field.value || '').slice(0, 1024),
            inline: Boolean(field.inline),
        }))
        : [];
    state.sideColor = Number.isInteger(data.color) ? data.color : 0xFFFFFF;
    state.showLogo = data.thumbnail?.url === CLOUDY_LOGO_URL;
    state.removeExistingLogo = false;
    state.bottomLine = footerText || null;
    state.mediaUrl = data.image?.url || null;
    state.mediaBuffer = null;
    state.mediaName = null;
    state.mediaConvertedFromVideo = false;
    state.modifyTarget = {
        guildId: message.guildId,
        channelId: templateChannelId,
        backingChannelId,
        messageId: message.id,
        embedIndex: Number(record.embedIndex || 0),
        source: record.source || 'cloudy',
        sourceEmbedData: data,
        hadBuilderMarker: Boolean(data.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER)),
        templateMode: Boolean(templateRule) || record.source !== 'embed-builder',
        templateTitle: templateRule?.key || templateIdentity(templateChannelId, data),
    };
}

function isEmbedManagerComponent(interaction) {
    const customId = String(interaction?.customId || '');
    return customId === 'simple_embed_modify_back'
        || customId.startsWith('simple_embed_modify_channel:')
        || customId.startsWith('simple_embed_modify_channel_page:')
        || customId.startsWith('simple_embed_modify_embed:')
        || customId.startsWith('simple_embed_modify_embed_page:');
}

function buildEmptyManagerPayload() {
    return markInternalResponsePayload({
        embeds: [new EmbedBuilder()
            .setTitle('Modify embed')
            .setDescription('No embeds are registered yet. Older embeds are being imported in the background; reopen this menu in a moment.')
            .setColor(0xFFFFFF)],
        components: [],
    });
}

function closeEmbedManagerSession(state, session, reason = 'closed') {
    if (!session || session.closed) return;
    session.closed = true;
    if (session.collector && !session.collector.ended) session.collector.stop(reason);
    if (state.activeEmbedManager === session) state.activeEmbedManager = null;
}

export function shouldApplyBackgroundRegistryRefresh(state, session) {
    return Boolean(session)
        && !session.closed
        && state.activeEmbedManager === session
        && !session.hasInteracted;
}

async function updateEmbedManager(interaction, payload, state, session) {
    if (session.closed || state.activeEmbedManager !== session) return false;

    try {
        await interaction.editReply(payload);
        return true;
    } catch (error) {
        if (CLOSED_MANAGER_ERROR_CODES.has(error?.code)) {
            closeEmbedManagerSession(state, session, 'message-unavailable');
            logger.debug(`Embed manager message ${session.messageId} is no longer available.`);
            return false;
        }
        throw error;
    }
}

async function loadCurrentRegistry(guild, botUserId) {
    let result = await reconcileEmbedRegistry(guild);
    if (result.records.length) {
        // Once a registry exists it is authoritative. Re-scanning Discord history
        // on every Modify open caused the visible count to creep from 60 -> 78 ->
        // 90 even though the logical templates had not changed.
        return result.records;
    }

    await refreshRecentEmbedHistory(guild, botUserId, true);
    result = await reconcileEmbedRegistry(guild);
    return result.records;
}

async function refreshRecentEmbedHistory(guild, botUserId, force = false) {
    if (historyScanJobs.has(guild.id)) return historyScanJobs.get(guild.id);
    if (!force && Date.now() - (historyScanTimes.get(guild.id) || 0) < HISTORY_SCAN_TTL) return null;

    const job = (async () => {
        try {
            const scan = await scanGuildForCloudyEmbeds(guild, botUserId, { maxMessagesPerChannel: 100 });
            await reconcileEmbedRegistry(guild);
            historyScanTimes.set(guild.id, Date.now());
            return scan;
        } finally {
            historyScanJobs.delete(guild.id);
        }
    })();

    historyScanJobs.set(guild.id, job);
    return job;
}

export async function openEmbedManager(buttonInteraction, state, refreshBuilder) {
    const guild = buttonInteraction.guild;
    if (!guild || !buttonInteraction.client.user?.id) return;

    await buttonInteraction.deferUpdate().catch(() => {});

    try {
        const previousSession = state.activeEmbedManager;
        if (previousSession) {
            closeEmbedManagerSession(state, previousSession, 'replaced');
            if (previousSession.messageId) {
                await buttonInteraction.webhook.deleteMessage(previousSession.messageId).catch(() => {});
            }
        }

        let records = await getEmbedRegistry(guild.id);
        const managerMessage = await buttonInteraction.followUp({
            ...(records.length
                ? buildChannelPayload(guild, records, 0)
                : buildEmptyManagerPayload()),
            flags: MessageFlags.Ephemeral,
            fetchReply: true,
        }).catch(() => null);
        if (!managerMessage) return;

        const session = {
            messageId: managerMessage.id,
            collector: null,
            closed: false,
            queue: Promise.resolve(),
            hasInteracted: false,
        };
        state.activeEmbedManager = session;

        const collector = managerMessage.createMessageComponentCollector({
            filter: interaction =>
                interaction.user.id === buttonInteraction.user.id &&
                isEmbedManagerComponent(interaction),
            idle: MANAGER_IDLE_TIMEOUT,
        });
        session.collector = collector;

        void loadCurrentRegistry(guild, buttonInteraction.client.user.id)
            .then(async refreshedRecords => {
                if (!shouldApplyBackgroundRegistryRefresh(state, session)) return;
                records = refreshedRecords;

                const payload = records.length
                    ? buildChannelPayload(guild, records, 0)
                    : buildEmptyManagerPayload();
                await buttonInteraction.webhook.editMessage(
                    managerMessage.id,
                    stripInternalResponsePayloadMarker(payload),
                ).catch(error => {
                    if (!CLOSED_MANAGER_ERROR_CODES.has(error?.code)) {
                        logger.error('Failed to refresh the embed manager registry:', error);
                    }
                });
            })
            .catch(error => logger.error('Embed manager registry refresh failed:', error));

        collector.on('collect', async interaction => {
            session.hasInteracted = true;
            const acknowledged = await interaction.deferUpdate()
                .then(() => true)
                .catch(error => {
                    logger.error('Embed manager acknowledgement failed:', error);
                    return interaction.deferred || interaction.replied;
                });
            if (!acknowledged) return;

            session.queue = session.queue.then(async () => {
                if (session.closed || state.activeEmbedManager !== session) return;

                if (interaction.customId === 'simple_embed_modify_back') {
                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildChannelPayload(guild, records, 0), state, session);
                    return;
                }

                if (interaction.customId.startsWith('simple_embed_modify_channel_page:')) {
                    const page = Number(interaction.customId.split(':').at(-1)) || 0;
                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildChannelPayload(guild, records, page), state, session);
                    return;
                }

                if (interaction.isStringSelectMenu() && interaction.customId.startsWith('simple_embed_modify_channel:')) {
                    const channelId = interaction.values?.[0];
                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, 0), state, session);
                    return;
                }

                if (interaction.customId.startsWith('simple_embed_modify_embed_page:')) {
                    const parts = interaction.customId.split(':');
                    const channelId = parts[1];
                    const page = Number(parts[2]) || 0;
                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
                    return;
                }

                if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('simple_embed_modify_embed:')) {
                    return;
                }

                const parts = interaction.customId.split(':');
                const channelId = parts[1];
                const page = Number(parts[2]) || 0;
                const [messageId, embedIndexRaw] = String(interaction.values?.[0] || '').split(':');
                const embedIndex = Number(embedIndexRaw) || 0;

                let record = records.find(item =>
                    String(item.channelId) === String(channelId) &&
                    String(item.messageId) === String(messageId) &&
                    Number(item.embedIndex || 0) === embedIndex,
                );

                if (!record) {
                    records = await getEmbedRegistry(guild.id);
                    record = records.find(item =>
                        String(item.channelId) === String(channelId) &&
                        String(item.messageId) === String(messageId) &&
                        Number(item.embedIndex || 0) === embedIndex,
                    );
                }

                const resolved = record ? await resolveEmbedRegistryRecord(guild, record) : null;
                if (!resolved) {
                    records = await getEmbedRegistry(guild.id);
                    await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
                    return;
                }

                loadEmbedIntoState(state, resolved);
                const refreshed = await refreshBuilder();
                if (refreshed === false) {
                    throw new Error('The message builder could not refresh after loading the selected embed.');
                }

                records = await getEmbedRegistry(guild.id);
                await updateEmbedManager(interaction, buildEmbedPayload(guild, records, channelId, page), state, session);
            }).catch(error => {
                logger.error('Embed manager selection failed:', error);
            });

            await session.queue;
        });

        collector.on('end', () => {
            closeEmbedManagerSession(state, session, 'collector-ended');
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
    if (Array.isArray(state.embedFields) && state.embedFields.length) {
        data.fields = state.embedFields.slice(0, 25).map(field => ({
            name: String(field.name || '\u200B').slice(0, 256),
            value: String(field.value || '\u200B').slice(0, 1024),
            inline: Boolean(field.inline),
        }));
    } else {
        delete data.fields;
    }
    data.color = state.sideColor;

    if (state.removeExistingLogo) delete data.thumbnail;
    else if (state.showLogo) data.thumbnail = { url: CLOUDY_LOGO_URL };
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

function splitDynamicLogLine(line) {
    const match = String(line || '').match(/^(\s*(?:>\s*)?\*\*[^*]+:\*\*\s*)(.*)$/);
    return match ? { prefix: match[1], value: match[2] } : null;
}

function dynamicValues(value) {
    const values = [];
    const tokenized = String(value || '').replace(
        /<t:\d+(?::[tTdDfFR])?>|<@!?\d+>|<@&\d+>|<#\d+>|<a?:[^:>]+:\d+>|https?:\/\/\S+|[$€£][\d,.]+|\b\d{1,3}(?:\.\d+)?%\b|\b\d{17,20}\b|\b\d+(?:\.\d+)?\b|@[a-z0-9_.-]{2,32}(?:#\d{4})?/gi,
        match => {
            values.push(match);
            return '{dynamic}';
        },
    );
    return { tokenized, values };
}

export function mergeDynamicTemplateText(sourceText, editedText, peerText) {
    const source = dynamicValues(sourceText);
    const edited = dynamicValues(editedText);
    const peer = dynamicValues(peerText);
    const placeholders = edited.tokenized.match(/\{dynamic\}/gi) || [];

    if (!placeholders.length) {
        const cleanEdited = String(editedText || '').trim();
        return cleanEdited;
    }
    const sourceSlots = source.tokenized.match(/\{dynamic\}/gi) || [];
    if (sourceSlots.length !== peer.values.length || placeholders.length !== peer.values.length) {
        return String(peerText || editedText || '');
    }

    let index = 0;
    return edited.tokenized.replace(/\{dynamic\}/gi, () => peer.values[index++] || '{dynamic}');
}

function mergeTemplateDescription(sourceDescription, editedDescription, peerDescription) {
    const sourceLines = String(sourceDescription || '').split('\n');
    const editedLines = String(editedDescription || '').split('\n');
    const peerLines = String(peerDescription || '').split('\n');
    const maxLength = Math.max(sourceLines.length, editedLines.length, peerLines.length);
    const result = [];

    for (let index = 0; index < maxLength; index += 1) {
        const source = sourceLines[index] ?? '';
        const edited = editedLines[index] ?? source;
        const peer = peerLines[index] ?? source;
        const sourceDynamic = splitDynamicLogLine(source);
        const editedDynamic = splitDynamicLogLine(edited);
        const peerDynamic = splitDynamicLogLine(peer);

        if (sourceDynamic && editedDynamic && peerDynamic) {
            result.push(`${editedDynamic.prefix}${peerDynamic.value}`);
        } else if (dynamicValues(source).values.length && dynamicValues(source).values.length === dynamicValues(peer).values.length) {
            result.push(mergeDynamicTemplateText(source, edited, peer));
        } else if (peer === source || index >= peerLines.length) {
            result.push(edited);
        } else {
            result.push(peer);
        }
    }

    return result.join('\n').slice(0, 4096);
}

export function mergeTemplateFields(sourceFields = [], editedFields = [], peerFields = []) {
    if (!Array.isArray(peerFields) || !peerFields.length) {
        return Array.isArray(editedFields) ? editedFields.map(field => ({ ...field })) : [];
    }

    return peerFields.slice(0, 25).map((peerField, index) => {
        const sourceField = sourceFields?.[index] || {};
        const editedField = editedFields?.[index];
        if (!editedField) return { ...peerField };

        return {
            ...peerField,
            name: (/\{dynamic\}/i.test(editedField.name || '')
                ? mergeDynamicTemplateText(
                    sourceField.name || peerField.name,
                    editedField.name || peerField.name,
                    peerField.name,
                )
                : String(editedField.name || peerField.name)
            ).slice(0, 256),
            // The value is live data (bet, card total, balance, member, reason,
            // timestamp, etc.). Never copy the sample value from the template.
            value: String(peerField.value || '\u200B').slice(0, 1024),
            inline: Boolean(editedField.inline),
        };
    });
}

function applyStateToTemplatePeer(state, peerData, savedData, mediaChanges) {
    const target = state.modifyTarget;
    const source = target?.sourceEmbedData || {};
    const data = { ...peerData };

    if (state.title) data.title = mergeDynamicTemplateText(source.title, state.title, peerData.title).slice(0, 256);
    else delete data.title;

    if (state.message) data.description = mergeTemplateDescription(source.description, state.message, peerData.description);
    else delete data.description;

    if (Array.isArray(state.embedFields) && state.embedFields.length) {
        data.fields = mergeTemplateFields(source.fields, state.embedFields, peerData.fields);
    } else if (!peerData.fields?.length) {
        delete data.fields;
    }

    data.color = state.sideColor;

    if (mediaChanges.thumbnailChanged) {
        if (savedData.thumbnail?.url) data.thumbnail = { ...savedData.thumbnail };
        else delete data.thumbnail;
    }

    if (state.bottomLine) {
        const marker = peerData.footer?.text?.endsWith(MESSAGE_BUILDER_FOOTER_MARKER) ? MESSAGE_BUILDER_FOOTER_MARKER : '';
        const limit = marker ? 2047 : 2048;
        data.footer = { ...(data.footer || {}), text: `${state.bottomLine.slice(0, limit)}${marker}` };
    } else {
        delete data.footer;
    }

    if (mediaChanges.imageChanged) {
        if (savedData.image?.url) data.image = { ...savedData.image };
        else delete data.image;
    }

    return data;
}

function mediaChangeState(sourceData, savedData) {
    const sourceThumbnail = sourceData?.thumbnail?.url || null;
    const savedThumbnail = savedData?.thumbnail?.url || null;
    const sourceImage = sourceData?.image?.url || null;
    const savedImage = savedData?.image?.url || null;

    return {
        thumbnailChanged: sourceThumbnail !== savedThumbnail,
        imageChanged: sourceImage !== savedImage,
        footerChanged: JSON.stringify(sourceData?.footer || null) !== JSON.stringify(savedData?.footer || null),
    };
}

const templatePeerUpdateJobs = new Map();

function snapshotTemplatePeerState(state, target, sourceData) {
    return {
        title: state.title,
        message: state.message,
        embedFields: Array.isArray(state.embedFields)
            ? state.embedFields.map(field => ({ ...field }))
            : [],
        sideColor: state.sideColor,
        bottomLine: state.bottomLine,
        modifyTarget: {
            ...target,
            sourceEmbedData: sourceData,
        },
    };
}

async function updateMatchingTemplatePeers(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
    const records = await getEmbedRegistry(guild.id);
    const channelRecords = records.filter(record =>
        String(record.channelId) === String(targetSnapshot.channelId),
    );
    const groups = new Map();
    for (const record of channelRecords) {
        const messageId = String(record.messageId);
        if (!groups.has(messageId)) groups.set(messageId, []);
        groups.get(messageId).push(record);
    }

    const channel = guild.channels.cache.get(targetSnapshot.channelId)
        || await guild.channels.fetch(targetSnapshot.channelId).catch(() => null);
    if (!channel?.messages?.edit) return 0;

    const directEdits = [];
    const fallbackRecords = [];

    for (const [messageId, messageRecords] of groups) {
        const ordered = [...messageRecords].sort((a, b) => Number(a.embedIndex || 0) - Number(b.embedIndex || 0));
        const maxIndex = ordered.reduce((max, record) => Math.max(max, Number(record.embedIndex || 0)), -1);
        const snapshots = new Array(maxIndex + 1).fill(null);

        for (const record of ordered) {
            const index = Number(record.embedIndex || 0);
            const isTarget = messageId === String(targetSnapshot.messageId)
                && index === Number(targetSnapshot.embedIndex || 0);
            snapshots[index] = isTarget ? current : getEmbedRegistrySnapshot(record);
        }

        const complete = snapshots.length > 0 && snapshots.every(Boolean);
        if (!complete) {
            fallbackRecords.push(...ordered.filter(record => !(
                messageId === String(targetSnapshot.messageId)
                && Number(record.embedIndex || 0) === Number(targetSnapshot.embedIndex || 0)
            )));
            continue;
        }

        let changed = false;
        const embeds = snapshots.map((peerData, embedIndex) => {
            const record = ordered.find(item => Number(item.embedIndex || 0) === embedIndex);
            const isTarget = messageId === String(targetSnapshot.messageId)
                && embedIndex === Number(targetSnapshot.embedIndex || 0);
            if (isTarget || !record) return new EmbedBuilder(peerData);

            const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData);
            if (peerIdentity !== targetSnapshot.templateTitle) return new EmbedBuilder(peerData);

            changed = true;
            return new EmbedBuilder(applyStateToTemplatePeer(stateSnapshot, peerData, current, mediaChanges));
        });

        if (changed) directEdits.push({ messageId, embeds });
    }

    const directJob = Promise.all(directEdits.map(async ({ messageId, embeds }) => {
        const peerEdited = await channel.messages.edit(messageId, { embeds }).catch(error => {
            logger.error('Failed to directly update matching log template embed:', error);
            return null;
        });
        if (!peerEdited) return false;

        void registerCloudyEmbedMessage(peerEdited, 'modified-template')
            .catch(error => logger.error('Failed to refresh directly modified template registry:', error));
        return true;
    }));

    const resolvedPeers = await Promise.all(fallbackRecords.map(record =>
        resolveEmbedRegistryRecord(guild, record).catch(() => null),
    ));

    const fallbackEdits = [];
    for (const resolved of resolvedPeers) {
        if (!resolved) continue;

        const { record } = resolved;
        const peerData = resolved.embed.toJSON();
        const peerIdentity = templateIdentity(targetSnapshot.channelId, peerData);
        if (peerIdentity !== targetSnapshot.templateTitle) continue;

        const peerIndex = Number(record.embedIndex || 0);
        const peerEmbeds = resolved.message.embeds.map((embed, embedIndex) =>
            embedIndex === peerIndex
                ? new EmbedBuilder(applyStateToTemplatePeer(stateSnapshot, peerData, current, mediaChanges))
                : new EmbedBuilder(embed.toJSON()),
        );
        fallbackEdits.push({ resolved, peerEmbeds });
    }

    const fallbackJob = Promise.all(fallbackEdits.map(async ({ resolved, peerEmbeds }) => {
        const peerEdited = await resolved.message.edit({ embeds: peerEmbeds }).catch(error => {
            logger.error('Failed to update matching log template embed:', error);
            return null;
        });
        if (!peerEdited) return false;

        void registerCloudyEmbedMessage(peerEdited, 'modified-template')
            .catch(error => logger.error('Failed to refresh modified embed registry:', error));
        return true;
    }));

    const [directResults, fallbackResults] = await Promise.all([directJob, fallbackJob]);
    return [...directResults, ...fallbackResults].filter(Boolean).length;
}

function queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges) {
    const key = `${guild.id}:${targetSnapshot.channelId}:${targetSnapshot.templateTitle || ''}`;
    const request = { guild, stateSnapshot, targetSnapshot, current, mediaChanges };
    const existing = templatePeerUpdateJobs.get(key);

    if (existing) {
        existing.pending = request;
        return;
    }

    const entry = { pending: request };
    templatePeerUpdateJobs.set(key, entry);

    const run = async () => {
        while (entry.pending) {
            const next = entry.pending;
            entry.pending = null;

            try {
                const updatedCount = await updateMatchingTemplatePeers(
                    next.guild,
                    next.stateSnapshot,
                    next.targetSnapshot,
                    next.current,
                    next.mediaChanges,
                );
                logger.debug(`Updated ${updatedCount} matching historical log embed(s) in background.`);
            } catch (error) {
                logger.error('Failed to update matching historical log embeds in background:', error);
            }
        }
    };

    void run().finally(() => {
        if (templatePeerUpdateJobs.get(key) === entry) templatePeerUpdateJobs.delete(key);
    });
}

export async function saveModifiedEmbed(guild, state) {
    const target = state.modifyTarget;
    if (!guild || !target) return { ok: false, reason: 'missing-target' };

    const messageChannelId = target.backingChannelId || target.channelId;
    const channel = guild.channels.cache.get(messageChannelId)
        || await guild.channels.fetch(messageChannelId).catch(() => null);
    if (!channel?.messages?.fetch) return { ok: false, reason: 'channel-missing' };

    const message = await channel.messages.fetch(target.messageId).catch(() => null);
    if (!message || message.author?.id !== guild.client.user?.id) return { ok: false, reason: 'message-missing' };
    if (message.flags?.has?.(MessageFlags.Ephemeral) || message.interaction || message.interactionMetadata) {
        return { ok: false, reason: 'control-message' };
    }

    const index = Number(target.embedIndex || 0);
    if (!message.embeds?.[index]) return { ok: false, reason: 'embed-missing' };

    const sourceData = { ...(target.sourceEmbedData || {}) };
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

    // System response templates are published to memory immediately. The catalog
    // service performs its persistence/registry follow-up in the background.
    if (target.source === 'system-catalog' || target.backingChannelId) {
        await syncSystemEmbedCatalogMessage(edited).catch(error => {
            logger.error('Failed to hot-sync edited system embed template:', error);
        });
    }

    const current = edited.embeds?.[index]?.toJSON?.() || applyStateToExistingEmbed(state);
    const mediaChanges = mediaChangeState(sourceData, current);
    let updatedCount = 1;

    if (target.templateMode) {
        const sourceRule = getTemplateRuleByKey(target.channelId, target.templateTitle)
            || getTemplateRule(target.channelId, sourceData.title || target.templateTitle);
        const aliases = [sourceData.title, current.title, sourceRule?.label].filter(Boolean);

        // saveEmbedTemplateDecoration stages the newest template synchronously in
        // memory before it starts the DB write. Do not make the Save button wait
        // for database latency: the next runtime embed already sees this version.
        const templateSave = saveEmbedTemplateDecoration(
            guild.id,
            target.channelId,
            aliases,
            current,
            {
                applyFooter: Boolean(current.footer) || mediaChanges.footerChanged,
                applyThumbnail: state.showLogo || state.removeExistingLogo || mediaChanges.thumbnailChanged,
                applyImage: mediaChanges.imageChanged,
            },
        );
        void templateSave.then(saved => {
            if (!saved) logger.error(`Embed template persistence failed for ${guild.id}:${target.channelId}`);
        }).catch(error => logger.error('Embed template persistence failed:', error));

        if (!target.backingChannelId) {
            const targetSnapshot = {
                ...target,
                sourceEmbedData: sourceData,
                templateTitle: target.templateTitle,
            };
            const stateSnapshot = snapshotTemplatePeerState(state, targetSnapshot, sourceData);
            queueMatchingTemplatePeerUpdate(guild, stateSnapshot, targetSnapshot, current, mediaChanges);
        }
    }

    state.modifyTarget.sourceEmbedData = current;
    state.showLogo = current.thumbnail?.url === CLOUDY_LOGO_URL;
    state.removeExistingLogo = false;
    if (!target.templateMode) {
        state.modifyTarget.templateTitle = templateIdentity(target.channelId, current);
    }
    void registerCloudyEmbedMessage(edited, target.templateMode ? 'modified-template' : 'modified')
        .catch(error => logger.error('Failed to refresh modified embed registry:', error));

    return { ok: true, channel, message: edited, updatedCount };
}
