import { EmbedBuilder, Events } from 'discord.js';
import { reconcileFaqAiPanel } from '../services/faqAiService.js';

const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const panel = await reconcileFaqAiPanel(client);
    if (!panel?.editable || !panel.embeds?.[0]) return;

    const currentEmbed = panel.embeds[0];
    const footerInBody = `\n\n**${CLOUDY_FOOTER}**`;
    const description = currentEmbed.description?.endsWith(footerInBody)
      ? currentEmbed.description.slice(0, -footerInBody.length)
      : currentEmbed.description;

    const embed = EmbedBuilder.from(currentEmbed)
      .setDescription(description || null)
      .setFooter({ text: CLOUDY_FOOTER });

    await panel.edit({ embeds: [embed] });
  },
};
