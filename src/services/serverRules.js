import { EmbedBuilder } from 'discord.js';

// A server's own rules, written on the Cloudy Bot dashboard and shown with
// /rules. Stored in the guild config under `rules` ({ title, text, color }).

export const RULES_DEFAULT_TITLE = '{server} rules';
const HEX = /^#[0-9a-f]{6}$/i;

export function rulesOf(config) {
  const rules = config?.rules;
  return rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
}

/** The rules card, or null while the server has not written any rules. */
export function buildRulesEmbed({ rules, guild }) {
  const text = typeof rules?.text === 'string' ? rules.text.trim() : '';
  if (!text) return null;
  const server = guild?.name || 'this server';
  const fill = value => value.replaceAll('{server}', server);
  const title = typeof rules.title === 'string' && rules.title.trim() ? rules.title.trim() : RULES_DEFAULT_TITLE;
  const embed = new EmbedBuilder()
    .setTitle(fill(title).slice(0, 256))
    .setDescription(fill(text).slice(0, 4096))
    .setColor(HEX.test(String(rules.color || '')) ? rules.color : '#FFFFFF');
  const icon = guild?.iconURL?.({ size: 128 });
  if (icon) embed.setThumbnail(icon);
  return embed;
}
