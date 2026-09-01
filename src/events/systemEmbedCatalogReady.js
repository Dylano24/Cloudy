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

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameSavedTemplate(left, right) {
  if (!left || !right) return false;
  return left === right
    || (
      normalize(left.title) === normalize(right.title)
      && (left.updatedAt || '') === (right.updatedAt || '')
    );
}

function matchingTemplateGroups(sourceTemplates, snapshot) {
  const groups = [];
  const seenTemplates = [];
  const snapshotTitle = normalize(snapshot?.title);

  for (const [alias, template] of Object.entries(sourceTemplates || {})) {
    if (!template || typeof template !== 'object') continue;
    if (snapshotTitle && normalize(template.title) !== snapshotTitle) continue;

    let groupIndex = seenTemplates.findIndex(existing => sameSavedTemplate(existing, template));
    if (groupIndex === -1) {
      groupIndex = seenTemplates.length;
      seenTemplates.push(template);
      groups.push({ template, aliases: [] });
    }
    groups[groupIndex].aliases.push(alias);
  }

  return groups;
}

function templateEmbedData(template) {
  return {
    ...(template.title != null ? { title: template.title } : {}),
    ...(template.description != null ? { description: template.description } : {}),
    ...(Array.isArray(template.fields) ? { fields: template.fields } : {}),
    ...(Number.isInteger(template.color) ? { color: template.color } : {}),
    ...(template.footer?.text ? { footer: template.footer } : {}),
    ...(template.thumbnail?.url ? { thumbnail: template.thumbnail } : {}),
    ...(template.image?.url ? { image: template.image } : {}),
  };
}

async function migrateCatalogTemplateScopes(client) {
  let migratedTemplates = 0;
  let migratedAliases = 0;

  for (const guild of client.guilds.cache.values()) {
    const records = await getEmbedRegistry(guild.id);
    const catalogRecords = records.filter(record =>
      record.source === 'system-catalog'
      && record.backingChannelId
      && String(record.backingChannelId) !== String(record.channelId),
    );

    const sourceTemplateCache = new Map();
    const migrated = new Set();

    for (const record of catalogRecords) {
      const physicalChannelId = String(record.backingChannelId);
      const liveChannelId = String(record.channelId);
      const snapshot = getEmbedRegistrySnapshot(record);
      if (!snapshot?.title) continue;

      const sourceKey = templateStorageKey(guild.id, physicalChannelId);
      let sourceTemplates = sourceTemplateCache.get(sourceKey);
      if (!sourceTemplates) {
        const stored = await getFromDb(sourceKey, {});
        sourceTemplates = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        sourceTemplateCache.set(sourceKey, sourceTemplates);
      }

      // The old Builder bug saved virtual catalog edits under the physical
      // backing channel. Match the saved template by its edited visible title,
      // then copy every alias that points at that same template. This preserves
      // the original dynamic alias (for example "Blackjack — Bet {dynamic}")
      // even when the administrator renamed the visible title in the Builder.
      const groups = matchingTemplateGroups(sourceTemplates, snapshot);
      for (const group of groups) {
        const uniqueAliases = [...new Set([
          ...group.aliases,
          record.title,
          record.name,
          snapshot.title,
        ].filter(Boolean))];
        if (!uniqueAliases.length) continue;

        const migrationKey = `${liveChannelId}:${normalize(group.template.title)}:${group.template.updatedAt || ''}`;
        if (migrated.has(migrationKey)) continue;
        migrated.add(migrationKey);

        const saved = await saveEmbedTemplateDecoration(
          guild.id,
          liveChannelId,
          uniqueAliases,
          templateEmbedData(group.template),
          {
            applyTitle: group.template.applyTitle,
            applyDescription: group.template.applyDescription,
            applyFields: group.template.applyFields,
            applyFooter: group.template.applyFooter,
            applyThumbnail: group.template.applyThumbnail === true,
            applyImage: group.template.applyImage === true,
          },
        );

        if (saved) {
          migratedTemplates += 1;
          migratedAliases += uniqueAliases.length;
        }
      }
    }
  }

  logger.warn(`[EMBED_BUILDER] Catalog scope migration complete: ${migratedTemplates} template(s), ${migratedAliases} alias(es) copied to live feature channels.`);
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
