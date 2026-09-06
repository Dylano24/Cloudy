import { Events } from 'discord.js';
import {
  FAQ_AI_BUTTON_ID,
  FAQ_AI_CHANNEL_ID,
  reconcileFaqAiPanel,
} from '../services/faqAiService.js';

const FAQ_PANEL_STATE_KEY = `global:faq-ai:panel:${FAQ_AI_CHANNEL_ID}`;

function isFaqPanelMessage(message, clientUserId) {
  return message?.author?.id === clientUserId && message.components?.some(row =>
    row.components?.some(component => component.customId === FAQ_AI_BUTTON_ID)
  );
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const channel = await client.channels.fetch(FAQ_AI_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) return;

    let panel = null;
    const savedMessageId = client.db?.get
      ? await client.db.get(FAQ_PANEL_STATE_KEY).catch(() => null)
      : null;

    if (savedMessageId) {
      const saved = await channel.messages.fetch(savedMessageId).catch(() => null);
      if (isFaqPanelMessage(saved, client.user.id)) panel = saved;
    }

    if (!panel) {
      const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      panel = recent?.find(message => isFaqPanelMessage(message, client.user.id)) || null;
      if (panel && client.db?.set) {
        await client.db.set(FAQ_PANEL_STATE_KEY, panel.id).catch(() => {});
      }
    }

    // An existing FAQ panel is the live source of truth. Do not rebuild it on
    // startup, because that would overwrite title, text, color, footer, logo,
    // fields or media that were explicitly saved through Embed Builder.
    if (panel) return;

    await reconcileFaqAiPanel(client);
  },
};
