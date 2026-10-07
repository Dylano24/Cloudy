import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WEBSITE_TERMS_FOOTER, syncExistingTermsFooter } from '../src/services/termsWebsiteFooterService.js';

test('existing Terms of service footer is updated in place without changing any legal sections or icon', async () => {
  const original = {
    title: '<:terms:1234> Terms of service',
    description: 'Original legal notice',
    fields: [{ name: '1. Introduction', value: 'Exact existing terms text', inline: false }],
    thumbnail: { url: 'https://example.com/unchanged.png' },
    color: 0xffffff,
    footer: { text: '© Cloudy Inc. • Last updated: 8 October 2026' },
  };
  let editCount = 0;
  let newMessage = null;
  const message = {
    embeds: [structuredClone(original)],
    async edit(payload) {
      editCount++;
      newMessage = payload;
      this.embeds = payload.embeds;
    },
  };

  assert.equal(await syncExistingTermsFooter(message, 'Terms of service'), true);
  assert.equal(editCount, 1);
  assert.equal(newMessage.embeds.length, 1, 'must not send duplicate embeds');
  assert.equal(newMessage.embeds[0].footer.text, WEBSITE_TERMS_FOOTER);
  assert.deepEqual(
    { ...newMessage.embeds[0], footer: original.footer },
    original,
    'every existing field except the footer must be preserved',
  );
  assert.equal(await syncExistingTermsFooter(message, 'Terms of service'), false);
  assert.equal(editCount, 1, 'repeat startup must never edit the same message again');
});

test('Store terms of sale only changes its footer, leaving sibling embeds untouched', async () => {
  const existing = {
    embeds: [
      { title: 'Welcome', description: 'Another embed', footer: { text: 'Keep' } },
      { title: '<:terms:1234> Store terms of sale', fields: [{ name: '9. Liability', value: 'Content' }],
        footer: { text: 'Old date' } },
    ],
    async edit(payload) { this.embeds = payload.embeds; },
  };
  const beforeOther = structuredClone(existing.embeds[0]);
  assert.equal(await syncExistingTermsFooter(existing, 'Store terms of sale'), true);
  assert.deepEqual(existing.embeds[0], beforeOther);
  assert.equal(existing.embeds[1].footer.text, 'Last updated 20.03.2026 at 13h42');
  assert.deepEqual(existing.embeds[1].fields, [{ name: '9. Liability', value: 'Content' }]);
});

test('preserved footer with website timestamp does not trigger an edit', async () => {
  const message = {
    embeds: [{ title: 'Terms of service', footer: { text: WEBSITE_TERMS_FOOTER } }],
    async edit() { assert.fail('must not edit unchanged terms on restart'); },
  };
  assert.equal(await syncExistingTermsFooter(message, 'Terms of service'), false);
});

test('both Discord terms services keep legal copy unchanged and update existing message footers', () => {
  for (const file of [
    'src/services/termsMessageService.js',
    'src/services/storeTermsMessageService.js',
  ]) {
    const code = fs.readFileSync(file, 'utf8');
    assert.match(code, /const footerText = WEBSITE_TERMS_FOOTER;/);
    assert.match(code, /if \(existing\) \{[\s\S]*?syncExistingTermsFooter\(existing,/);
    assert.match(code, /return \{ ok: true, action: updated \? 'updated_footer' : 'preserved', messageId: existing.id \};/);
    assert.doesNotMatch(code, /formatLastUpdated\(/);
    assert.match(code, /\.addFields\(/, 'all original legal sections remain');
  }
});
