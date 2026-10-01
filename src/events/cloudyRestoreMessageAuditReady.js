import { Events } from 'discord.js';

const checks = [
  { key: 'terms', slug: 'terms-of-services', title: /Terms of service$/i },
  { key: 'termsOfSale', slug: 'terms-of-sale', title: /Store terms of sale$/i },
  { key: 'faq', slug: 'faq', customId: 'faq_ai_question' },
  { key: 'zorp', slug: 'zorp-off-raid-protection', title: /ZORP Guide$/i },
  { key: 'security', slug: 'security-information', title: /^Security information$/i },
  { key: 'staffList', slug: 'staff-team', title: /^Staff team$/i },
  { key: 'appeal', slug: 'appeal-form', title: /^Appeal form$/i },
  { key: 'staffReviews', slug: 'staff-reviews', customId: 'staff_review_member' },
  { key: 'fixGuide', slug: 'staff-assistant', customId: 'cloudy_fix_guide_ask' },
  { key: 'shop', slug: 'shop', title: /^Shop commands$/i },
  { key: 'gambling', slug: 'gambling', title: /^Gambling & Games$/i },
  { key: 'contactSupport', slug: 'contact-us', customId: 'create_ticket' },
];

function normalize(value = '') {
  const raw = String(value).toLowerCase();
  const tail = raw.includes('│') ? raw.split('│').at(-1) : raw;
  return tail.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function hasCustomId(message, customId) {
  return message.components?.some(row =>
    row.components?.some(component => component.customId === customId)
  );
}

function matchesCheck(message, check, botId) {
  if (message.author?.id !== botId) return false;
  if (check.customId && hasCustomId(message, check.customId)) return true;
  return Boolean(check.title && message.embeds?.some(embed => check.title.test(String(embed.title || ''))));
}

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    const timer = setTimeout(async () => {
      const guild = client.guilds.cache.get(String(process.env.GUILD_ID || ''))
        || client.guilds.cache.first();
      if (!guild) {
        console.log('[CLOUDY_MESSAGE_AUDIT]', JSON.stringify({ ok: false, reason: 'guild_missing' }));
        return;
      }

      for (const check of checks) {
        const channel = [...guild.channels.cache.values()].find(c =>
          c?.messages?.fetch && normalize(c.name) === check.slug
        );
        if (!channel) {
          console.log('[CLOUDY_MESSAGE_AUDIT]', JSON.stringify({ key: check.key, ok: false, reason: 'channel_missing' }));
          continue;
        }

        const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
        if (!recent) {
          console.log('[CLOUDY_MESSAGE_AUDIT]', JSON.stringify({ key: check.key, channelId: channel.id, name: channel.name, ok: false, reason: 'history_unavailable' }));
          continue;
        }

        const match = recent.find(message => matchesCheck(message, check, client.user.id)) || null;
        console.log('[CLOUDY_MESSAGE_AUDIT]', JSON.stringify({
          key: check.key,
          channelId: channel.id,
          name: channel.name,
          ok: Boolean(match),
          messageId: match?.id || null,
          recentCount: recent.size,
        }));
      }
    }, 45_000);
    timer.unref?.();
  },
};
