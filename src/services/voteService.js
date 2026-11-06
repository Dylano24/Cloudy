// /vote (owner's choice, was /poll): a vote with one button per option,
// live counts in the embed and one vote per member (they can change or remove
// it). Who voted for what is never shown, only the counts.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  MessageFlags, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder,
} from 'discord.js';
import { Mutex } from '../utils/mutex.js';
import { unwrapReplitData } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { rememberMessageDeleter } from './deletionAttributionService.js';
import { feedEmoji } from './feedEmojiService.js';
import { freshVotePictureLinks } from './voteMediaService.js';
import { votePreviewFile } from './votePreviewService.js';

export const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
export const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
// The card of a vote with pictures has no real footer: small text is always
// grey there. White and small (owner's choice) is a thin picture of the footer
// (assets/vote-footer.png), on a fixed link like the logo, so every edit keeps
// the same picture and nothing loads again.
export const VOTE_FOOTER_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@43d4c3420b7941344631efc0f6a8a2bb38528081/assets/vote-footer.png';
// The card's progress bar is a thin picture (owner's choice: white, rounded),
// like the footer: Discord's app loads custom emoji again every time it
// redraws the vote (each vote and each button press), which made emoji bars
// and digits flicker; a picture with the same link stays put. 21 pictures,
// 0 to 100% in steps of 5 (assets/vote-bars on a fixed jsDelivr link).
const VOTE_BAR_BASE = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@8dfb296dbb587e1155ceb164f4ac386366bbad21/assets/vote-bars';
const BAR_PICTURE_STEPS = 20;
export function voteBarPicture(share) {
  const step = Math.max(0, Math.min(BAR_PICTURE_STEPS, Math.round(share * BAR_PICTURE_STEPS)));
  return `${VOTE_BAR_BASE}/bar_${String(step).padStart(2, '0')}.png`;
}
export const VOTE_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const MAX_VOTE_OPTIONS = 10;
// Every number is a custom digit emoji (owner's choice).
const numberIcon = index => feedEmoji(`vote_${index + 1}`);
export const voteNumberIcon = numberIcon;
// The buttons carry a still copy of the badge (owner's choice): an animated
// emoji in a button sometimes stayed empty in Discord's app until the vote was
// redrawn. The choices and results keep the animated badges.
const buttonIcon = index => feedEmoji(`vote_${index + 1}_still`);

// All pictures of an older vote share this URL so Discord shows them together in one embed.
export const GALLERY_URL = 'https://rustmaps.com';
const CLOUDY_MEDIA = /\/cloudy-embed-media\//;

// The role tagged when the vote starts (owner's choice): shown above the vote.
function voteTag(vote) {
  if (!vote.tagRoleId) return null;
  return vote.tagRoleId === vote.guildId ? '@everyone' : `<@&${vote.tagRoleId}>`;
}

// Only the tagged role (or everyone) is pinged, and only when the vote is
// posted: Discord never pings again when the vote is edited.
function voteMentions(vote) {
  if (!vote.tagRoleId) return { parse: [] };
  if (vote.tagRoleId === vote.guildId) return { parse: ['everyone'] };
  return { parse: [], roles: [vote.tagRoleId] };
}

/** The picture an option's Preview button shows, or null. */
export function votePicture(vote, index) {
  if (vote.optionMedia) return vote.optionLinks?.[index] || null;
  return optionPicture(vote, index);
}

// The picture of an option on older votes (a Cloudy media link or an uploaded
// picture); such options show as plain text.
export function optionPicture(vote, index) {
  if (vote.optionImages?.[index]) return vote.optionImages[index];
  const link = vote.optionLinks?.[index];
  return link && CLOUDY_MEDIA.test(link) ? link : null;
}
// Six pieces keep the bar, percentage and count on one line next to the logo.
const BAR_LENGTH = 6;

const votesKey = guildId => `guild:${guildId}:votes`;
const unix = ms => Math.floor(ms / 1000);

/** The option indexes with the most votes (several on a tie, none without votes). */
export function mostVoted(vote) {
  const counts = voteCounts(vote);
  const best = Math.max(0, ...counts);
  return best ? counts.flatMap((count, index) => (count === best ? [index] : [])) : [];
}

export function voteCounts(vote) {
  const counts = vote.options.map(() => 0);
  for (const index of Object.values(vote.votes || {})) {
    if (Number.isInteger(index) && index >= 0 && index < counts.length) counts[index] += 1;
  }
  return counts;
}

// The progress bar (owner's choice): rounded custom emoji pieces, white when
// filled (was green), grey when open.
function bar(share, length) {
  const filled = Math.round(share * length);
  return Array.from({ length }, (_, index) => {
    const end = index === 0 ? 'l' : index === length - 1 ? 'r' : 'm';
    return feedEmoji(`bar_${end}${index < filled ? 'f' : 'e'}`);
  }).join('');
}

// The pieces of a vote, shared by both layouts.
function voteParts(vote, now) {
  const counts = voteCounts(vote);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const ended = vote.ended === true || (vote.endsAt && vote.endsAt <= now);
  const options = vote.options.map((option, index) => {
    // Every vote is 1% (owner's choice), up to 100%.
    const share = Math.min(100, counts[index]) / 100;
    // An option with a picture is a blue link that opens it (Discord's own
    // picture link); older /mapvote votes link to rustmaps.com. Votes from before this
    // (pictures behind buttons) show plain text.
    const link = optionPicture(vote, index) ? null : vote.optionLinks?.[index];
    const label = link && !CLOUDY_MEDIA.test(link) ? `[${option}](${link})` : option;
    return {
      line: `${numberIcon(index)} **${label}**${vote.optionNotes?.[index] ? ` · ${vote.optionNotes[index]}` : ''}`,
      // The card has a Preview button, so its option names are plain text (owner's choice).
      name: `${numberIcon(index)} **${option}**${vote.optionNotes?.[index] ? ` · ${vote.optionNotes[index]}` : ''}`,
      bar: `${bar(share, BAR_LENGTH)} **${Math.round(share * 100)}%** · ${counts[index]} ${counts[index] === 1 ? 'vote' : 'votes'}`,
      // The card uses no custom emoji at all (see VOTE_BAR_BASE): plain text.
      plain: `**${index + 1} · ${option}**${vote.optionNotes?.[index] ? ` · ${vote.optionNotes[index]}` : ''}\n**${Math.round(share * 100)}%** · ${counts[index]} ${counts[index] === 1 ? 'vote' : 'votes'}`,
      share,
      count: counts[index],
      // Whether the option has a picture (known at once; its link is stored a moment later).
      picture: vote.pictureOptions ? Boolean(vote.pictureOptions[index]) : Boolean(votePicture(vote, index)),
    };
  });
  const end = [];
  if (ended) {
    // The result (owner's choice): the option(s) with the most votes.
    const winners = mostVoted(vote).map(index => vote.options[index]);
    end.push(`**Most votes:** ${winners.length ? winners.join(', ') : 'No votes'}`);
    end.push(`**Ended:** <t:${unix(vote.endedAt || vote.endsAt || now)}:f>`);
  } else if (vote.endsAt) {
    // Only the date (owner's choice): a live countdown ("in an hour") made
    // Discord redraw the vote every minute, and the bars flickered with it.
    end.push(`**Ends:** <t:${unix(vote.endsAt)}:f>`);
  }
  // One button per option (owner's choice): its digit and its name. It only votes.
  const buttons = vote.options.map((option, index) => new ButtonBuilder()
    .setCustomId(`vote_cast:${index}`)
    .setEmoji(buttonIcon(index))
    .setLabel(option.slice(0, 80))
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(ended)));
  // Once the vote has ended its buttons are gone (owner's choice).
  const rows = [];
  for (let start = 0; !ended && start < buttons.length; start += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(start, start + 5)));
  }
  // "Vote started" while it runs, "Vote ended" after (owner's choice).
  // "Community vote started" / "Community vote ended" (owner's choice).
  const title = ended ? `${vote.title || 'Community vote'} ended` : (vote.title || 'Community vote started');
  return { total, options, end, rows, title, ended };
}

// A vote with pictures (owner's choice): a small "Preview" button right next
// to every option with a picture, which shows it privately (vote_media). Only
// Discord's newer message layout can put a button next to text, so these
// votes are a card (white side line, Cloudy logo and footer) instead of an embed.
// A little more room between sections (owner's choice): an empty separator.
const sectionGap = () => new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
// The title and the question with the Cloudy logo beside them (owner's choice),
// on "Vote started" and "Vote ended" alike.
const titleWithLogo = (title, question) => new SectionBuilder()
  .addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${title}`),
    new TextDisplayBuilder().setContent(`**Question**\n${question}`))
  .setThumbnailAccessory(new ThumbnailBuilder().setURL(CLOUDY_C_LOGO_URL));

function buildPreviewVoteMessage(vote, parts) {
  // The layout of a classic map poll (owner's choice): Question, Choices with
  // a number each (and a Preview button when the option has a picture), Ends,
  // Mode, the Cloudy footer; under it one button per option with its number
  // and its count. No bars. After the end the vote stays as it was, without
  // buttons; the result is a separate message under it (buildVoteResultMessage).
  const text = content => new TextDisplayBuilder().setContent(content);
  // A short how-to between Choices and Ends (owner's choice), like a classic map poll.
  const hasPreview = !parts.ended && parts.options.some(option => option.picture);
  // The bullets are Cloudy's white glowing dot (owner's choice), as in the feeds.
  const dot = feedEmoji('dot');
  const howTo = [
    `${dot} Press a number below to vote.`,
    // The owner's own words; one line on an iPhone SE/mini and larger.
    `${dot} Press any number to change your vote.`,
    ...(hasPreview ? [`${dot} Press **Preview** to see the pictures.`] : []),
  ];
  const card = new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addSectionComponents(titleWithLogo(vote.title || 'Community vote started', vote.question))
    .addSeparatorComponents(sectionGap());
  // Choices sit tight under their heading in one block, like Results (owner's
  // choice), with one Preview button beside them that shows every picture.
  const choices = text(['**Choices**', ...parts.options.map((_, index) => `${numberIcon(index)} **${vote.options[index]}**`)].join('\n'));
  if (hasPreview) {
    card.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(choices)
      .setButtonAccessory(new ButtonBuilder()
        .setCustomId('vote_media:all')
        .setLabel('Preview')
        .setStyle(ButtonStyle.Secondary)));
  } else {
    card.addTextDisplayComponents(choices);
  }
  // Question, Choices, then the how-to (owner's choice: no description).
  card.addSeparatorComponents(sectionGap())
    .addTextDisplayComponents(text(howTo.join('\n')))
    .addSeparatorComponents(sectionGap())
    // This heading literally (owner's choice), at the bottom.
    .addTextDisplayComponents(text(`**Vote ends**\n${vote.endsAt ? `<t:${unix(vote.endsAt)}:f>` : 'Never'}`))
    .addSeparatorComponents(sectionGap());
  card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder()
    .setURL(VOTE_FOOTER_URL)));
  const rows = [];
  if (!parts.ended) {
    const buttons = parts.options.map((option, index) => new ButtonBuilder()
      .setCustomId(`vote_cast:${index}`)
      .setEmoji(buttonIcon(index))
      .setLabel(String(option.count))
      .setStyle(ButtonStyle.Secondary));
    for (let start = 0; start < buttons.length; start += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(start, start + 5)));
  }
  const tag = voteTag(vote);
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [...(tag ? [text(tag)] : []), card, ...rows],
    allowedMentions: voteMentions(vote),
  };
}

/** The result of a card vote, sent under it when it ends (owner's choice: like a classic map poll result). */
export function buildVoteResultMessage(vote, pictureNames = []) {
  const text = content => new TextDisplayBuilder().setContent(content);
  const counts = voteCounts(vote);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const votes = count => `${count} ${count === 1 ? 'vote' : 'votes'}`;
  // Most votes first, with the real share of all votes.
  const order = vote.options.map((_, index) => index).sort((a, b) => counts[b] - counts[a] || a - b);
  const card = new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addSectionComponents(titleWithLogo(`${vote.title || 'Community vote'} ended`, vote.question));
  // Cloudy style (owner's choice): own number emoji, the option in bold, count and share.
  const line = index => `${numberIcon(index)} **${vote.options[index]}** · ${votes(counts[index])} · ${Math.round(total ? counts[index] / total * 100 : 0)}%`;
  const winners = mostVoted(vote);
  // Results first, then Most votes with the winner's picture (owner's choice).
  card.addSeparatorComponents(sectionGap())
    .addTextDisplayComponents(text(['**Results**', ...order.map(line)].join('\n')))
    .addSeparatorComponents(sectionGap())
    .addTextDisplayComponents(text(['**Most votes**', ...(winners.length ? winners.map(line) : ['No votes'])].join('\n')));
  if (pictureNames.length) {
    card.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...pictureNames.map(name => new MediaGalleryItemBuilder()
      .setURL(`attachment://${name}`))));
  }
  card.addSeparatorComponents(sectionGap())
    // These two headings literally (owner's choice).
    .addTextDisplayComponents(text(`**Total votes**\n${votes(total)}`))
    .addSeparatorComponents(sectionGap())
    .addTextDisplayComponents(text(`**Vote ended**\n<t:${unix(vote.endedAt || vote.endsAt || Date.now())}:f>`));
  card.addSeparatorComponents(sectionGap())
    .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(VOTE_FOOTER_URL)));
  // The role tagged on the vote is tagged on its result too (owner's choice).
  const tag = voteTag(vote);
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [...(tag ? [text(tag)] : []), card],
    allowedMentions: voteMentions(vote),
  };
}

export function buildVoteMessage(vote, now = Date.now()) {
  const parts = voteParts(vote, now);
  if (vote.layout === 'preview') return buildPreviewVoteMessage(vote, parts);
  const lines = [`**${vote.question}**`, '', ...parts.options.flatMap(option => [option.line, option.bar])];
  lines.push('', `**Total votes:** ${parts.total}`);
  // An empty line between the total and the end (owner's choice).
  if (parts.end.length) lines.push('', ...parts.end);

  const images = (vote.images || []).slice(0, 4);
  const main = {
    title: parts.title,
    description: lines.join('\n').slice(0, 4096),
    color: 0xFFFFFF,
    thumbnail: { url: CLOUDY_C_LOGO_URL },
    footer: { text: CLOUDY_FOOTER },
  };
  // Pictures: embeds with the same URL are shown as one embed with small
  // pictures side by side; a click opens a picture in full size.
  // One picture is simply the embed's picture; several share the gallery URL.
  if (images.length) Object.assign(main, { image: { url: images[0] }, ...(images.length > 1 ? { url: GALLERY_URL } : {}) });
  const tag = voteTag(vote);
  return {
    ...(tag ? { content: tag } : {}),
    embeds: [main, ...images.slice(1).map(image => ({ url: GALLERY_URL, image: { url: image } }))],
    components: parts.rows,
    allowedMentions: voteMentions(vote),
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

/** Stores where a vote's pictures are kept (uploaded right after the vote was posted). */
export async function setVotePictures(client, guildId, messageId, pictures) {
  return Mutex.runExclusive(votesKey(guildId), async () => {
    const votes = await readVotes(client, guildId);
    const vote = votes[messageId];
    if (!vote) return null;
    votes[messageId] = { ...vote, optionLinks: pictures.links, optionMedia: pictures.media, mediaRefreshedAt: Date.now() };
    await writeVotes(client, guildId, votes);
    return votes[messageId];
  });
}

// Discord's app sometimes leaves a custom emoji in a button empty when a vote
// first appears. One redraw 2 seconds after posting loads it again (owner's
// choice). The vote is read and redrawn under the votes lock, so a vote cast at
// that moment is never shown with old counts.
export const VOTE_REFRESH_MS = 2_000;
export function refreshVoteSoon(client, guildId, message, delay = VOTE_REFRESH_MS) {
  const timer = setTimeout(() => {
    void Mutex.runExclusive(votesKey(guildId), async () => {
      const vote = (await readVotes(client, guildId))[message.id];
      if (!vote || vote.ended) return;
      await message.edit(buildVoteMessage(vote));
    }).catch(error => logger.warn(`[VOTE] Could not redraw vote ${message.id}: ${error?.message || error}`));
  }, delay);
  timer.unref?.();
  return timer;
}

export async function loadVote(client, guildId, messageId) {
  return (await readVotes(client, guildId))[messageId] || null;
}

// One vote per member: a new option replaces the old one. The same option again
// keeps the vote (owner's choice: that button also shows the option's picture,
// so a second look must not remove the vote). Returns { status, vote, option }.
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
      return { status: 'unchanged', vote, option: vote.options[index] };
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
    for (const vote of due) await closeVoteMessage(client, guild, vote);
  }
}

// The vote stays as it was, without buttons (owner's choice); a card gets its
// result as its own message under it, with the winner's picture.
async function closeVoteMessage(client, guild, vote) {
  const channel = guild.channels?.cache?.get?.(vote.channelId);
  const message = await channel?.messages?.fetch?.(vote.messageId).catch(() => null);
  if (!message?.edit) return;
  await message.edit(buildVoteMessage(vote)).catch(error => logger.warn('Could not close vote message:', error));
  if (vote.layout !== 'preview') return;
  const files = await resultPictureFiles(client, vote).catch(() => []);
  const result = await message.reply({ ...buildVoteResultMessage(vote, files.map(file => file.name)), ...(files.length ? { files } : {}) })
    .catch(error => { logger.warn('Could not post the vote result:', error); return null; });
  if (result) await saveVote(client, guild.id, { ...vote, resultMessageId: result.id }).catch(() => {});
}

/** Whether a vote is still open (not ended and its time not passed). */
export function isVoteOpen(vote, now = Date.now()) {
  return Boolean(vote) && !vote.ended && !(vote.endsAt && vote.endsAt <= now);
}

/** Every vote of a server, newest first (/votemanage). */
export async function guildVotes(client, guildId) {
  const votes = await readVotes(client, guildId);
  return Object.values(votes)
    .filter(vote => /^\d{17,20}$/.test(String(vote?.messageId || '')))
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

/**
 * Forgets votes whose message is gone from Discord (deleted by hand, a purge
 * or with its channel), so /votemanage only lists votes that are still in a
 * channel (owner's choice). Returns the forgotten votes.
 */
export async function forgetDeletedVotes(client, guildId, { messageIds = [], channelId = null } = {}) {
  const ids = new Set(messageIds.map(String));
  if (!ids.size && !channelId) return [];
  return Mutex.runExclusive(votesKey(guildId), async () => {
    const votes = await readVotes(client, guildId);
    const gone = Object.values(votes)
      .filter(vote => ids.has(String(vote?.messageId)) || (channelId && vote?.channelId === channelId));
    if (!gone.length) return [];
    for (const vote of gone) delete votes[vote.messageId];
    await writeVotes(client, guildId, votes);
    return gone;
  });
}

/** Deletes a vote for good (/votemanage): its message, its result and what is stored. */
export async function deleteVote(client, guild, messageId, { deletedBy = null } = {}) {
  const vote = await Mutex.runExclusive(votesKey(guild.id), async () => {
    const votes = await readVotes(client, guild.id);
    const current = votes[messageId];
    if (!current) return null;
    delete votes[messageId];
    await writeVotes(client, guild.id, votes);
    return current;
  });
  if (!vote) return null;
  const channel = guild.channels?.cache?.get?.(vote.channelId);
  for (const id of [vote.messageId, vote.resultMessageId].filter(Boolean)) {
    const message = await channel?.messages?.fetch?.(id).catch(() => null);
    if (!message?.delete) continue;
    // The staff member who confirmed Delete is named in the logs.
    if (deletedBy) rememberMessageDeleter(message, deletedBy);
    await message.delete().catch(error => logger.warn(`Could not delete vote message ${id}: ${error?.message || error}`));
  }
  return vote;
}

/** Ends an open vote at once (/votemanage), exactly as when its time runs out. */
export async function endVoteNow(client, guild, messageId, now = Date.now()) {
  const vote = await Mutex.runExclusive(votesKey(guild.id), async () => {
    const votes = await readVotes(client, guild.id);
    const current = votes[messageId];
    if (!current || current.ended) return null;
    const endedAt = current.endsAt && current.endsAt < now ? current.endsAt : now;
    votes[messageId] = { ...current, ended: true, endedAt };
    await writeVotes(client, guild.id, votes);
    return votes[messageId];
  });
  if (!vote) return { status: 'not-active' };
  await closeVoteMessage(client, guild, vote);
  return { status: 'ended', vote };
}

async function resultPictureFiles(client, vote) {
  const files = [];
  for (const position of mostVoted(vote)) {
    const url = votePicture(vote, position);
    const file = await votePreviewFile({
      messageId: vote.messageId, position, url,
      refresh: vote.optionMedia ? async () => (await freshVotePictureLinks(client, vote.optionMedia))?.[position] : null,
    });
    if (file) files.push({ attachment: file.attachment, name: `most-votes-${position + 1}.${file.name.split('.').pop()}` });
  }
  return files;
}

// Discord's picture links expire after about a day: the links of votes from
// the last 30 days are renewed every 12 hours (same message, same layout).
const MEDIA_REFRESH_MS = 12 * 60 * 60_000;
const MEDIA_KEEP_MS = 30 * 24 * 60 * 60_000;

export async function refreshVotePictureLinks(client, now = Date.now()) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    const votes = await readVotes(client, guild.id).catch(() => ({}));
    for (const vote of Object.values(votes)) {
      if (!vote.optionMedia || now - (vote.mediaRefreshedAt || 0) < MEDIA_REFRESH_MS) continue;
      // A card shows no links (its Preview renews an expired link itself), so it is never edited for this.
      if (vote.layout === 'preview') continue;
      if (now - Date.parse(vote.createdAt || 0) > MEDIA_KEEP_MS) continue;
      const links = await freshVotePictureLinks(client, vote.optionMedia).catch(() => null);
      if (!links) continue;
      const updated = await Mutex.runExclusive(votesKey(guild.id), async () => {
        const current = await readVotes(client, guild.id);
        const stored = current[vote.messageId];
        if (!stored) return null;
        current[vote.messageId] = { ...stored, optionLinks: links, mediaRefreshedAt: now };
        await writeVotes(client, guild.id, current);
        return current[vote.messageId];
      }).catch(() => null);
      if (!updated) continue;
      const channel = guild.channels?.cache?.get?.(updated.channelId);
      const message = await channel?.messages?.fetch?.(updated.messageId).catch(() => null);
      if (message?.edit) await message.edit(buildVoteMessage(updated)).catch(error => logger.warn('Could not renew vote picture links:', error));
    }
  }
}

let started = false;
export function startVoteTimer(client) {
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    void endDueVotes(client).catch(() => {});
    void refreshVotePictureLinks(client).catch(() => {});
  }, 60_000);
  timer.unref?.();
  void endDueVotes(client).catch(() => {});
}
