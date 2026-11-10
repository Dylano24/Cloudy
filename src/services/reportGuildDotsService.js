import { readFile } from 'node:fs/promises';
import { logger } from '../utils/logger.js';

// Application emoji aren't listed under a guild's Server Settings > Emoji.
// Mirror the report status dots into the owner's Dylano server as real guild emoji.
const DYLANO_GUILD_ID = '1532882647838228723';
const DOTS = [
  // Replace only the known oversized Cloudy blue dot, never unrelated emojis.
  { name: 'cloudy_report_dot_blue', replacesId: '1569611084598611998', file: '../../assets/feed-emojis/report_dot_blue.png' },
  { name: 'cloudy_report_dot_orange', file: '../../assets/feed-emojis/report_dot_orange.png' },
  { name: 'cloudy_report_dot_white', sourceId: '1543291335036108830', aliases: ['W87205667glowingdotwhite'] },
  { name: 'cloudy_report_dot_green', sourceId: '1567760480439771286', animated: true, aliases: ['glowing_dot_green'] },
  { name: 'cloudy_report_dot_red', sourceId: '1543291468377104436', aliases: ['W8733476glowingdotred'] },
];

async function dotImage(dot, extension = 'png') {
  if (dot.file) return readFile(new URL(dot.file, import.meta.url));
  const url = `https://cdn.discordapp.com/emojis/${dot.sourceId}.${extension}?size=128`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error(`Could not retrieve the ${dot.name} artwork (HTTP ${response.status}).`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function ensureReportGuildDots(client) {
  try {
    const guild = client.guilds.cache.get(DYLANO_GUILD_ID)
      || await client.guilds.fetch(DYLANO_GUILD_ID).catch(() => null);
    if (!guild?.emojis?.fetch || !guild.emojis.create) {
      logger.warn('[REPORT_GUILD_DOTS] Dylano guild not found or emoji manager unavailable.');
      return;
    }

    const existing = await guild.emojis.fetch();
    const uploaded = [];
    const alreadyPresent = [];
    const errors = [];
    for (const dot of DOTS) {
      const found = existing.find(emoji => [dot.name, ...(dot.aliases || [])].includes(emoji.name));
      if (found && (!dot.replacesId || String(found.id) !== dot.replacesId)) {
        alreadyPresent.push(`${dot.name}=${found.id}`);
        continue;
      }
      try {
        if (found && dot.replacesId === String(found.id)) {
          // Validate replacement image before touching the old guild emoji.
          const png = await dotImage(dot);
          if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw new Error('Replacement artwork must be a PNG.');
          }
          if (typeof found.delete !== 'function') {
            throw new Error('Existing blue emoji cannot be replaced with available permissions.');
          }
          await found.delete('Replace old oversized Cloudy blue dot with matching glow');
          existing.delete(found.id);
        }
        // Preserve the original animation when supported. If the guild has no
        // animated emoji slot, gracefully fall back to a static PNG.
        let created;
        for (const extension of dot.animated ? ['gif', 'png'] : ['png']) {
          try {
            const attachment = await dotImage(dot, extension);
            created = await guild.emojis.create({
              attachment,
              name: dot.name,
              reason: 'Cloudy Inc. report status dots',
            });
            break;
          } catch (error) {
            if (extension !== 'gif') throw error;
          }
        }
        if (created) {
          existing.set(created.id, created);
          uploaded.push(`${created.name}=${created.id}`);
        }
      } catch (error) {
        errors.push(`${dot.name}: ${error?.message || error}`);
      }
    }
    const summary = `[REPORT_GUILD_DOTS] Dylano: ${uploaded.length} uploaded, ${alreadyPresent.length} existing`
      + (uploaded.length ? `; uploaded ${uploaded.join(', ')}` : '')
      + (alreadyPresent.length ? `; existing ${alreadyPresent.join(', ')}` : '')
      + (errors.length ? `; failed ${errors.join('; ')}` : '');
    if (errors.length) logger.warn(summary);
    else logger.info(summary);
  } catch (error) {
    logger.warn(`[REPORT_GUILD_DOTS] Dylano emoji sync failed: ${error?.message || error}`);
  }
}
