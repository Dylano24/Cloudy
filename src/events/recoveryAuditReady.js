import { Events } from 'discord.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

function compact(value, max = 90) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function summarizeTemplates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([alias, template]) => ({
    alias: compact(alias, 90),
    title: compact(template?.title || '', 90),
    color: Number.isInteger(template?.color) ? template.color : null,
    footer: compact(template?.footer?.text || '', 70),
    thumb: compact(template?.thumbnail?.url || '', 55),
    applyThumbnail: template?.applyThumbnail === true,
    updatedAt: template?.updatedAt || null,
  }));
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(() => {
      void (async () => {
        const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
        try {
          const entries = await readdir(backupDir, { withFileTypes: true });
          const dumps = entries.filter(entry => entry.isFile() && entry.name.endsWith('.dump')).map(entry => entry.name).sort();
          console.log(`[RECOVERY_AUDIT] backups dir=${backupDir} dumps=${dumps.join(',') || 'NONE'}`);
        } catch (error) {
          console.log(`[RECOVERY_AUDIT] backups dir=${backupDir} error=${error?.code || error?.message || 'unknown'}`);
        }

        const templateKeys = await client.db?.list?.('cloudy:embed-template:').catch(() => []) || [];
        console.log(`[RECOVERY_AUDIT] templateKeys=${JSON.stringify(templateKeys)}`);
        for (const key of templateKeys) {
          const value = await client.db.get(key, {}).catch(() => ({}));
          console.log(`[RECOVERY_AUDIT] template key=${key} entries=${JSON.stringify(summarizeTemplates(value))}`);
        }

        for (const guild of client.guilds.cache.values()) {
          const channels = await guild.channels.fetch().catch(() => null);
          if (!channels) continue;
          for (const channel of [...channels.values()].filter(item => item?.isTextBased?.() && item?.messages?.fetch)) {
            const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
            if (!messages) continue;
            const botMessages = [...messages.values()].filter(message => message.author?.id === client.user.id && message.embeds?.length);
            if (!botMessages.length) continue;
            const samples = botMessages.slice(0, 12).flatMap(message => message.embeds.slice(0, 2).map(embed => {
              const data = embed.toJSON?.() || embed;
              return {
                id: message.id,
                title: compact(data.title || '(no title)'),
                color: Number.isInteger(data.color) ? data.color : null,
                footer: compact(data.footer?.text || ''),
                thumb: compact(data.thumbnail?.url || '', 55),
                desc: compact(data.description || '', 75),
              };
            }));
            console.log(`[RECOVERY_AUDIT] channel=${channel.name} id=${channel.id} parent=${channel.parent?.name || ''} botEmbeds=${botMessages.length} samples=${JSON.stringify(samples)}`);
          }
        }
        console.log('[RECOVERY_AUDIT] complete');
      })().catch(error => console.error('[RECOVERY_AUDIT] failed', error));
    }, 5000);
    timer.unref?.();
  },
};
