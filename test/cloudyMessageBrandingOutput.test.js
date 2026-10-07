import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUDY_STANDARD_FOOTER, withCloudyFooter } from '../src/utils/cloudyFooter.js';
import { CLOUDY_LOGO_URL } from '../src/services/cloudyLogoService.js';

test('preserves report ban permission presentation without mutating the input', () => {
  const payload = { embeds: [{ title: 'Error', description: 'Only owners can ban members from reports.', footer: { text: 'Existing footer' } }] };
  const result = withCloudyFooter(payload);
  assert.equal(result.embeds[0].title, 'Permission denied');
  assert.equal(result.embeds[0].thumbnail.url, CLOUDY_LOGO_URL);
  assert.equal(result.embeds[0].footer.text, 'Existing footer');
  assert.equal(payload.embeds[0].title, 'Error');
  assert.equal(payload.embeds[0].thumbnail, undefined);
});

test('leaves embeds with an existing footer entirely unchanged', () => {
  const payload = {
    content: '<@123456789012345678>',
    embeds: [{
      title: 'Saved title',
      description: 'Keep this exact text.',
      thumbnail: { url: 'https://example.com/custom.png' },
      footer: { text: 'Custom footer text' },
    }],
  };

  const result = withCloudyFooter(payload);
  assert.equal(result.content, payload.content);
  assert.equal(result.embeds[0].title, payload.embeds[0].title);
  assert.equal(result.embeds[0].description, payload.embeds[0].description);
  assert.deepEqual(result.embeds[0].thumbnail, payload.embeds[0].thumbnail);
  assert.deepEqual(result, payload);
});

test('adds the Cloudy footer only when an embed has neither logo nor footer', () => {
  const payload = { embeds: [{ title: 'Existing artwork', thumbnail: { url: 'https://example.com/custom.png' } }] };
  const result = withCloudyFooter(payload);
  assert.equal(result.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
  assert.deepEqual(result.embeds[0].thumbnail, payload.embeds[0].thumbnail);
});

test('brands each rich Cloudy embed while preserving saved custom footer text', () => {
  const alreadyBranded = { embeds: [
    { title: 'Unbranded sibling' },
    { title: 'Existing footer', footer: { text: 'Custom footer' } },
  ] };
  const fixed = withCloudyFooter(alreadyBranded);
  assert.equal(fixed.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
  assert.match(fixed.embeds[0].thumbnail.url, /cloudy-c-logo/);
  assert.deepEqual(fixed.embeds[1], alreadyBranded.embeds[1]);

  const unbranded = { embeds: [{ title: 'First' }, { title: 'Second' }] };
  const result = withCloudyFooter(unbranded);
  for (const embed of result.embeds) {
    assert.equal(embed.footer.text, CLOUDY_STANDARD_FOOTER);
    assert.match(embed.thumbnail.url, /cloudy-c-logo/);
  }
});

test('saved custom footer without a thumbnail preserves intentionally removed Builder logo', () => {
  const saved = { embeds: [{ title: 'Manual Builder', footer: { text: 'My custom footer' } }] };
  assert.equal(withCloudyFooter(saved), saved);
});


test('brands meaningful messages while leaving bare recipient mentions unchanged', () => {
  const embed = withCloudyFooter({ embeds: [{ title: 'Ticket update' }] });
  assert.equal(embed.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);

  for (const payload of [
    { content: '<@123456789012345678>' },
    { content: '<@&223456789012345678>' },
  ]) {
    assert.equal(withCloudyFooter(payload), payload);
  }
  assert.equal(withCloudyFooter({ content: 'A plain Cloudy message' }).content,
    `A plain Cloudy message\n\n${CLOUDY_STANDARD_FOOTER}`);
});

test('keeps existing Cloudy-logo embeds and explicitly exempt Guide and builder messages unchanged', () => {
  const cloudyLogo = {
    embeds: [{ title: 'Welcome', thumbnail: { url: CLOUDY_LOGO_URL }, footer: { text: 'Custom footer' } }],
  };
  assert.deepEqual(withCloudyFooter(cloudyLogo), cloudyLogo);

  const guide = { embeds: [{ title: '🛡️ ZORP Guide', footer: { text: 'Guide footer' } }] };
  assert.deepEqual(withCloudyFooter(guide), guide);

  const builder = { embeds: [{ title: 'Custom', footer: { text: `No branding\u200B` } }] };
  assert.deepEqual(withCloudyFooter(builder), builder);
});

test('brands component-only messages but leaves Components V2 payloads untouched', () => {
  const componentOnly = { components: [{ type: 1, components: [] }] };
  assert.equal(withCloudyFooter(componentOnly).embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);

  const attachmentOnly = { content: '', files: [{ name: 'report.txt' }] };
  assert.equal(withCloudyFooter(attachmentOnly).embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);

  const clearingEdit = { content: '', attachments: [] };
  assert.deepEqual(withCloudyFooter(clearingEdit, { isNewMessage: false }), clearingEdit);

  const partialEdit = { content: 'Edit a message that may already be branded' };
  assert.deepEqual(withCloudyFooter(partialEdit, { isNewMessage: false }), partialEdit);

  const componentsV2 = { flags: 32768, components: [{ type: 17, components: [] }] };
  assert.deepEqual(withCloudyFooter(componentsV2), componentsV2);
});
