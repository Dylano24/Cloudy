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
} from '../services/embedRegistryService.js';
import { logger } from '../utils/logger.js';

const PATCH_MARKER = Symbol.for('cloudy.embedManagerTitleSearch');
const SEARCH_BUTTON_ID = 'simple_embed_title_search';
// Do not use ':' here. The global modal router treats colon-separated IDs as
// registered modal handlers. This modal is handled inline by awaitModalSubmit.
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

function searchButtonRow(label = 'Search by title') {
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
  InteractionHelper.patchInteractionResponses = function patchEmbedManagerTitleSearch(interaction) {
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

function rankMatch(title, query) {
  const value = searchKey(title);
  const needle = searchKey(query);
  if (value === needle) return 0;
  if (value.startsWith(needle)) return 1;
  const words = value.split(' ');
  const queryWords = needle.split(' ').filter(Boolean);
  if (queryWords.length && queryWords.every(queryWord => words.some(word => word.startsWith(queryWord)))) return 2;
  return 3;
}

function findTitleMatches(records, query) {
  const normalizedQuery = searchKey(query);
  if (!normalizedQuery) return [];

  const queryWords = normalizedQuery.split(' ').filter(Boolean);
  const seen = new Set();

  return records
    .map(record => {
      const title = normalizedTitle(record);
      return { record, title, titleKey: searchKey(title) };
    })
    // Search on any part of the title. Punctuation such as "—", "-", ":" and
    // emoji does not matter. Typing just "roulette" therefore shows every
    // Roulette title; "roulette won" narrows that list to titles containing
    // both words even when the real title is "Roulette — You won!".
    .filter(item => queryWords.every(word => item.titleKey.includes(word)))
    .sort((a, b) => {
      const rankDiff = rankMatch(a.title, normalizedQuery) - rankMatch(b.title, normalizedQuery);
      if (rankDiff) return rankDiff;
      return a.title.localeCompare(b.title);
    })
    .filter(item => {
      const key = `${item.record.channelId}:${item.record.messageId}:${Number(item.record.embedIndex || 0)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildSearchResultsPayload(guild, records, query) {
  const matches = findTitleMatches(records, query);
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
      // This intentionally uses the Embed Manager's existing selection ID so
      // selecting a search result loads the embed into the normal builder flow.
      .setCustomId(`simple_embed_modify_embed:${channelId}:0`)
      .setPlaceholder(shortText(`${channel?.name ? `# ${channel.name}` : 'Channel'} • ${usable.length} match${usable.length === 1 ? '' : 'es'}`))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(...usable.map(({ record, title }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(shortText(title))
          .setDescription(shortText(channel?.name ? `#${channel.name} • title match` : 'Title match'))
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
        `**Showing:** ${shown}${hidden ? ` • ${hidden} more match${hidden === 1 ? '' : 'es'} not shown` : ''}`,
        '',
        'Choose a matching title below to load it directly into the Embed Builder.',
      ].join('\n')
    : [
        `Search: **${String(query).slice(0, 120)}**`,
        '',
        'No embed title matched that search. Try one word or any part of the title.',
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
    .setLabel('Embed title or part of title')
    .setPlaceholder('Example: Roulette')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(120)
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Search embed by title')
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
  const records = await getEmbedRegistry(interaction.guildId);
  const payload = buildSearchResultsPayload(interaction.guild, records, query);
  await submitted.update(payload).catch(async error => {
    logger.error('[EMBED_BUILDER] Title search result update failed:', error);
    if (!submitted.replied && !submitted.deferred) {
      await submitted.reply({ content: 'Could not load the embed search results.', ephemeral: true }).catch(() => {});
    }
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
        logger.error('[EMBED_BUILDER] Title search failed:', error);
      });
    });

    logger.info('[EMBED_BUILDER] Partial title search enabled in Modify embed.');
  },
};