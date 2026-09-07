import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const channelIds = [
  '1539375620885323826', '1539371111240831078', '1539259457404412036',
  '1539371572442435646', '1539372511089926244',
];
const logo = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';

if (!token) process.exit(0);
const rest = new REST({ version: '10' }).setToken(token);
const bot = await rest.get(Routes.user('@me'));
let updated = 0;

function colorFor(title = '') {
  const value = String(title).toLowerCase();
  if (/invite created/.test(value)) return 0xFFFFFF;
  if (/joined using invite/.test(value)) return 0x00C49D;
  if (/un[-\s]?time[-\s]?out|untimeout|unban/.test(value)) return 0x00C49D;
  if (/time[-\s]?out|timeout|kick/.test(value)) return 0xA9AF00;
  return null;
}

for (const channelId of channelIds) {
  let before;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const messages = await rest.get(`${Routes.channelMessages(channelId)}?${query}`);
    for (const message of messages) {
      if (message.author?.id !== bot.id || !message.embeds?.length) continue;
      let changed = false;
      const embeds = message.embeds.map(raw => {
        const embed = { ...raw };
        delete embed.type; delete embed.provider; delete embed.video;
        const color = colorFor(embed.title);
        if (color !== null && embed.color !== color) { embed.color = color; changed = true; }
        if (embed.thumbnail?.url !== logo) { embed.thumbnail = { url: logo }; changed = true; }
        return embed;
      });
      if (changed) {
        await rest.patch(Routes.channelMessage(channelId, message.id), { body: { embeds } });
        updated += 1;
      }
    }
    before = messages.length === 100 ? messages.at(-1).id : null;
  } while (before);
}
console.log(`[NON_TICKET_LOG_PRESENTATION_ONCE] updated=${updated}`);
