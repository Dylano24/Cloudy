import { Events } from 'discord.js';

const TARGETS = [
  ['informations', '1554538633783021659'],
  ['link-your-account', '1555121513806692404'],
  ['free-kits', '1555121524556570674'],
];

function compactEmbed(embed) {
  const data = embed?.toJSON ? embed.toJSON() : embed;
  if (!data) return null;
  return {
    title: data.title || null,
    description: data.description || null,
    fields: Array.isArray(data.fields) ? data.fields.map(field => ({
      name: field.name,
      value: field.value,
      inline: Boolean(field.inline),
    })) : [],
    footer: data.footer?.text || null,
    image: data.image?.url || null,
    thumbnail: data.thumbnail?.url || null,
    url: data.url || null,
  };
}

function compactComponents(rows = []) {
  return rows.map(row => ({
    components: (row.components || []).map(component => ({
      type: component.type,
      customId: component.customId || null,
      label: component.label || null,
      style: component.style || null,
      url: component.url || null,
      emoji: component.emoji?.name || component.emoji?.id || null,
    })),
  }));
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      for (const [name, channelId] of TARGETS) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.messages?.fetch) {
          console.log('[KNOWLEDGE_AUDIT]', JSON.stringify({ name, channelId, error: 'unavailable' }));
          continue;
        }

        const fetched = await channel.messages.fetch({ limit: 100, cache: false }).catch(() => null);
        const messages = [...(fetched?.values?.() || [])]
          .filter(message => message.author?.id === client.user?.id)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map(message => ({
            id: message.id,
            createdAt: message.createdAt?.toISOString?.() || null,
            editedAt: message.editedAt?.toISOString?.() || null,
            content: message.content || '',
            embeds: (message.embeds || []).map(compactEmbed),
            components: compactComponents(message.components || []),
          }));

        console.log('[KNOWLEDGE_AUDIT]', JSON.stringify({
          name,
          channelId,
          channelName: channel.name || null,
          topic: channel.topic || null,
          messages,
        }));
      }
    }, 8000);

    timer.unref?.();
  },
};
