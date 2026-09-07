import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { saveEmbedTemplateDecoration } from '../src/services/embedTemplateService.js';

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.GUILD_ID;
if (!token || !guildId) process.exit(1);

const BLANK = String.fromCharCode(10240);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function normalizeIndent(value) {
  if (!value) return value;
  return String(value).split('\n').map(line => {
    let index = 0;
    let count = 0;
    while (index < line.length) {
      const code = line.charCodeAt(index);
      const next = line.charCodeAt(index + 1);
      if (code === 10240) { count += 1; index += 1; continue; }
      if (code === 8291 && (next === 8194 || next === 8201)) { count += 1; index += 2; continue; }
      if (code === 8194 || code === 8201 || code === 32) { count += 1; index += 1; continue; }
      break;
    }
    return count ? BLANK.repeat(count) + line.slice(index) : line;
  }).join('\n');
}

client.once('ready', async () => {
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    const channel = guild.channels.cache.find(ch => String(ch?.name || '').includes('zorp-off-raid-protection') && ch?.messages?.fetch);
    if (!channel) throw new Error('ZORP channel not found');

    const messages = await channel.messages.fetch({ limit: 50 });
    const target = messages.find(message => message.author?.id === client.user.id && message.embeds?.some(embed => /ZORP Guide/i.test(embed.title || '')));
    if (!target) throw new Error('ZORP Guide embed not found');

    const index = target.embeds.findIndex(embed => /ZORP Guide/i.test(embed.title || ''));
    const current = target.embeds[index].toJSON();
    const normalized = {
      ...current,
      description: normalizeIndent(current.description),
      fields: (current.fields || []).map(field => ({ ...field, value: normalizeIndent(field.value) })),
    };

    const embeds = target.embeds.map((embed, i) => i === index ? new EmbedBuilder(normalized) : new EmbedBuilder(embed.toJSON()));
    await target.edit({ embeds });

    const aliases = [current.title || 'ZORP Guide', 'ZORP Guide'];
    const saved = await saveEmbedTemplateDecoration(guild.id, channel.id, aliases, normalized, {
      applyFields: true,
      applyThumbnail: true,
      applyImage: true,
    });
    if (!saved) throw new Error('Template persistence failed');

    console.log(`[ZORP_CROSS_PLATFORM_INDENT] OK message=${target.id} channel=${channel.id}`);
  } catch (error) {
    console.error('[ZORP_CROSS_PLATFORM_INDENT] Failed:', error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

await client.login(token);
