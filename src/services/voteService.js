// /vote (owner's choice, was /poll): a vote with one button per option,
// live counts in the embed and one vote per member (they can change or remove
// it). Who voted for what is never shown, only the counts.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Mutex } from '../utils/mutex.js';
import { unwrapReplitData } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { feedEmoji } from './feedEmojiService.js';

export const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
export const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
export const VOTE_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const MAX_VOTE_OPTIONS = 10;
// Numbers 1 to 3 are flashy custom emojis; the rest keep the keycaps.
const numberIcon = index => (index < 3 ? feedEmoji(`vote_${index + 1}`) : VOTE_NUMBERS[index]);
// All map pictures share this URL so Discord shows them together in one embed.
export const GALLERY_URL = 'https://rustmaps.com';
const BAR_LENGTH = 10;

const votesKey = guildId => `guild:${guildId}:votes`;
const unix = ms => Math.floor(ms / 1000);

export function voteCounts(vote) {
  const counts = vote.options.map(() => 0);
  for (const index of Object.values(vote.votes || {})) {
    if (Number.isInteger(index) && index >= 0 && index < counts.length) counts[index] += 1;
  }
  return counts;
}

function bar(share) {
  const filled = Math.round(share * BAR_LENGTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_LENGTH - filled);
}

export function buildVoteMessage(vote, now = Date.now()) {
  const counts = voteCounts(vote);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const ended = vote.ended === true || (vote.endsAt && vote.endsAt <= now);
  const lines = [`**${vote.question}**`, ''];
  vote.options.forEach((option, index) => {
    const share = total ? counts[index] / total : 0;
    lines.push(`${numberIcon(index)} ${vote.optionLinks?.[index] ? `[${option}](${vote.optionLinks[index]})` : option}`);
    if (vote.optionNotes?.[index]) lines.push(vote.optionNotes[index]);
    lines.push(`\`${bar(share)}\` ${Math.round(share * 100)}% · ${counts[index]} ${counts[index] === 1 ? 'vote' : 'votes'}`);
  });
  lines.push('', `**Total votes:** ${total}`);
  if (ended) {
    const best = Math.max(0, ...counts);
    const winners = total ? vote.options.filter((_, index) => counts[index] === best) : [];
    lines.push(`**${winners.length > 1 ? 'Tie' : 'Winner'}:** ${winners.length ? winners.join(', ') : 'No votes'}`);
    lines.push(`**Ended:** <t:${unix(vote.endedAt || vote.endsAt || now)}:f>`);
  } else if (vote.endsAt) {
    lines.push(`**Ends:** <t:${unix(vote.endsAt)}:f> (<t:${unix(vote.endsAt)}:R>)`);
  }
  const buttons = vote.options.map((option, index) => new ButtonBuilder()
    .setCustomId(`vote_cast:${index}`)
    .setEmoji(numberIcon(index))
    .setLabel(option.slice(0, 80))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(ended)));
  const rows = [];
  for (let start = 0; start < buttons.length; start += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(start, start + 5)));
  }
  const images = (vote.images || []).slice(0, 4);
  const main = {
    title: ended ? `${vote.title || 'Vote'} ended` : (vote.title || 'Vote'),
    description: lines.join('\n').slice(0, 4096),
    color: 0xFFFFFF,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  };
  // Pictures: embeds with the same URL are shown as one embed with small
  // pictures side by side; a click opens a picture in full size.
  if (images.length) Object.assign(main, { url: GALLERY_URL, image: { url: images[0] } });
  return {
    embeds: [main, ...images.slice(1).map(image => ({ url: GALLERY_URL, image: { url: image } }))],
    components: rows,
    allowedMentions: { parse: [] },
  };
}

async function readVotes(client, guildId) {
  const raw = unwrapReplitData(await client.db.get(votesKey(guildId), {}));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

async function writeVotes(client, guildId, votes) {
  if (await client.db.set(votesKey(guildId), votes) === false) throw new Error('Could not save the vote');
}

export async function saveVote(client, guildId, vote) {
  return Mutex.runExclusive(votesKey(guildId), async () => {
    const votes = await readVotes(client, guildId);
    votes[vote.messageId] = vote;
    await writeVotes(client, guildId, votes);
    return vote;
  });
}

export async function loadVote(client, guildId, messageId) {
  return (await readVotes(client, guildId))[messageId] || null;
}

// One vote per member: a new option replaces the old one; the same option
// again removes it. Returns { status, vote, option }.
export async function castVote(client, guildId, messageId, userId, index) {
  return Mutex.runExclusive(votesKey(guildId), async () => {
    const votes = await readVotes(client, guildId);
    const vote = votes[messageId];
    if (!vote) return { status: 'missing' };
    if (vote.ended || (vote.endsAt && vote.endsAt <= Date.now())) return { status: 'ended', vote };
    if (!Number.isInteger(index) || index < 0 || index >= vote.options.length) return { status: 'invalid', vote };
    const current = vote.votes?.[userId];
    const next = { ...(vote.votes || {}) };
    let status;
    if (current === index) {
      delete next[userId];
      status = 'removed';
    } else {
      next[userId] = index;
      status = current === undefined ? 'voted' : 'changed';
    }
    const updated = { ...vote, votes: next };
    votes[messageId] = updated;
    await writeVotes(client, guildId, votes);
    return { status, vote: updated, option: vote.options[index] };
  });
}

// Runs every minute: closes votes whose end time has passed.
export async function endDueVotes(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    let due;
    try {
      due = await Mutex.runExclusive(votesKey(guild.id), async () => {
        const votes = await readVotes(client, guild.id);
        const now = Date.now();
        const ended = Object.values(votes).filter(vote => !vote.ended && vote.endsAt && vote.endsAt <= now);
        if (!ended.length) return [];
        for (const vote of ended) votes[vote.messageId] = { ...vote, ended: true, endedAt: vote.endsAt };
        await writeVotes(client, guild.id, votes);
        return ended.map(vote => votes[vote.messageId]);
      });
    } catch (error) {
      logger.warn(`Could not close votes in ${guild.id}:`, error);
      continue;
    }
    for (const vote of due) {
      const channel = guild.channels?.cache?.get?.(vote.channelId);
      const message = await channel?.messages?.fetch?.(vote.messageId).catch(() => null);
      if (message?.edit) await message.edit(buildVoteMessage(vote)).catch(error => logger.warn('Could not close vote message:', error));
    }
  }
}

let started = false;
export function startVoteTimer(client) {
  if (started) return;
  started = true;
  const timer = setInterval(() => { void endDueVotes(client).catch(() => {}); }, 60_000);
  timer.unref?.();
  void endDueVotes(client).catch(() => {});
}
