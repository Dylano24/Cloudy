import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';

const GUILD_ID = '1532882647838228723';
const TARGETS = Object.freeze([
  {
    channelId: '1556354678407827637',
    messageId: '1568526805072216085',
    buttons: {
      'Contact us': { id: '1543303628159320165', name: 'W92mailmessage' },
      'Rust support': { id: '1568706168006770719', name: 'X99rustlogo2', animated: true },
    },
  },
  {
    channelId: '1554538607233073182',
    messageId: '1568769178540707934',
    buttons: { Instructions: { id: '1543287391131803749', name: 'Y98boosterdiscordnitro', animated: true } },
  },
  {
    channelId: '1554538586001645679',
    messageId: '1568514711941816442',
    buttons: {},
    rename: { Assistant: 'Cloudy assistant' },
  },
  {
    channelId: '1554538650761691260',
    messageId: '1568543862908129352',
    buttons: { 'Start chat': { id: '1568808462782177280', name: 'white_bubble' } },
    linkRename: { 'Support assistant': 'Cloudy assistant' },
  },
]);

export async function reconcileRequestedButtonEmojis(client) {
  const guild = client.guilds?.cache?.get(GUILD_ID);
  if (!guild) return { checked: 0, updated: 0 };
  let checked = 0, updated = 0;
  for (const target of TARGETS) {
    const channel = guild.channels?.cache?.get(target.channelId)
      || await guild.channels?.fetch?.(target.channelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(target.messageId).catch(() => null);
    if (message?.author?.id !== client.user?.id) continue;
    checked++;
    const components = message.components?.map(row => row.toJSON?.() || row) || [];
    let dirty = false;
    for (const row of components) {
      for (const button of row.components || []) {
        if (button.type !== 2) continue;
        if (target.rename?.[button.label] && button.custom_id === 'faq_ai_question') {
          button.label = target.rename[button.label];
          dirty = true;
        }
        // Rename only the existing contact-us link to the Cloudy assistant.
        // The FAQ channel URL, button type and position remain unchanged.
        const updatedLabel = target.linkRename?.[button.label];
        if (updatedLabel && button.style === 5
          && String(button.url || '').includes('/1554538586001645679')) {
          button.label = updatedLabel;
          dirty = true;
        }
        const emoji = target.buttons[button.label];
        if (!emoji) continue;
        // Replace the previous default mail icon on Start chat only. Preserve
        // all other custom emojis and the original embed/message id.
        const previousStartChatIcon = button.custom_id === 'create_ticket'
          && button.emoji?.id === '1543303628159320165';
        if (!previousStartChatIcon
          && (button.emoji?.id || (button.emoji && button.emoji.name !== '💬'))) continue;
        button.emoji = emoji;
        dirty = true;
      }
    }
    if (!dirty) continue;
    await message.edit({ components });
    updated++;
  }
  return { checked, updated };
}

export default {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    const timer = setTimeout(() => {
      void reconcileRequestedButtonEmojis(client)
        .then(({ checked, updated }) => logger.info(`[REQUESTED_BUTTONS] Checked ${checked}; updated ${updated}`))
        .catch(error => logger.warn('[REQUESTED_BUTTONS] Could not update buttons:', error));
    }, 4000);
    timer.unref?.();
  },
};
