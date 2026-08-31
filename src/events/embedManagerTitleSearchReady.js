import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import {
  getEmbedRegistry,
  getEmbedRegistrySnapshot,
  reconcileEmbedRegistry,
} from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const PATCH_MARKER = Symbol.for('cloudy.embedManagerTitleSearch');
const SEARCH_BUTTON_ID = 'simple_embed_title_search';
// Keep the stable ID for compatibility with already-open Embed Builder sessions.
const SEARCH_MODAL_PREFIX = 'simple_embed_title_search_modal_';
const SEARCH_INPUT_ID = 'title_query';
const MAX_CHANNEL_GROUPS = 4;
const MAX_RESULTS_PER_CHANNEL = 25;

function componentCustomId(component) {
  const data = component?.toJSON ? component.toJSON() : component?.data || component;
  return String(data?.custom_id || data?.customId || '');
}

function isModifyEmbedPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  return embeds.some(embed => {
    const data = embed?.toJSON ? embed.toJSON() : embed;
    return String(data?.title || '').trim().toLowerCase() === 'modify embed';
  });
}

function hasSearchButton(payload) {
  return (payload?.components || []).some(row => {
    const data = row?.toJSON ? row.toJSON() : row;
    return (data?.components || []).some(component => componentCustomId(component) === SEARCH_BUTTON_ID);
  });
}

function searchButtonRow(label = 'Search') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(SEARCH_BUTTON_ID)
      .setLabel(label)
      .setEmoji('🔎')
      .setStyle(ButtonStyle.Secondary),
  );
}

function addSearchControl(payload) {
  if (!isModifyEmbedPayload(payload) || hasSearchButton(payload)) return payload;

  const components = Array.isArray(payload.components) ? [...payload.components] : [];
  if (components.length >= 5) return payload;
  components.push(searchButtonRow());
  return { ...payload, components };
}

function patchManagerResponses() {
  if (InteractionHelper[PATCH_MARKER]) return;

  const previousPatch = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);
  InteractionHelper.patchInteractionResponses = function patchEmbedManagerSearch(interaction) {
    previousPatch(interaction);
    if (!interaction || interaction.__cloudyEmbedManagerTitleSearchPatched) return;

    for (const method of ['reply', 'editReply', 'followUp', 'update']) {
      const original = interaction[method]?.bind(interaction);
      if (!original) continue;
      interaction[method] = async (payload, ...args) => original(addSearchControl(payload), ...args);
    }

    interaction.__cloudyEmbedManagerTitleSearchPatched = true;
  };

  Object.defineProperty(InteractionHelper, PATCH_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function normalizedTitle(record) {
  const snapshot = getEmbedRegistrySnapshot(record) || {};
  return String(record?.name || record?.title || snapshot?.title || 'Untitled embed')
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortText(value, max = 100) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return (text || 'Untitled embed').slice(0, max);
}

function recordSearchText(guild, record) {
  const snapshot = getEmbedRegistrySnapshot(record) || {};
  const channel = guild?.channels?.cache?.get?.(String(record?.channelId || '')) || null;
  const fields = Array.isArray(snapshot.fields)
    ? snapshot.fields.flatMap(field => [field?.name, field?.value])
    : [];

  return [
    normalizedTitle(record),
    record?.name,
    record?.title,
    record?.source,
    channel?.name,
    channel?.parent?.name,
    snapshot.title,
    snapshot.description,
    snapshot.author?.name,
    snapshot.footer?.text,
    ...fields,
  ]
    .filter(Boolean)
    .join(' ');
}

function rankMatch(title, document, query) {
  const titleValue = searchKey(title);
  const documentValue = searchKey(document);
  const needle = searchKey(query);
  if (titleValue === needle) return 0;
  if (titleValue.startsWith(needle)) return 1;
  if (titleValue.includes(needle)) return 2;
  if (documentValue.includes(needle)) return 3;
  return 4;
}

function recordPriority(record) {
  const source = String(record?.source || '').toLowerCase();
  if (source === 'system-catalog') return 100;
  if (source.includes('template')) return 80;
  if (source.includes('modified')) return 60;
  if (source === 'history') return 20;
  return 40;
}

function preferredRecord(left, right) {
  if (!left) return right;
  const priorityDiff = recordPriority(right.record) - recordPriority(left.record);
  if (priorityDiff > 0) return right;
  if (priorityDiff < 0) return left;

  const leftTime = new Date(left.record?.updatedAt || left.record?.createdAt || 0).getTime();
  const rightTime = new Date(right.record?.updatedAt || right.record?.createdAt || 0).getTime();
  return rightTime >= leftTime ? right : left;
}

function findSearchMatches(guild, records, query) {
  const normalizedQuery = searchKey(query);
  if (!normalizedQuery) return [];

  const queryWords = normalizedQuery.split(' ').filter(Boolean);
  const grouped = new Map();

  for (const record of records) {
    const title = normalizedTitle(record);
    const titleKey = searchKey(title);
    const document = recordSearchText(guild, record);
    const documentKey = searchKey(document);
    if (!queryWords.every(word => documentKey.includes(word))) continue;

    // Show one logical template instead of every old copy. Prefer the automatic
    // response catalog entry whenever the same item exists in the catalog.
    const logicalName = titleKey || searchKey(record?.name) || searchKey(record?.source) || 'untitled';
    const groupKey = `${record.channelId}:${logicalName}`;
    const candidate = { record, title, titleKey, document };
    grouped.set(groupKey, preferredRecord(grouped.get(groupKey), candidate));
  }

  return [...grouped.values()].sort((a, b) => {
    const rankDiff = rankMatch(a.title, a.document, normalizedQuery) - rankMatch(b.title, b.document, normalizedQuery);
    if (rankDiff) return rankDiff;
    const titleDiff = a.title.localeCompare(b.title);
    if (titleDiff) return titleDiff;
    return String(a.record.channelId).localeCompare(String(b.record.channelId));
  });
}

function buildSearchResultsPayload(guild, records, query) {
  const matches = findSearchMatches(guild, records, query);
  const byChannel = new Map();

  for (const match of matches) {
    const channelId = String(match.record.channelId || '');
    if (!channelId) continue;
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push(match);
  }

  const channelGroups = [...byChannel.entries()].slice(0, MAX_CHANNEL_GROUPS);
  const components = [];
  let shown = 0;

  for (const [channelId, channelMatches] of channelGroups) {
    const usable = channelMatches.slice(0, MAX_RESULTS_PER_CHANNEL);
    if (!usable.length) continue;
    shown += usable.length;

    const channel = guild.channels.cache.get(channelId) || null;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`simple_embed_modify_embed:${channelId}:0`)
      .setPlaceholder(shortText(`${channel?.name ? `# ${channel.name}` : 'Channel'} • ${usable.length} result${usable.length === 1 ? '' : 's'}`))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(...usable.map(({ record, title }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(shortText(title))
          .setDescription(shortText(record.source === 'system-catalog'
            ? 'Automatic template • affects future matching messages'
            : (channel?.name ? `#${channel.name} • matching embed` : 'Matching embed')))
          .setValue(`${record.messageId}:${Number(record.embedIndex || 0)}`),
      ));

    components.push(new ActionRowBuilder().addComponents(menu));
  }

  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(SEARCH_BUTTON_ID)
      .setLabel('Search again')
      .setEmoji('🔎')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('simple_embed_modify_back')
      .setLabel('Back to channels')
      .setStyle(ButtonStyle.Secondary),
  ));

  const hidden = Math.max(0, matches.length - shown);
  const description = matches.length
    ? [
        `Search: **${String(query).slice(0, 120)}**`,
        `**Matches found:** ${matches.length}`,
        `**Showing:** ${shown}${hidden ? ` • ${hidden} more not shown` : ''}`,
        '',
        'Search checks titles, messages, fields, logs, notifications and channel names.',
        'Repeated copies are grouped automatically.',
      ].join('\n')
    : [
        `Search: **${String(query).slice(0, 120)}**`,
        '',
        'Nothing matched. Search with any word from a title, message, field, log, notification or channel.',
      ].join('\n');

  return {
    embeds: [new EmbedBuilder()
      .setTitle('Modify embed')
      .setDescription(description)
      .setColor(0xFFFFFF)],
    components,
  };
}

async function handleSearchButton(interaction) {
  if (!interaction.isButton?.() || interaction.customId !== SEARCH_BUTTON_ID) return false;

  const modalId = `${SEARCH_MODAL_PREFIX}${interaction.id}`;
  const input = new TextInputBuilder()
    .setCustomId(SEARCH_INPUT_ID)
    .setLabel('Search')
    .setPlaceholder('Roulette, ban, kick, lost, ticket...')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(120)
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Search')
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);

  const submitted = await interaction.awaitModalSubmit({
    time: 2 * 60_000,
    filter: modalInteraction =>
      modalInteraction.user.id === interaction.user.id &&
      modalInteraction.customId === modalId,
  }).catch(() => null);

  if (!submitted) return true;

  const query = submitted.fields.getTextInputValue(SEARCH_INPUT_ID).trim();
  await submitted.deferUpdate().catch(() => {});

  let records = await getEmbedRegistry(interaction.guildId);
  try {
    const reconciled = await reconcileEmbedRegistry(interaction.guild);
    if (reconciled?.records?.length) records = reconciled.records;
  } catch (error) {
    logger.debug(`[EMBED_BUILDER] Search registry refresh skipped: ${error?.message || error}`);
  }

  const payload = buildSearchResultsPayload(interaction.guild, records, query);
  await submitted.editReply(payload).catch(error => {
    logger.error('[EMBED_BUILDER] Search result update failed:', error);
  });
  return true;
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    patchManagerResponses();

    client.on(Events.InteractionCreate, interaction => {
      if (!interaction.isButton?.() || interaction.customId !== SEARCH_BUTTON_ID) return;
      void handleSearchButton(interaction).catch(error => {
        logger.error('[EMBED_BUILDER] Search failed:', error);
      });
    });

    logger.info('[EMBED_BUILDER] Universal search enabled in Modify embed.');
  },
};