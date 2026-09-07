import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
const channels = ['1539375620885323826', '1539371111240831078'];
const requestedColor = 0xFCFFA1;

if (!token) process.exit(0);
const rest = new REST({ version: '10' }).setToken(token);
const bot = await rest.get(Routes.user('@me'));
let checked = 0;
let updated = 0;

function isKickOrTimeout(title = '') {
  const value = String(title).toLowerCase();
  if (/un[-\s]?time[-\s]?out|untimeout/.test(value)) return false;
  return /kick|time[-\s]?out|timeout/.test(value);
}

for (const channelId of channels) {
  let before;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (before) query.set('before', before);
    const messages = await rest.get(`${Routes.channelMessages(channelId)}?${query}`);

    for (const message of messages) {
      if (message.author?.id !== bot.id || !message.embeds?.length) continue;
      checked += 1;
      let changed = false;
      const embeds = message.embeds.map(raw => {
        const embed = { ...raw };
        delete embed.type;
        delete embed.provider;
        delete embed.video;
        if (isKickOrTimeout(embed.title) && embed.color !== requestedColor) {
          embed.color = requestedColor;
          changed = true;
        }
        return embed;
      });
      if (!changed) continue;
      await rest.patch(Routes.channelMessage(channelId, message.id), { body: { embeds } });
      updated += 1;
    }

    before = messages.length === 100 ? messages.at(-1).id : null;
  } while (before);
}

console.log(`[KICK_TIMEOUT_COLOR_ONCE] complete: checked=${checked} updated=${updated}`);
