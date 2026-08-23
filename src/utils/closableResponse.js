import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export function buildCloseButtonRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dismiss-response:${ownerId}`)
      .setLabel('Close')
      .setStyle(ButtonStyle.Secondary),
  );
}
