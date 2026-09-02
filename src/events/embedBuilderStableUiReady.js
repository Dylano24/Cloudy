import {
  EmbedBuilder,
  Events,
  StringSelectMenuBuilder,
} from 'discord.js';

const PATCH_MARKER = Symbol.for('cloudy.embedBuilderStableUi.v2');

function stripManagerCounts(value) {
  return String(value || '')
    .replace(/^(.+?)\s+•\s+\d+\s+embeds?$/i, '$1')
    .replace(/^Edit this template\s+•\s+applies to\s+\d+\s+matching embed\(s\)$/i, 'Edit this template');
}

function stripManagerDescriptionCounts(value) {
  return String(value || '')
    .split('\n')
    .filter(line => !/^\*\*(?:Embeds found|Embeds|Templates):\*\*\s+\d+\s*$/i.test(line.trim()))
    .join('\n');
}

function cleanLabel(value) {
  return String(value || '')
    .replace(/<a?:[^:>]+:\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function optionData(option) {
  return option?.data && typeof option.data === 'object' ? option.data : option;
}

function cleanBuilderOption(option, isChannelMenu) {
  const data = optionData(option);
  if (!data || typeof data !== 'object') return option;

  if (typeof data.label === 'string') {
    const label = stripManagerCounts(data.label);
    if (typeof option?.setLabel === 'function') option.setLabel(label);
    else data.label = label;
  }

  if (!isChannelMenu && typeof data.description === 'string') {
    const description = stripManagerCounts(data.description);
    if (typeof option?.setDescription === 'function') option.setDescription(description);
    else data.description = description;
  }

  return option;
}

export default {
  name: Events.ClientReady,
  once: true,

  execute() {
    if (globalThis[PATCH_MARKER]) return;
    globalThis[PATCH_MARKER] = true;

    const originalAddOptions = StringSelectMenuBuilder.prototype.addOptions;
    const originalEmbedDescription = EmbedBuilder.prototype.setDescription;

    // Only touch the two Modify Embed menus. Other Discord selects keep their
    // original labels/descriptions and behavior.
    StringSelectMenuBuilder.prototype.addOptions = function cloudyStableBuilderOptions(...options) {
      const customId = String(this?.data?.custom_id || '');
      const isChannelMenu = customId.startsWith('simple_embed_modify_channel:');
      const isEmbedMenu = customId.startsWith('simple_embed_modify_embed:');
      if (!isChannelMenu && !isEmbedMenu) {
        return originalAddOptions.apply(this, options);
      }

      const flat = options.flat(Infinity);
      const unique = [];
      const seen = new Set();

      for (const rawOption of flat) {
        const option = cleanBuilderOption(rawOption, isChannelMenu);
        const data = optionData(option) || {};
        const key = isChannelMenu
          ? `channel:${String(data.value || '')}`
          : `embed:${cleanLabel(data.label)}`;
        if (!key.endsWith(':') && !seen.has(key)) {
          seen.add(key);
          unique.push(option);
        }
      }

      return originalAddOptions.call(this, ...unique);
    };

    EmbedBuilder.prototype.setDescription = function cloudyStableBuilderDescription(description) {
      const title = String(this?.data?.title || '');
      const next = title === 'Modify embed'
        ? stripManagerDescriptionCounts(description)
        : description;
      return originalEmbedDescription.call(this, next);
    };
  },
};
