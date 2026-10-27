// Explicit opt-in repair for already posted bot-authored economy/gambling embeds.
// Dry run is the default. Only the exact channels supplied via --channel-ids
// can be scanned or updated. Never runs on Cloudy startup or deploy.
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { writeFile } from 'node:fs/promises';
import { GAMBLING_GAME_COMMANDS } from '../src/config/gamblingCommands.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from '../src/services/cloudyBrandingService.js';
import { normalizeEconomyEmbed } from '../src/utils/economyGamblingPresentation.js';

const flag = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3) || '';
const guildId = flag('guild-id');
const channelIds = [...new Set(flag('channel-ids').split(',').map(x => x.trim()).filter(Boolean))];
const approved = flag('apply') === 'I_APPROVE';
const maxMessages = Math.min(50_000, Math.max(1, Number.parseInt(flag('max') || '10000', 10) || 10000));
const activeNames = new Set([...GAMBLING_GAME_COMMANDS.map(x => x.name), 'gamble', 'game', 'economy']);

// This is intentionally a whitelist, not generic 'success', 'error', 'bank',
// or a message's location alone: those could be unrelated owner-created embeds.
const IDENTIFIED_ECONOMY_TITLE =
  /^(?:[^\n]{1,50}'s balance|balance|economy leaderboard|inventory|baccarat(?:\s|$)|blackjack(?:\s|$)|roulette(?:\s|$)|robbery(?:\s|$)|daily (?:reward|claimed)|work (?:complete|completed|successful|failed)|crime (?:successful|failed)|deposit (?:successful|failed)|withdraw(?:al)? (?:successful|failed)|cash added|payment (?:sent|received|successful|failed)|incoming payment|insufficient funds)\b/i;
const discordMediaUrl = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(?:ephemeral-)?attachments\//i;

function candidate(message) {
  if (!message?.embeds?.length || message.embeds.length > 10) return false;
  // Explicit saved Builder posts may be in these channels: never alter them.
  if (message.embeds.some(e => String(e.footer?.text || '').endsWith(MESSAGE_BUILDER_FOOTER_MARKER)
      || /^Cloudy template key:/i.test(String(e.author?.name || '')))) return false;
  const command = String(message.interaction?.commandName
    || message.interactionMetadata?.name || '').toLowerCase();
  if (command && !activeNames.has(command)) return false;
  return command ? activeNames.has(command)
    : message.embeds.every(e => IDENTIFIED_ECONOMY_TITLE.test(String(e.title || '').trim()));
}

function unsafeBanner(message) {
  // Editing Discord attachment-backed GIFs can make them detach above an
  // embed. Leave those messages alone for a separate media migration.
  if (message.attachments?.size) return true;
  return message.embeds.some(e => discordMediaUrl.test(String(e.image?.url || '')));
}

async function main() {
  if (!/^\d{17,20}$/.test(guildId) || !channelIds.length
      || channelIds.some(id => !/^\d{17,20}$/.test(id))) {
    throw new Error('Supply --guild-id=DISCORD_ID and --channel-ids=ID,ID. Dry run by default.');
  }
  const token = ['DISCORD_TOKEN', 'TOKEN', 'BOT_TOKEN', 'DISCORD_BOT_TOKEN']
    .map(key => process.env[key]?.trim()).find(Boolean);
  if (!token) throw new Error('Discord bot token not configured');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  try {
    const guild = await client.guilds.fetch(guildId);
    const changes = [];
    const stats = { scanned: 0, candidates: 0, unsafeMedia: 0, unchanged: 0, changed: 0 };
    for (const channelId of channelIds) {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.messages?.fetch || channel.guildId !== guildId) throw new Error('Invalid text channel: ' + channelId);
      let before;
      while (stats.scanned < maxMessages) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        for (const message of batch.values()) {
          if (stats.scanned >= maxMessages) break;
          stats.scanned += 1;
          if (message.author?.id !== client.user.id || !candidate(message)) continue;
          stats.candidates += 1;
          if (unsafeBanner(message)) { stats.unsafeMedia += 1; continue; }
          const oldEmbeds = message.embeds.map(e => e.toJSON());
          const updatedEmbeds = message.embeds.map(normalizeEconomyEmbed);
          if (JSON.stringify(oldEmbeds) === JSON.stringify(updatedEmbeds)) {
            stats.unchanged += 1;
            continue;
          }
          changes.push({
            guildId, channelId, messageId: message.id,
            oldEmbeds, updatedEmbeds,
          });
          stats.changed += 1;
        }
        before = batch.last()?.id;
        if (batch.size < 100 || !before) break;
      }
    }

    console.log(JSON.stringify({
      mode: approved ? 'apply' : 'dry-run',
      ...stats,
      preview: changes.slice(0, 15).map(x => ({
        channelId: x.channelId, messageId: x.messageId,
        before: x.oldEmbeds.map(e => ({ title: e.title, color: e.color, logo: Boolean(e.thumbnail?.url) })),
        after: x.updatedEmbeds.map(e => ({ title: e.title, color: e.color, logo: Boolean(e.thumbnail?.url) })),
      })),
    }, null, 2));
    if (!approved) {
      console.log('No changes made. Review this preview before running with --apply=I_APPROVE.');
      return;
    }

    // Keep complete before/after data for rollback before the first mutation.
    const backupPath = '/tmp/cloudy-economy-embed-backup-' + guildId + '-' + Date.now() + '.json';
    await writeFile(backupPath, JSON.stringify(changes, null, 2), { mode: 0o600 });
    console.log('Backup written: ' + backupPath);
    let updated = 0;
    for (const item of changes) {
      const channel = await guild.channels.fetch(item.channelId);
      const message = await channel.messages.fetch({ message: item.messageId, force: true });
      // A preview may be stale. Never overwrite an embed changed since scan.
      if (message.author?.id !== client.user.id || !candidate(message)
          || unsafeBanner(message)
          || JSON.stringify(message.embeds.map(e => e.toJSON())) !== JSON.stringify(item.oldEmbeds)) {
        console.log('Skipped modified message: ' + item.messageId);
        continue;
      }
      const edited = await message.edit({ embeds: item.updatedEmbeds });
      if (edited.id !== item.messageId) throw new Error('Message identity changed: ' + item.messageId);
      updated += 1;
    }
    console.log('Updated in place: ' + updated + ' messages. New posts: 0.');
  } finally {
    await client.destroy();
  }
}

main().catch(error => {
  console.error('Historical economy embed normalization failed:', error);
  process.exitCode = 1;
});
