import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} from 'discord.js';
import { InteractionHelper } from '../utils/interactionHelper.js';

const PATCH_MARKER = Symbol.for('cloudy.embedManagerSearchControl');
const SEARCH_BUTTON_ID = 'simple_embed_title_search';

function componentCustomId(component) {
  const data = component?.toJSON ? component.toJSON() : component?.data || component;
  return String(data?.custom_id || data?.customId || '');
}

function componentType(component) {
  const data = component?.toJSON ? component.toJSON() : component?.data || component;
  return Number(data?.type || 0);
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

  if (!Array.isArray(payload.components)) payload.components = [];

  // Prefer a separate row so select menus are never mixed with buttons.
  if (payload.components.length < 5) {
    payload.components.push(new ActionRowBuilder().addComponents(searchButton()));
    return payload;
  }

  // Discord allows at most five rows. If all rows are already used, append to
  // an existing button-only row that still has room.
  for (let index = payload.components.length - 1; index >= 0; index -= 1) {
    const row = payload.components[index];
    const data = row?.toJSON ? row.toJSON() : row?.data || row;
    const components = Array.isArray(data?.components) ? data.components : [];
    const buttonOnly = components.length > 0 && components.every(component => componentType(component) === 2);
    if (buttonOnly && components.length < 5 && typeof row?.addComponents === 'function') {
      row.addComponents(searchButton());
      return payload;
    }
  }

  return payload;
}

function patchManagerResponses() {
  if (InteractionHelper[PATCH_MARKER]) return;

  const previousPatch = InteractionHelper.patchInteractionResponses.bind(InteractionHelper);
  InteractionHelper.patchInteractionResponses = function patchEmbedManagerSearchControl(interaction) {
    previousPatch(interaction);
    if (!interaction || interaction.__cloudyEmbedManagerSearchControlPatched) return;

    for (const method of ['reply', 'editReply', 'followUp', 'update']) {
      const original = interaction[method]?.bind(interaction);
      if (!original) continue;
      interaction[method] = async (payload, ...args) => original(addSearchControl(payload), ...args);
    }

    interaction.__cloudyEmbedManagerSearchControlPatched = true;
  };

  Object.defineProperty(InteractionHelper, PATCH_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export default {
  name: Events.ClientReady,
  once: true,
  execute() {
    patchManagerResponses();
  },
};
