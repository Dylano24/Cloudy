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
const SEARCH_MODAL_PREFIX = 'simple_embed_title_search_modal_';
const SEARCH_INPUT_ID = 'title_query';
const SEARCH_PAGE_PREFIX = 'simple_embed_google_search_page_';
const MAX_MENUS_PER_PAGE = 4;
const MAX_RESULTS_PER_MENU = 25;
const MAX_PREVIEW_LINES = 12;
const SEARCH_SESSION_TTL = 15 * 60_000;
const searchSessions = new Map();

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

function searchButton() {
  return new ButtonBuilder()
    .setCustomId(SEARCH_BUTTON_ID)
    .setLabel('Search')
    .setEmoji('🔎')
    .setStyle(ButtonStyle.Secondary);
}

function addSearchControl(payload) {
  if (!isModifyEmbedPayload(payload) || hasSearchButton(payload)) return payload;
  const components = Array.isArray(payload.components) ? [...payload.components] : [];
  if (components.length >= 5) return payload;
  components.push(new ActionRowBuilder().addComponents(searchButton()));
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

function searchKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
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

function normalizedTitle(record) {
  const snapshot = getEmbedRegistrySnapshot(record) || {};
  return String(record?.name || record?.title || snapshot?.title || 'Untitled embed')
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function recordPriority(record) {
  const source = String(record?.source || '').toLowerCase();
  if (source === 'system-catalog') return 100;
  if (source.includes('template')) return 80;
  if (source.includes('modified')) return 65;
  if (source === 'history') return 20;
  return 40;
}

function recordDocument(guild, record) {
  const snapshot = getEmbedRegistrySnapshot(record) || {};
  const channel = guild?.channels?.cache?.get?.(String(record?.channelId || '')) || null;
  const fields = Array.isArray(snapshot.fields)
    ? snapshot.fields.flatMap(field => [field?.name, field?.value])
    : [];

  const title = normalizedTitle(record);
  const titleText = [title, record?.name, record?.title, snapshot.title]
    .filter(Boolean)
    .join(' ');
  const bodyText = [
    snapshot.description,
    snapshot.author?.name,
    snapshot.footer?.text,
    channel?.name,
    channel?.parent?.name,
    record?.source,
    ...fields,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    title,
    titleKey: searchKey(titleText),
    bodyKey: searchKey(bodyText),
    allKey: searchKey(`${titleText} ${bodyText}`),
    channel,
  };
}

function damerauLevenshtein(left, right, maxDistance = 4) {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const previousPrevious = new Array(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMinimum = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );

      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        value = Math.min(value, previousPrevious[j - 2] + 1);
      }

      current[j] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }

    if (rowMinimum > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j += 1) previousPrevious[j] = previous[j];
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function tokenSimilarity(queryToken, candidateToken) {
  if (!queryToken || !candidateToken) return 0;
  if (queryToken === candidateToken) return 1;
  if (candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken)) return 0.92;
  if (queryToken.length >= 3 && candidateToken.includes(queryToken)) return 0.86;
  if (candidateToken.length >= 3 && queryToken.includes(candidateToken)) return 0.82;

  if (queryToken.length < 3 || candidateToken.length < 3) return 0;
  const maxLength = Math.max(queryToken.length, candidateToken.length);
  const maxDistance = maxLength <= 5 ? 1 : maxLength <= 9 ? 2 : 3;
  const distance = damerauLevenshtein(queryToken, candidateToken, maxDistance);
  if (distance > maxDistance) return 0;
  return Math.max(0, 1 - (distance / maxLength));
}

function uniqueTokens(value, limit = 700) {
  return [...new Set(searchKey(value).split(' ').filter(Boolean))].slice(0, limit);
}

function bestTokenSimilarity(queryToken, tokens) {
  let best = 0;
  for (const token of tokens) {
    const score = tokenSimilarity(queryToken, token);
    if (score > best) best = score;
    if (best === 1) break;
  }
  return best;
}

function fuzzyScore(document, query) {
  const normalizedQuery = searchKey(query);
  if (!normalizedQuery) return null;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  const titleTokens = uniqueTokens(document.titleKey, 150);
  const bodyTokens = uniqueTokens(document.bodyKey, 700);
  let score = 0;

  for (const queryToken of queryTokens) {
    const titleScore = bestTokenSimilarity(queryToken, titleTokens);
    const bodyScore = bestTokenSimilarity(queryToken, bodyTokens);
    const best = Math.max(titleScore, bodyScore * 0.88);
    const threshold = queryToken.length <= 2 ? 0.92 : queryToken.length === 3 ? 0.72 : 0.60;
    if (best < threshold) return null;
    score += (titleScore * 115) + (bodyScore * 55);
  }

  if (document.titleKey === normalizedQuery) score += 500;
  else if (document.titleKey.startsWith(normalizedQuery)) score += 350;
  else if (document.titleKey.includes(normalizedQuery)) score += 250;
  else if (document.allKey.includes(normalizedQuery)) score += 120;

  return score / Math.max(1, queryTokens.length);
}

function preferredRecord(left, right) {
  if (!left) return right;
  if (right.score > left.score + 0.01) return right;
  if (left.score > right.score + 0.01) return left;

  const priorityDiff = recordPriority(right.record) - recordPriority(left.record);
  if (priorityDiff > 0) return right;
  if (priorityDiff < 0) return left;

  const leftTime = new Date(left.record?.updatedAt || left.record?.createdAt || 0).getTime();
  const rightTime = new Date(right.record?.updatedAt || right.record?.createdAt || 0).getTime();
  return rightTime >= leftTime ? right : left;
}

function findSearchMatches(guild, records, query) {
  const grouped = new Map();

  for (const record of records) {
    const document = recordDocument(guild, record);
    const score = fuzzyScore(document, query);
    if (score == null) continue;

    const logicalName = searchKey(document.title)
      || searchKey(record?.name)
      || searchKey(record?.source)
      || `${record.messageId}:${record.embedIndex || 0}`;
    const groupKey = `${record.channelId}:${logicalName}`;
    const candidate = { record, ...document, score };
    grouped.set(groupKey, preferredRecord(grouped.get(groupKey), candidate));
  }

  return [...grouped.values()].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
    const priorityDiff = recordPriority(b.record) - recordPriority(a.record);
    if (priorityDiff) return priorityDiff;
    return a.title.localeCompare(b.title);
  });
}

function segmentSearchResults(matches) {
  const orderedChannels = new Map();
  for (const match of matches) {
    const channelId = String(match.record.channelId || '');
    if (!channelId) continue;
    if (!orderedChannels.has(channelId)) orderedChannels.set(channelId, []);
    orderedChannels.get(channelId).push(match);
  }

  const segments = [];
  for (const [channelId, channelMatches] of orderedChannels) {
    for (let offset = 0; offset < channelMatches.length; offset += MAX_RESULTS_PER_MENU) {
      segments.push({
        channelId,
        matches: channelMatches.slice(offset, offset + MAX_RESULTS_PER_MENU),
        offset,
      });
    }
  }
  return segments;
}

function cleanPreview(value, max = 70) {
  return String(value || '')
    .replace(/[\n\r]+/g, ' ')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function buildSearchResultsPayload(guild, query, matches, page = 0) {
  const segments = segmentSearchResults(matches);
  const pageCount = Math.max(1, Math.ceil(segments.length / MAX_MENUS_PER_PAGE));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pageCount - 1);
  const pageSegments = segments.slice(
    safePage * MAX_MENUS_PER_PAGE,
    (safePage + 1) * MAX_MENUS_PER_PAGE,
  );
  const components = [];

  for (const segment of pageSegments) {
    const channel = guild.channels.cache.get(segment.channelId) || null;
    const start = segment.offset + 1;
    const end = segment.offset + segment.matches.length;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`simple_embed_modify_embed:${segment.channelId}:0`)
      .setPlaceholder(shortText(`${channel?.name ? `# ${channel.name}` : 'Channel'} • results ${start}-${end}`))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(...segment.matches.map(({ record, title }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(shortText(title))
          .setDescription(shortText(
            record.source === 'system-catalog'
              ? 'Automatic template • future matching messages'
              : `${channel?.name ? `#${channel.name} • ` : ''}${record.source || 'embed'}`,
          ))
          .setValue(`${record.messageId}:${Number(record.embedIndex || 0)}`),
      ));
    components.push(new ActionRowBuilder().addComponents(menu));
  }

  const navigation = new ActionRowBuilder();
  if (pageCount > 1) {
    navigation.addComponents(
      new ButtonBuilder()
        .setCustomId(`${SEARCH_PAGE_PREFIX}${Math.max(0, safePage - 1)}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId(`${SEARCH_PAGE_PREFIX}${Math.min(pageCount - 1, safePage + 1)}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= pageCount - 1),
    );
  }
  navigation.addComponents(
    searchButton().setLabel('Search again'),
    new ButtonBuilder()
      .setCustomId('simple_embed_modify_back')
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary),
  );
  components.push(navigation);

  const visibleMatches = pageSegments.flatMap(segment => segment.matches);
  const preview = visibleMatches.slice(0, MAX_PREVIEW_LINES).map((match, index) => {
    const channel = guild.channels.cache.get(String(match.record.channelId || '')) || null;
    const source = match.record.source === 'system-catalog' ? 'template' : 'embed';
    return `**${(safePage * MAX_PREVIEW_LINES) + index + 1}.** ${cleanPreview(match.title)} — ${channel?.name ? `#${cleanPreview(channel.name, 30)}` : 'channel'} • ${source}`;
  });

  const description = matches.length
    ? [
        `Search: **${cleanPreview(query, 120)}**`,
        `**${matches.length} result${matches.length === 1 ? '' : 's'} found** • Page ${safePage + 1}/${pageCount}`,
        '',
        ...preview,
        ...(visibleMatches.length > MAX_PREVIEW_LINES ? [`…and ${visibleMatches.length - MAX_PREVIEW_LINES} more on this page.`] : []),
        '',
        'Type normally — partial words and small spelling mistakes are accepted.',
        'Choose a result below to load it into the Embed Builder.',
      ].join('\n')
    : [
        `Search: **${cleanPreview(query, 120)}**`,
        '',
        '**No results found.**',
        'Try a title, a few words from the message, a field name, log type, channel name, or even a close spelling.',
      ].join('\n');

  return {
    embeds: [new EmbedBuilder()
      .setTitle('Search embeds')
      .setDescription(description.slice(0, 4096))
      .setColor(0xFFFFFF)],
    components,
  };
}

function sessionKey(interaction) {
  return `${interaction.guildId || 'dm'}:${interaction.user?.id || 'unknown'}:${interaction.message?.id || 'unknown'}`;
}

function cleanupSearchSessions() {
  const cutoff = Date.now() - SEARCH_SESSION_TTL;
  for (const [key, session] of searchSessions) {
    if ((session.updatedAt || 0) < cutoff) searchSessions.delete(key);
  }
}

async function refreshRecords(interaction) {
  let records = await getEmbedRegistry(interaction.guildId);
  try {
    const reconciled = await reconcileEmbedRegistry(interaction.guild);
    if (Array.isArray(reconciled?.records)) records = reconciled.records;
  } catch (error) {
    logger.debug(`[EMBED_BUILDER] Search registry refresh skipped: ${error?.message || error}`);
  }
  return records;
}

async function handleSearchButton(interaction) {
  if (!interaction.isButton?.() || interaction.customId !== SEARCH_BUTTON_ID) return false;

  const modalId = `${SEARCH_MODAL_PREFIX}${interaction.id}`;
  const input = new TextInputBuilder()
    .setCustomId(SEARCH_INPUT_ID)
    .setLabel('Search')
    .setPlaceholder('roulette, roueltte, ban log, cash balance...')
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(120)
    .setRequired(true);

  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Search embeds')
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
  const records = await refreshRecords(interaction);
  const matches = findSearchMatches(interaction.guild, records, query);
  cleanupSearchSessions();
  searchSessions.set(sessionKey(interaction), { query, matches, updatedAt: Date.now() });

  const payload = buildSearchResultsPayload(interaction.guild, query, matches, 0);
  await submitted.update(payload).catch(async error => {
    logger.error('[EMBED_BUILDER] Search result update failed:', error);
    if (!submitted.replied && !submitted.deferred) {
      await submitted.deferUpdate().catch(() => {});
      await submitted.editReply(payload).catch(() => {});
    }
  });
  return true;
}

async function handleSearchPage(interaction) {
  if (!interaction.isButton?.() || !interaction.customId.startsWith(SEARCH_PAGE_PREFIX)) return false;
  cleanupSearchSessions();
  const session = searchSessions.get(sessionKey(interaction));
  if (!session) {
    await interaction.update({
      embeds: [new EmbedBuilder()
        .setTitle('Search embeds')
        .setDescription('This search expired. Press Search to run it again.')
        .setColor(0xFFFFFF)],
      components: [new ActionRowBuilder().addComponents(
        searchButton(),
        new ButtonBuilder()
          .setCustomId('simple_embed_modify_back')
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary),
      )],
    }).catch(() => {});
    return true;
  }

  const page = Number(interaction.customId.slice(SEARCH_PAGE_PREFIX.length)) || 0;
  session.updatedAt = Date.now();
  await interaction.update(buildSearchResultsPayload(
    interaction.guild,
    session.query,
    session.matches,
    page,
  )).catch(error => logger.error('[EMBED_BUILDER] Search page update failed:', error));
  return true;
}

export default {
  name: Events.ClientReady,
  once: true,

  execute(client) {
    patchManagerResponses();

    client.on(Events.InteractionCreate, interaction => {
      if (!interaction.isButton?.()) return;
      if (interaction.customId === SEARCH_BUTTON_ID) {
        void handleSearchButton(interaction).catch(error => {
          logger.error('[EMBED_BUILDER] Search failed:', error);
        });
        return;
      }
      if (interaction.customId.startsWith(SEARCH_PAGE_PREFIX)) {
        void handleSearchPage(interaction).catch(error => {
          logger.error('[EMBED_BUILDER] Search pagination failed:', error);
        });
      }
    });

    logger.info('[EMBED_BUILDER] Ranked fuzzy search enabled in Modify embed.');
  },
};