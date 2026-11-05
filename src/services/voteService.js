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
// Every number is a custom digit emoji (owner's choice).
const numberIcon = index => feedEmoji(`vote_${index + 1}`);
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

// A picture added to a vote (e.g. a map screenshot): downloaded from Discord and
// sent again with the vote as attachment://mapN.ext, so it never expires.
export async function downloadVotePicture(attachment, index, fetchImpl = fetch) {
  if (!String(attachment.contentType || '').startsWith('image/')) throw new Error(`Picture ${index} must be an image.`);
  if (attachment.size > MAX_PICTURE_BYTES) throw new Error(`Picture ${index} is larger than 10 MB.`);
  const response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Picture ${index} could not be downloaded.`);
  const extension = (String(attachment.name || '').match(/\.(png|jpe?g|gif|webp)$/i)?.[1] || 'png').toLowerCase();
  const name = `map${index}.${extension}`;
  return { image: `attachment://${name}`, file: { attachment: Buffer.from(await response.arrayBuffer()), name } };
}

// All map pictures share this URL so Discord shows them together in one embed.
export const GALLERY_URL = 'https://rustmaps.com';
const CLOUDY_MEDIA = /\/cloudy-embed-media\//;

// The picture of an option (owner's choice: opened inside Discord with a
// button, never shown as a website link). Votes from before this kept the
// picture as a link; those Cloudy media links count as pictures too.
export function optionPicture(vote, index) {
  if (vote.optionImages?.[index]) return vote.optionImages[index];
  const link = vote.optionLinks?.[index];
  return link && CLOUDY_MEDIA.test(link) ? link : null;
}
// Six pieces keep the bar, percentage and count on one line next to the logo.
const BAR_LENGTH = 6;

const votesKey = guildId => `guild:${guildId}:votes`;
const unix = ms => Math.floor(ms / 1000);

export function voteCounts(vote) {
  const counts = vote.options.map(() => 0);
  for (const index of Object.values(vote.votes || {})) {
    if (Number.isInteger(index) && index >= 0 && index < counts.length) counts[index] += 1;
  }
  return counts;
}

// A green progress bar made of custom emoji pieces (rounded ends).
function bar(share, length) {
  const filled = Math.round(share * length);
  return Array.from({ length }, (_, index) => {
    const end = index === 0 ? 'l' : index === length - 1 ? 'r' : 'm';
    return feedEmoji(`bar_${end}${index < filled ? 'f' : 'e'}`);
  }).join('');
}

export function buildVoteMessage(vote, now = Date.now()) {
  const counts = voteCounts(vote);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const ended = vote.ended === true || (vote.endsAt && vote.endsAt <= now);
  const lines = [`**${vote.question}**`, ''];
  const length = BAR_LENGTH;
  vote.options.forEach((option, index) => {
    // Every vote is 1% (owner's choice), up to 100%.
    const share = Math.min(100, counts[index]) / 100;
    // An option with a picture stays plain text (its picture is behind a
    // button); other links (rustmaps.com pages of /mapvote) stay links.
    const link = optionPicture(vote, index) ? null : vote.optionLinks?.[index];
    const label = link && !CLOUDY_MEDIA.test(link) ? `[${option}](${link})` : option;
    lines.push(`${numberIcon(index)} **${label}**${vote.optionNotes?.[index] ? ` · ${vote.optionNotes[index]}` : ''}`);
    lines.push(`${bar(share, length)} **${Math.round(share * 100)}%** · ${counts[index]} ${counts[index] === 1 ? 'vote' : 'votes'}`);
  });
  lines.push('', `**Total votes:** ${total}`);
  if (ended) {
    const best = Math.max(0, ...counts);
    const winners = total ? vote.options.filter((_, index) => counts[index] === best) : [];
    // An empty line between the total and the end (owner's choice).
    lines.push('', `**${winners.length > 1 ? 'Tie' : 'Winner'}:** ${winners.length ? winners.join(', ') : 'No votes'}`);
    lines.push(`**Ended:** <t:${unix(vote.endedAt || vote.endsAt || now)}:f>`);
  } else if (vote.endsAt) {
    lines.push('', `**Ends:** <t:${unix(vote.endsAt)}:f> (<t:${unix(vote.endsAt)}:R>)`);
  }
  // Buttons show only the number badge (owner's choice); the embed names the option.
  const buttons = vote.options.map((option, index) => new ButtonBuilder()
    .setCustomId(`vote_cast:${index}`)
    .setEmoji(numberIcon(index))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(ended)));
  const rows = [];
  for (let start = 0; start < buttons.length; start += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(start, start + 5)));
  }
  // Options with a picture get a grey button with their name: it shows the
  // picture privately for 30 seconds (owner's choice; a link cannot do that).
  const pictureButtons = vote.options.map((option, index) => (optionPicture(vote, index)
    ? new ButtonBuilder().setCustomId(`vote_media:${index}`).setEmoji('🖼️').setLabel(option.slice(0, 80)).setStyle(ButtonStyle.Secondary)
    : null)).filter(Boolean);
  for (let start = 0; start < pictureButtons.length && rows.length < 5; start += 5) {
    rows.push(new ActionRowBuilder().addComponents(pictureButtons.slice(start, start + 5)));
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
  // One picture is simply the embed's picture; several share the gallery URL.
  if (images.length) Object.assign(main, { image: { url: images[0] }, ...(images.length > 1 ? { url: GALLERY_URL } : {}) });
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
