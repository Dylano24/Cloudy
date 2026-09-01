import { Events } from 'discord.js';
import { ensureSystemEmbedCatalogs } from '../services/systemEmbedCatalogService.js';
import {
  getEmbedRegistry,
  getEmbedRegistrySnapshot,
} from '../services/embedRegistryService.js';
import { saveEmbedTemplateDecoration } from '../services/embedTemplateService.js';
import { getFromDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';

const TEMPLATE_PREFIX = 'cloudy:embed-template:';

function templateStorageKey(guildId, channelId) {
  return `${TEMPLATE_PREFIX}${guildId}:${channelId}`;
}

function comparableFields(fields) {
  return (Array.isArray(fields) ? fields : []).map(field => ({
    name: String(field?.name || ''),
    value: String(field?.value || ''),
    inline: Boolean(field?.inline),
  }));
}

function templateMatchesSnapshot(template, snapshot) {
  if (!template || !snapshot) return false;
  if ((template.title ?? null) !== (snapshot.title ?? null)) return false;
  if ((template.description ?? null) !== (snapshot.description ?? null)) return false;
  if (Number.isInteger(template.color) && template.color !== snapshot.color) return false;
  if ((template.footer?.text ?? null) !== (snapshot.footer?.text ?? null)) return false;
  if (JSON.stringify(comparableFields(template.fields)) !== JSON.stringify(comparableFields(snapshot.fields))) return false;

  if (template.applyThumbnail === true) {
    if ((template.thumbnail?.url ?? null) !== (snapshot.thumbnail?.url ?? null)) return false;
  }
  if (template.applyImage === true) {
    if ((template.image?.url ?? null) !== (snapshot.image?.url ?? null)) return false;
  }

  return true;
}

async function migrateCatalogTemplateScopes(client) {
  let migratedAliases = 0;

  for (const guild of client.guilds.cache.values()) {
    const records = await getEmbedRegistry(guild.id);
    const catalogRecords = records.filter(record =>
      record.source === 'system-catalog'
      && record.backingChannelId
      && String(record.backingChannelId) !== String(record.channelId),
    );

    const sourceTemplateCache = new Map();
    const migratedRecords = new Set();

    for (const record of catalogRecords) {
      const physicalChannelId = String(record.backingChannelId);
      const liveChannelId = String(record.channelId);
      const snapshot = getEmbedRegistrySnapshot(record);
      if (!snapshot) continue;

      const sourceKey = templateStorageKey(guild.id, physicalChannelId);
      let sourceTemplates = sourceTemplateCache.get(sourceKey);
      if (!sourceTemplates) {
        const stored = await getFromDb(sourceKey, {});
        sourceTemplates = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        sourceTemplateCache.set(sourceKey, sourceTemplates);
      }

      const matches = Object.entries(sourceTemplates)
        .filter(([, template]) => templateMatchesSnapshot(template, snapshot));
      if (!matches.length) continue;

      const recordKey = `${liveChannelId}:${record.messageId}:${record.embedIndex || 0}`;
      if (migratedRecords.has(recordKey)) continue;
      migratedRecords.add(recordKey);

      const aliases = matches.map(([alias]) => alias);
      const template = matches[0][1];
      const saved = await saveEmbedTemplateDecoration(
        guild.id,
        liveChannelId,
        aliases,
        {
          ...(template.title != null ? { title: template.title } : {}),
          ...(template.description != null ? { description: template.description } : {}),
          ...(Array.isArray(template.fields) ? { fields: template.fields } : {}),
          ...(Number.isInteger(template.color) ? { color: template.color } : {}),
          ...(template.footer?.text ? { footer: template.footer } : {}),
          ...(template.thumbnail?.url ? { thumbnail: template.thumbnail } : {}),
          ...(template.image?.url ? { image: template.image } : {}),
        },
        {
          applyTitle: template.applyTitle,
          applyDescription: template.applyDescription,
          applyFields: template.applyFields,
          applyFooter: template.applyFooter,
          applyThumbnail: template.applyThumbnail === true,
          applyImage: template.applyImage === true,
        },
      );

      if (saved) migratedAliases += aliases.length;
    }
  }

  if (migratedAliases > 0) {
    logger.warn(`[EMBED_BUILDER] Migrated ${migratedAliases} saved catalog template alias(es) to their live channel scopes.`);
  }
}

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    const timer = setTimeout(async () => {
      await ensureSystemEmbedCatalogs(client).catch(error => {
        logger.warn(`System embed catalog setup failed: ${error.message}`);
      });

      await migrateCatalogTemplateScopes(client).catch(error => {
        logger.warn(`Saved catalog template migration failed: ${error.message}`);
      });
    }, 3500);

    timer.unref?.();
  },
};
