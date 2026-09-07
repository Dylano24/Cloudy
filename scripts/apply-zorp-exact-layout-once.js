import { REST, Routes } from 'discord.js';

const channelId = '1533212973034770462';
const token = process.env.DISCORD_TOKEN;

if (!token) process.exit(0);
const rest = new REST({ version: '10' }).setToken(token);
const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) });

for (const candidate of Array.isArray(messages) ? messages : []) {
  for (const [index, embed] of (Array.isArray(candidate?.embeds) ? candidate.embeds : []).entries()) {
    const all = [embed?.title || '', embed?.description || '', ...(embed?.fields || []).flatMap(f => [f?.name || '', f?.value || ''])].join('\n');
    if (!/zorp/i.test(all)) continue;
    console.log('[ZORP_STRUCTURE]', JSON.stringify({
      messageId: candidate.id,
      embedIndex: index,
      title: embed?.title || '',
      description: embed?.description || '',
      fields: (embed?.fields || []).map(f => ({ name: f?.name || '', value: f?.value || '' })),
    }));
    process.exit(0);
  }
}
console.error('[ZORP_STRUCTURE] No ZORP embed found');
