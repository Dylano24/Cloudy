import {
  EmbedBuilder,
  Events,
  StringSelectMenuOptionBuilder,
} from 'discord.js';

const PATCH_MARKER = Symbol.for('cloudy.embedBuilderStableUi');

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

export default {
  name: Events.ClientReady,
  once: true,

  execute() {
    if (globalThis[PATCH_MARKER]) return;
    globalThis[PATCH_MARKER] = true;

    const originalOptionLabel = StringSelectMenuOptionBuilder.prototype.setLabel;
    const originalOptionDescription = StringSelectMenuOptionBuilder.prototype.setDescription;
    const originalEmbedDescription = EmbedBuilder.prototype.setDescription;

    StringSelectMenuOptionBuilder.prototype.setLabel = function cloudyStableBuilderLabel(label) {
      return originalOptionLabel.call(this, stripManagerCounts(label));
    };

    StringSelectMenuOptionBuilder.prototype.setDescription = function cloudyStableBuilderOptionDescription(description) {
      return originalOptionDescription.call(this, stripManagerCounts(description));
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
