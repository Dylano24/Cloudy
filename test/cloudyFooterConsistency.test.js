import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLOUDY_STANDARD_FOOTER } from '../src/utils/cloudyFooter.js';
import { CLOUDY_FOOTER as VOTE_FOOTER_TEXT, VOTE_FOOTER_URL, buildVoteMessage, buildVoteResultMessage } from '../src/services/voteService.js';
import { CLOUDY_FOOTER as FEED_FOOTER_TEXT } from '../src/services/gameFeedService.js';
import { CLOUDY_BRANDING } from '../src/services/cloudyBrandingService.js';
import { CLOUDY_TICKET_FOOTER } from '../src/utils/ticket/ticketBranding.js';
import { GIVEAWAY_CLAIM_LOG_FOOTER } from '../src/services/giveawayClaimLogService.js';

// The standard Cloudy footer is written out in many files. This guards the
// approved wording so no copy can drift from it, and pins the footer picture
// of the vote card (see docs/audit/production-audit-2026-11-11.md).

const STANDARD = '© Cloudy Inc. • Quality. Innovation. Performance.';

function sourceFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

test('the approved standard footer text is unchanged', () => {
  assert.equal(CLOUDY_STANDARD_FOOTER, STANDARD);
  for (const copy of [VOTE_FOOTER_TEXT, FEED_FOOTER_TEXT, CLOUDY_BRANDING, CLOUDY_TICKET_FOOTER, GIVEAWAY_CLAIM_LOG_FOOTER]) {
    assert.equal(copy, STANDARD);
  }
});

test('every written-out copy of the standard footer in the bot is exactly the approved text', () => {
  const copies = [];
  for (const file of sourceFiles('src')) {
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      // Quoted text only; patterns that recognise older footers are not copies.
      for (const match of line.matchAll(/(['"`>])([^'"`<>]*Quality\.[^'"`<>]*)(?=['"`<])/g)) {
        const text = match[2];
        if (/\\s|\[ \\t\]|\\\.|\?\)/.test(text)) continue;
        copies.push({ where: `${file}:${index + 1}`, text });
      }
    }
  }
  assert.ok(copies.length >= 30, `expected the known copies, found ${copies.length}`);
  for (const { where, text } of copies) assert.equal(text, STANDARD, where);
});

// The size of a PNG is in its first chunk; no image library is needed.
function pngSize(file) {
  const data = readFileSync(file);
  assert.equal(data.subarray(1, 4).toString('latin1'), 'PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test('the vote card footer is a picture as wide as a phone shows it, so PC and phone match', () => {
  // On PC Discord shows a picture at its own width; on a phone it shrinks it
  // to the card (about 315 points). At 450 px the footer was larger on PC.
  assert.deepEqual(pngSize('assets/vote-footer-compact.png'), { width: 450, height: 23 });
  assert.deepEqual(pngSize('assets/vote-footer-small.png'), { width: 450, height: 23 }, 'the earlier picture is kept');
  assert.match(VOTE_FOOTER_URL, /^https:\/\/cdn\.jsdelivr\.net\/gh\/Dylano24\/Cloudy@[0-9a-f]{40}\/assets\/vote-footer-compact\.png$/,
    'a fixed link: the picture never changes or reloads when a vote is redrawn');

  const vote = { messageId: '1', guildId: '2', channelId: '3', question: 'Q', options: ['A', 'B'], votes: {}, layout: 'preview' };
  for (const payload of [buildVoteMessage(vote), buildVoteResultMessage({ ...vote, ended: true, endedAt: Date.now() })]) {
    const card = payload.components.map(component => component.toJSON?.() || component).find(component => component.type === 17);
    const last = card.components.at(-1);
    assert.equal(last.type, 12, 'the footer is the last part of the card');
    assert.deepEqual(last.items.map(item => item.media.url), [VOTE_FOOTER_URL]);
    assert.equal(last.items[0].description, undefined, 'no description: Discord showed its ALT label as a black line');
  }
});
