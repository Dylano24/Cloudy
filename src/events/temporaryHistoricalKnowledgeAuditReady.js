import { Events } from 'discord.js';

const TARGETS = [
  ['informations', '1554538633783021659'],
  ['link-your-account', '1555121513806692404'],
  ['free-kits', '1555121524556570674'],
];

const TERM_RE = /(?:free[\s_-]*kits?|link[\s_-]*your[\s_-]*account|claim|purchase|subscription|cloudy inc\. website)/i;

function safeJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}

function compactEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : embed;
  return {
    title: data?.title || null,
    description: data?.description || null,
    fields: Array.isArray(data?.fields) ? data.fields.map(field => ({
      name: field.name,
      value: field.value,
      inline: Boolean(field.inline),
    })) : [],
    footer: data?.footer?.text || null,
    image: data?.image?.url || null,
    thumbnail: data?.thumbnail?.url || null,
    url: data?.url || null,
  };
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      try {
        for (const [name, channelId] of TARGETS) {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          const fetched = channel?.messages?.fetch
            ? await channel.messages.fetch({ limit: 100, cache: false }).catch(() => null)
            : null;
          const messages = [...(fetched?.values?.() || [])]
            .filter(message => message.author?.id === client.user?.id)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map(message => ({
              id: message.id,
              createdAt: message.createdAt?.toISOString?.() || null,
              content: message.content || '',
              embeds: (message.embeds || []).map(compactEmbed),
              components: (message.components || []).map(row => row.toJSON?.() || row),
            }));
          console.log('[KNOWLEDGE_CHANNEL]', safeJson({
            name,
            channelId,
            channelName: channel?.name || null,
            topic: channel?.topic || null,
            messages,
          }));
        }

        if (client.db?.list && client.db?.get) {
          const templateKeys = await client.db.list('cloudy:embed-template:').catch(() => []);
          for (const key of templateKeys || []) {
            const value = await client.db.get(key, {}).catch(() => ({}));
            for (const [alias, template] of Object.entries(value || {})) {
              const encoded = safeJson({ alias, template });
              if (!TERM_RE.test(encoded)) continue;
              console.log('[KNOWLEDGE_TEMPLATE]', safeJson({ key, alias, template }));
            }
          }

          const registryKeys = await client.db.list('cloudy:embed-registry:').catch(() => []);
          for (const key of registryKeys || []) {
            const value = await client.db.get(key, []).catch(() => []);
            const matches = (Array.isArray(value) ? value : []).filter(record =>
              TERM_RE.test(safeJson({ title: record?.title, name: record?.name }))
            );
            if (matches.length) {
              console.log('[KNOWLEDGE_REGISTRY]', safeJson({ key, matches }));
            }
          }
        }

        for (const guild of client.guilds.cache.values()) {
          const commands = await guild.commands.fetch().catch(() => null);
          const relevant = [...(commands?.values?.() || [])]
            .map(command => command.toJSON?.() || command)
            .filter(command => /(?:free|kit|claim|link|account|rust|purchase)/i.test(safeJson(command)))
            .map(command => ({
              name: command.name,
              description: command.description,
              options: command.options || [],
            }));
          console.log('[KNOWLEDGE_COMMANDS]', safeJson({ guildId: guild.id, commands: relevant }));
        }
      } catch (error) {
        console.error('[KNOWLEDGE_AUDIT_ERROR]', error?.stack || error);
      }
    }, 8000);
    timer.unref?.();
  },
};
