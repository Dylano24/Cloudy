import { logger } from '../utils/logger.js';

const TERMS_ICON_EMOJI_NAME = 'cloudy_terms_icon';
const TERMS_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABXklEQVR42u2aSw6CMBCG6YRLcEF2BhPDKYyJxp0X5Bi6YkMESplX2//fuPAx831ObWPaNAiCIAiC1JqQ8qb76/O1bnwc+sDxOZQjPGcflCM8Zz/hTLGu69Shp2liXQ7JAizgtySkyqCUBizh9+ofXRbUFJgjEooUcERCsQKqmoAzuwAmAAIgwGfez0e9AmZ4DQnk/ZuXlkA5jL2kBMphzV+ut7IFWMG7EGAJLyrg7LrVgBcTELuNrT2vBS8iIHYb8wDPLiAW1gs8u4AtAM3TnekSiJHg5dsX+xE8CmMFL7oNxkJZwosfhPbgrOFVToJrkB7g1Y7CM+zysRoBXuHd/R8AARAAARAAATkI2LqhoRHO+uShCcu6bewLx6EPy0sH1pMw96U2AVyXE73AJy0BLxK4+mhTi/+7g+NtQsQErMXbTVKcAyQFeB/32P5Io4jnH0jSLJbT7oAgCIIgFeQHknyT/C1lG1EAAAAASUVORK5CYII=';

let cachedEmoji = null;
let pendingEmoji = null;

export async function getTermsTitleIcon(client) {
  if (cachedEmoji?.available) return cachedEmoji.toString();
  if (pendingEmoji) return pendingEmoji;

  pendingEmoji = (async () => {
    try {
      const application = client.application ?? await client.fetchApplication();
      const emojis = await application.emojis.fetch();
      let emoji = emojis.find(item => item.name === TERMS_ICON_EMOJI_NAME);

      if (!emoji) {
        emoji = await application.emojis.create({
          name: TERMS_ICON_EMOJI_NAME,
          attachment: Buffer.from(TERMS_ICON_BASE64, 'base64')
        });
        logger.info(`[TERMS_ICON] Created application emoji ${emoji.id}.`);
      }

      cachedEmoji = emoji;
      return emoji.toString();
    } catch (error) {
      logger.warn('[TERMS_ICON] Could not load/create terms title icon; continuing without it.', error);
      return '';
    } finally {
      pendingEmoji = null;
    }
  })();

  return pendingEmoji;
}
