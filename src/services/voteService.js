// /vote (owner's choice, was /poll): a vote with one button per option,
// live counts in the embed and one vote per member (they can change or remove
// it). Who voted for what is never shown, only the counts.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  MessageFlags, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder,
} from 'discord.js';
import { randomInt } from 'node:crypto';
import { Mutex } from '../utils/mutex.js';
import { unwrapReplitData } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { rememberMessageDeleter } from './deletionAttributionService.js';
import { feedEmoji } from './feedEmojiService.js';
import { freshVotePictureLinks } from './voteMediaService.js';
import { votePreviewFile } from './votePreviewService.js';

export const CLOUDY_C_LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
export const CLOUDY_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
// The card of a vote has no real footer: small text is always grey there.
// White and small (owner's choice) is a thin picture of the footer on a fixed
// link like the logo, so every edit keeps the same picture and nothing loads
// again. Discord sizes a picture by the card, not by a font: on PC it is shown
// at its own width, on a phone it is shrunk to the card (about 315 points).
// The picture is therefore 450 px wide, pure white (assets/vote-footer-compact.png), so
// the footer has the same size on PC as on a phone; at 450 px it was about a
// third larger on PC. The 450 px picture is still in assets/vote-footer-small.png.
export const VOTE_FOOTER_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@55bde3bff6463da0970409234c32f8430914bc55/assets/vote-footer-compact.png';
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
export function voteTag(vote) {
  if (!vote.tagRoleId) return null;
  return vote.tagRoleId === vote.guildId ? '@everyone' : `<@&${vote.tagRoleId}>`;
}

// Only the tagged role (or everyone) is pinged, and only when the vote is
// posted: Discord never pings again when the vote is edited.
export function voteMentions(vote) {
  if (!vote.tagRoleId) return { parse: [] };
  if (vote.tagRoleId === vote.guildId) return { parse: ['everyone'] };
  return { parse: [], roles: [vote.tagRoleId] };
}

// Newer votes have the tag as its own message right above the vote
// (`tagMessageId`, owner's choice): that message is never edited, so a click on
// the vote (which redraws the whole vote in Discord's app) cannot make the tag
// disappear. Older votes keep the tag inside the vote message.
const tagInVote = vote => (vote.tagMessageId ? null : voteTag(vote));
const voteMessageMentions = vote => (vote.tagMessageId ? { parse: [] } : voteMentions(vote));

/**
 * The option shown under Most votes. On a tie Cloudy picks one of the tied
 * options at random (owner's choice), stored as `tieWinner` so it never changes.
 */
export function voteWinners(vote) {
  const tied = mostVoted(vote);
  if (tied.length <= 1) return tied;
  return [tied.includes(vote.tieWinner) ? vote.tieWinner : tied[0]];
}
export const TIE_TEXT = 'The result was randomly selected from the most-voted responses due to a tie.';
// On its own line under the how-to of the started card (owner's choice, literally).
export const TIE_RULE_TEXT = 'In the event of a tie, the outcome will be determined by a random selection among the winning responses.';

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
  // "The vote has started" / "The vote has ended" (owner's choice).
  const title = ended ? endedTitle(vote) : startedTitle(vote);
  return { total, options, end, rows, title, ended };
}

// A vote with pictures (owner's choice): a small "Preview" button right next
// to every option with a picture, which shows it privately (vote_media). Only
// Discord's newer message layout can put a button next to text, so these
// votes are a card (white side line, Cloudy logo and footer) instead of an embed.
// A little more room between sections (owner's choice): an empty separator.
const sectionGap = () => new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
// The titles (owner's choice): "The vote has started" and "The vote has ended".
const startedTitle = vote => vote.title || 'The vote has started!';
const endedTitle = vote => (vote.title ? `${vote.title} ended` : 'The vote has ended!');
// The title and the question with the Cloudy logo beside them (owner's choice),
// on "Vote started" and "Vote ended" alike.
const titleWithLogo = (title, question, note = null) => new SectionBuilder()
  .addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`### ${title}`),
    ...(note ? [new TextDisplayBuilder().setContent(note)] : []),
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
    // Its own line without a bullet, after an empty line (owner's choice, literally).
    '',
    TIE_RULE_TEXT,
  ];
  const card = new ContainerBuilder()
    .setAccentColor(0xFFFFFF)
    .addSectionComponents(titleWithLogo(startedTitle(vote), vote.question))
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
  // The requested order is Question → Choices → Description (when supplied).
  if (vote.description) {
    card.addSeparatorComponents(sectionGap())
      .addTextDisplayComponents(text(`**Description**\n${String(vote.description).slice(0, 500)}`));
  }
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
  const tag = tagInVote(vote);
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [...(tag ? [text(tag)] : []), card, ...rows],
    allowedMentions: voteMessageMentions(vote),
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
    .addSectionComponents(titleWithLogo(endedTitle(vote), vote.question));
  // Cloudy style (owner's choice): own number emoji, the option in bold, count and share.
  const line = index => `${numberIcon(index)} **${vote.options[index]}** · ${votes(counts[index])} · ${Math.round(total ? counts[index] / total * 100 : 0)}%`;
  const winners = voteWinners(vote);
  // The winner: only its number and name, no votes or share (owner's choice).
  const winnerLine = index => `${numberIcon(index)} **${vote.options[index]}**`;
  // On a tie the option Cloudy picked, with this sentence under it (owner's choice, literally).
  const tie = mostVoted(vote).length > 1;
  // Results first, then Most votes with the winner's picture (owner's choice).
  card.addSeparatorComponents(sectionGap())
    .addTextDisplayComponents(text(['**Results**', ...order.map(line)].join('\n')))
    .addSeparatorComponents(sectionGap())
    .addTextDisplayComponents(text([tie ? '**Random selection result**' : '**Most votes**', ...(winners.length ? winners.map(winnerLine) : ['No votes']), ...(tie ? [TIE_TEXT] : [])].join('\n')));
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
  // The role tag is its own message above the result (owner's choice, as on
  // the start), so Discord highlights only the tag and not the result.
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [card],
    allowedMentions: { parse: [] },
  };
}

export function buildVoteMessage(vote, now = Date.now()) {
  const parts = voteParts(vote, now);
  if (vote.layout === 'preview') return buildPreviewVoteMessage(vote, parts);
  const lines = [`**${vote.question}**`, '', ...parts.options.flatMap(option => [option.line, option.bar])];
  if (vote.description) lines.push('', `**Description**\n${String(vote.description).slice(0, 500)}`);
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
  const tag = tagInVote(vote);
  return {
    ...(tag ? { content: tag } : {}),
    embeds: [main, ...images.slice(1).map(image => ({ url: GALLERY_URL, image: { url: image } }))],
    components: parts.rows,
    allowedMentions: voteMessageMentions(vote),
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

// Unknown Channel / Unknown Message: the vote is really gone from Discord.
const GONE_CODES = new Set([10003, 10008]);
const isGone = error => GONE_CODES.has(error?.code);
export const VOTE_CLOSE_MAX_ATTEMPTS = 30;

// A vote is marked ended first; removing its buttons and posting its result
// follow. Until that is done the vote carries `closePending`, so a Discord
// outage or a restart at exactly that moment is picked up again by the next
// minute's check instead of leaving the vote with its buttons and no result.
function endedVote(vote, endedAt) {
  const ended = { ...vote, ended: true, endedAt, closePending: { attempts: 0 } };
  // A tie: Cloudy picks one of the tied options at random and keeps it
  // (owner's choice). Saved together with the end, so it can never change.
  const tied = mostVoted(ended);
  if (ended.layout === 'preview' && tied.length > 1 && !tied.includes(ended.tieWinner)) {
    ended.tieWinner = tied[randomInt(tied.length)];
  }
  return ended;
}

function withoutClosePending(vote) {
  const { closePending: _pending, ...rest } = vote;
  return rest;
}

// Changes one stored vote under the votes lock. `change` returns the new vote,
// or null to leave it as it is. A vote deleted meanwhile stays deleted.
async function updateVote(client, guildId, messageId, change) {
  return Mutex.runExclusive(votesKey(guildId), async () => {
    const votes = await readVotes(client, guildId);
    const current = votes[messageId];
    const next = current ? change(current) : null;
    if (!next) return null;
    votes[messageId] = next;
    await writeVotes(client, guildId, votes);
    return next;
  });
}

// Runs every minute: closes votes whose end time has passed, and finishes
// closing votes that ended while Discord or Cloudy was unavailable.
export async function endDueVotes(client) {
  for (const guild of client.guilds?.cache?.values?.() || []) {
    let due;
    try {
      due = await Mutex.runExclusive(votesKey(guild.id), async () => {
        const votes = await readVotes(client, guild.id);
        const now = Date.now();
        const waiting = Object.values(votes).filter(vote => vote.ended && vote.closePending);
        const ending = Object.values(votes).filter(vote => !vote.ended && vote.endsAt && vote.endsAt <= now);
        if (ending.length) {
          for (const vote of ending) votes[vote.messageId] = endedVote(vote, vote.endsAt);
          await writeVotes(client, guild.id, votes);
        }
        return [...waiting, ...ending.map(vote => votes[vote.messageId])];
      });
    } catch (error) {
      logger.warn(`Could not close votes in ${guild.id}:`, error);
      continue;
    }
    for (const vote of due) {
      await closeVoteMessage(client, guild, vote)
        .catch(error => logger.warn(`Could not close vote ${vote.messageId}: ${error?.message || error}`));
    }
  }
}

// "Gone" (deleted in Discord) is told apart from "could not be checked right
// now": a vote is never left unfinished on a guess.
async function locateVoteMessage(guild, vote) {
  let channel = guild.channels?.cache?.get?.(vote.channelId) || null;
  if (!channel && guild.channels?.fetch) {
    try {
      channel = (await guild.channels.fetch(vote.channelId)) || null;
    } catch (error) {
      return isGone(error) ? { status: 'gone' } : { status: 'unavailable', error };
    }
  }
  if (!channel?.messages?.fetch) return { status: 'gone' };
  try {
    const message = await channel.messages.fetch(vote.messageId);
    return message?.edit ? { status: 'found', channel, message } : { status: 'gone' };
  } catch (error) {
    return isGone(error) ? { status: 'gone' } : { status: 'unavailable', error };
  }
}

async function deferVoteClose(client, guildId, vote, error) {
  const attempts = (Number(vote.closePending?.attempts) || 0) + 1;
  const abandoned = attempts >= VOTE_CLOSE_MAX_ATTEMPTS;
  await updateVote(client, guildId, vote.messageId, current => {
    if (!current.closePending) return null;
    return abandoned ? withoutClosePending(current) : { ...current, closePending: { attempts } };
  }).catch(() => {});
  const text = `[VOTE] Vote ${vote.messageId} could not be closed in Discord (attempt ${attempts}/${VOTE_CLOSE_MAX_ATTEMPTS}): ${error?.message || error}`;
  if (abandoned) logger.error(`${text}. Giving up.`);
  else logger.warn(text);
}

// The vote stays as it was, without buttons (owner's choice); a card gets its
// result as its own message under it, with the winner's picture.
async function closeVoteMessage(client, guild, vote) {
  const located = await locateVoteMessage(guild, vote);
  const finished = () => updateVote(client, guild.id, vote.messageId,
    current => (current.closePending ? withoutClosePending(current) : null)).catch(() => null);
  if (located.status === 'gone') {
    await finished();
    return;
  }
  if (located.status === 'unavailable') {
    await deferVoteClose(client, guild.id, vote, located.error);
    return;
  }
  const { channel, message } = located;
  try {
    await message.edit(buildVoteMessage(vote));
  } catch (error) {
    if (isGone(error)) await finished();
    else await deferVoteClose(client, guild.id, vote, error);
    return;
  }
  // From here nothing is repeated: only the one check that takes the vote out
  // of `closePending` posts its result, so a result is never posted twice.
  const closed = await finished();
  if (!closed || closed.layout !== 'preview') return;
  const files = await resultPictureFiles(client, closed).catch(() => []);
  // The role tagged on the vote is tagged on its result too (owner's choice):
  // its own message, the reply to the vote, with the result right under it.
  // It is never removed by Cloudy (owner's choice).
  const tag = voteTag(closed);
  const tagMessage = tag
    ? await message.reply({ content: tag, allowedMentions: voteMentions(closed) })
      .catch(error => { logger.warn('Could not tag the vote result:', error); return null; })
    : null;
  const result = await (tagMessage ? channel.send.bind(channel) : message.reply.bind(message))({ ...buildVoteResultMessage(closed, files.map(file => file.name)), ...(files.length ? { files } : {}) })
    .catch(error => { logger.warn('Could not post the vote result:', error); return null; });
  if (result) {
    await updateVote(client, guild.id, vote.messageId, current => ({ ...current, resultMessageId: result.id })).catch(() => {});
  }
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
  for (const id of [vote.messageId, vote.resultMessageId, vote.tagMessageId].filter(Boolean)) {
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
    votes[messageId] = endedVote(current, endedAt);
    await writeVotes(client, guild.id, votes);
    return votes[messageId];
  });
  if (!vote) return { status: 'not-active' };
  await closeVoteMessage(client, guild, vote);
  return { status: 'ended', vote };
}

async function resultPictureFiles(client, vote) {
  const files = [];
  for (const position of voteWinners(vote)) {
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
