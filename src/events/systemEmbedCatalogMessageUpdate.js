import { Events } from 'discord.js';
import { syncSystemEmbedCatalogMessage } from '../services/systemEmbedCatalogService.js';
import { saveGlobalEmbedTemplate } from '../services/embedTemplateService.js';
import { logger } from '../utils/logger.js';

const TEMPLATE_KEY_PREFIX = 'cloudy template key:';
const TEMPLATE_CONTEXT = 'cloudy context: gambling/roulette';
const ROULETTE_TEMPLATE_TITLES = new Map([
  ['embed:899476a8', 'Roulette — You lost'],
  ['embed:ff811637', 'Roulette — You won!'],
]);

function rouletteCanonicalTitle(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed || {});
  const authorName = String(data.author?.name || '');
  const normalizedAuthor = authorName.toLowerCase();
  if (!normalizedAuthor.includes(TEMPLATE_CONTEXT)) return null;

  const prefixIndex = normalizedAuthor.indexOf(TEMPLATE_KEY_PREFIX);
  if (prefixIndex !== -1) {
    const rawKey = authorName
      .slice(prefixIndex + TEMPLATE_KEY_PREFIX.length)
      .split('||')[0]
      .trim()
      .toLowerCase();
    const canonical = ROULETTE_TEMPLATE_TITLES.get(rawKey);
    if (canonical) return canonical;
  }

  const title = String(data.title || '');
  if (/roulette\s*[—-]\s*you\s+lost/i.test(title)) return 'Roulette — You lost';
  if (/roulette\s*[—-]\s*you\s+won!?/i.test(title)) return 'Roulette — You won!';
  return null;
}

export default {
  name: Events.MessageUpdate,
  once: false,

  async execute(oldMessage, newMessage) {
    const message = newMessage?.partial
      ? await newMessage.fetch().catch(() => null)
      : newMessage;
    if (!message) return;

    await syncSystemEmbedCatalogMessage(message).catch(error => {
      logger.warn(`System embed catalog sync failed: ${error.message}`);
    });

    // Roulette slash replies are not stored in the normal Builder registry. When
    // their system-catalog template is edited, mirror that exact template into
    // the global saved-template layer immediately so the next /roulette reply
    // receives the saved title/color/footer/media instead of the command default.
    for (let index = 0; index < (message.embeds?.length || 0); index += 1) {
      const embed = message.embeds[index];
      const canonicalTitle = rouletteCanonicalTitle(embed);
      if (!canonicalTitle) continue;

      const data = embed.toJSON();
      const oldData = oldMessage?.embeds?.[index]?.toJSON?.() || {};
      const aliases = [canonicalTitle, oldData.title, data.title].filter(Boolean);

      void saveGlobalEmbedTemplate(
        message.guildId,
        aliases,
        data,
        { applyThumbnail: true, applyImage: true },
      ).catch(error => {
        logger.warn(`Roulette embed template persistence failed: ${error.message}`);
      });
    }
  },
};
