import { EmbedBuilder, Events } from 'discord.js';
import { applySavedEmbedTemplates } from '../services/embedTemplateService.js';
import { normalizeCloudyMessage } from '../services/cloudyBrandingService.js';
import { reconcileFaqAiPanel, FAQ_AI_CHANNEL_ID } from '../services/faqAiService.js';

const CATALOG_CONTENT = 'System & error embed templates';
const TERMS_CHANNEL_ID = '1533191366190829768';
const TERMS_YESTERDAY_FOOTER = '© Cloudy Inc. • Last updated: 31 August 2026';

function compactName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function deleteOrphanCatalogMessages(client, guild) {
  const catalogIds = new Set(
    await client.db?.get?.(`cloudy:system-embed-catalog:${guild.id}`, []).catch(() => []) || [],
  );
  const botlog = [...guild.channels.cache.values()]
    .filter(channel => channel?.isTextBased?.() && channel?.messages?.fetch)
    .find(channel => compactName(channel.name).includes('botlog'));
  if (!botlog) return 0;

  let before;
  let removed = 0;
  while (true) {
    const messages = await botlog.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!messages?.size) break;
    for (const message of messages.values()) {
      if (
        message.author?.id === client.user.id
        && String(message.content || '').trim() === CATALOG_CONTENT
        && !catalogIds.has(message.id)
      ) {
        if (await message.delete().then(() => true).catch(() => false)) removed += 1;
      }
    }
    before = messages.last()?.id;
    if (messages.size < 100 || !before) break;
  }
  return removed;
}

async function restoreYesterdayTerms(client) {
  const channel = await client.channels.fetch(TERMS_CHANNEL_ID).catch(() => null);
  if (!channel?.messages?.fetch) return false;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const message = messages?.find(item =>
    item.author?.id === client.user.id
    && item.embeds?.some(embed => /terms of service$/i.test(String(embed.title || '').trim())),
  );
  if (!message?.editable || !message.embeds?.length) return false;

  const embeds = message.embeds.map(embed => {
    const data = embed.toJSON();
    if (/terms of service$/i.test(String(data.title || '').trim())) {
      data.footer = { ...(data.footer || {}), text: TERMS_YESTERDAY_FOOTER };
    }
    return new EmbedBuilder(data);
  });
  await message.edit({ embeds }).catch(() => null);
  return true;
}

async function restoreExistingBotEmbeds(client, guild) {
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return { scanned: 0, templated: 0, normalized: 0 };

  let scanned = 0;
  let templated = 0;
  let normalized = 0;

  for (const channel of [...channels.values()].filter(item => item?.isTextBased?.() && item?.messages?.fetch)) {
    let before;
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!messages?.size) break;

      for (const message of messages.values()) {
        if (message.author?.id !== client.user.id || !message.embeds?.length || !message.editable) continue;
        if (String(message.content || '').trim() === CATALOG_CONTENT) continue;
        scanned += 1;
        if (await applySavedEmbedTemplates(message).catch(() => false)) templated += 1;
        if (await normalizeCloudyMessage(message, { ensureFooter: true }).catch(() => false)) normalized += 1;
      }

      before = messages.last()?.id;
      if (messages.size < 100 || !before) break;
    }
  }

  return { scanned, templated, normalized };
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(() => {
      void (async () => {
        let orphanCatalogs = 0;
        for (const guild of client.guilds.cache.values()) {
          orphanCatalogs += await deleteOrphanCatalogMessages(client, guild);
        }

        const faq = await reconcileFaqAiPanel(client);
        if (faq?.editable) {
          await normalizeCloudyMessage(faq, { ensureFooter: true }).catch(() => false);
        }

        const termsRestored = await restoreYesterdayTerms(client);

        const totals = { scanned: 0, templated: 0, normalized: 0 };
        for (const guild of client.guilds.cache.values()) {
          const result = await restoreExistingBotEmbeds(client, guild);
          totals.scanned += result.scanned;
          totals.templated += result.templated;
          totals.normalized += result.normalized;
        }

        const faqChannel = await client.channels.fetch(FAQ_AI_CHANNEL_ID).catch(() => null);
        const faqCheck = faqChannel?.messages?.fetch
          ? await faqChannel.messages.fetch({ limit: 20 }).catch(() => null)
          : null;
        const faqTitle = faqCheck?.find(message => message.author?.id === client.user.id && message.embeds?.length)?.embeds?.[0]?.title || 'missing';

        console.log(`[YESTERDAY_RESTORE] live sweep complete orphanCatalogs=${orphanCatalogs} scanned=${totals.scanned} templated=${totals.templated} normalized=${totals.normalized} termsRestored=${termsRestored} faqTitle=${faqTitle}`);
      })().catch(error => console.error('[YESTERDAY_RESTORE] live sweep failed', error));
    }, 60_000);
    timer.unref?.();
  },
};
