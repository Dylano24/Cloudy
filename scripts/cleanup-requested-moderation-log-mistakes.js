import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const channelIds = ['1539375620885323826', '1539371111240831078', '1539259457404412036'];

if (!token) {
  console.log('[MODERATION_LOG_CLEANUP] skipped: no Discord token');
  process.exit(0);
}

const rest = new REST({ version: '10' }).setToken(token);
const bot = await rest.get(Routes.user('@me'));
let removed = 0;
let corrected = 0;

function sendableEmbed(embed) {
  const data = { ...embed };
  delete data.type;
  delete data.provider;
  delete data.video;
  return data;
}

for (const channelId of channelIds) {
  let before;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const messages = await rest.get(`${Routes.channelMessages(channelId)}?${query}`);

    for (const message of messages) {
      if (message.author?.id !== bot.id) continue;
      const title = String(message.embeds?.[0]?.title || '');

      if (/\bcase\s*#\d+/i.test(title)) {
        await rest.delete(Routes.channelMessage(channelId, message.id)).catch(() => null);
        removed += 1;
        continue;
      }

      const first = message.embeds?.[0];
      const visibleText = `${first?.description || ''}\n${(first?.fields || []).map(field => `${field.name}\n${field.value}`).join('\n')}`;
      const mislabeledTimeout = /un[-\s]?time[-\s]?out/i.test(title)
        && /timed[- ]?out by/i.test(visibleText)
        && /duration/i.test(visibleText);
      if (!mislabeledTimeout) continue;

      const embeds = message.embeds.map(sendableEmbed);
      embeds[0].title = /automatic protection|automod/i.test(visibleText) ? 'Automod timeout' : 'Timeout log';
      embeds[0].color = 0xA9AF00;
      await rest.patch(Routes.channelMessage(channelId, message.id), { body: { embeds } });
      corrected += 1;
    }

    before = messages.length === 100 ? messages.at(-1).id : null;
  } while (before);
}

console.log(`[MODERATION_LOG_CLEANUP] completed: removed=${removed}, corrected=${corrected}`);
