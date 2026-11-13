// The welcome card in a customer's server, built only from that server's own
// settings: title, text, colour and picture (no Cloudy Inc. title, links, logo
// or banner). Cloudy Inc. keeps
// its own card (guildMemberAdd).

import { EmbedBuilder } from 'discord.js';

const HEX = /^#[0-9a-f]{6}$/i;

function safeImage(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  try { return url && new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}

export function buildCustomerWelcomeEmbed({ welcome = {}, guild, user, memberCount, format }) {
  const card = welcome.welcomeEmbed && typeof welcome.welcomeEmbed === 'object' ? welcome.welcomeEmbed : {};
  const data = { user, guild };
  const render = text => (format ? format(text, data) : text) || '';
  const title = render(card.title || 'Welcome to {server}').slice(0, 256);
  const message = render(welcome.welcomeMessage || 'Welcome {user} to {server}!');
  const position = Number.isFinite(memberCount) ? `\n\nYou are member **#${memberCount.toLocaleString('en')}**.` : '';
  const embed = new EmbedBuilder()
    .setTitle(title || guild.name)
    .setDescription(`${message}${position}`.slice(0, 4096))
    .setColor(HEX.test(String(card.color || '')) ? card.color : '#FFFFFF');
  const icon = typeof guild.iconURL === 'function' ? guild.iconURL({ size: 256 }) : null;
  if (icon) embed.setThumbnail(icon);
  const image = safeImage(card.image);
  if (image) embed.setImage(image);
  // No footer here: Cloudy's embed rules add the standard footer when the card is sent.
  return embed;
}
