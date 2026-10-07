import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUDY_STANDARD_FOOTER, withCloudyFooter } from '../src/utils/cloudyFooter.js';
import { CLOUDY_LOGO_URL } from '../src/services/cloudyLogoService.js';

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

test('treats branding as message-level and does not touch sibling embeds once one is branded', () => {
  const alreadyBranded = { embeds: [
    { title: 'Unbranded sibling' },
    { title: 'Existing footer', footer: { text: 'Custom footer' } },
  ] };
  assert.deepEqual(withCloudyFooter(alreadyBranded), alreadyBranded);

  const unbranded = { embeds: [{ title: 'First' }, { title: 'Second' }] };
  const result = withCloudyFooter(unbranded);
  assert.equal(result.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
  assert.deepEqual(result.embeds[1], unbranded.embeds[1]);
});

test('adds Cloudy footer to embed and plain messages while retaining bare recipient mentions', () => {
  const embed = withCloudyFooter({ embeds: [{ title: 'Ticket update' }] });
  assert.equal(embed.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);

  for (const payload of [
    { content: '<@123456789012345678>' },
    { content: '<@&223456789012345678>' },
    { content: 'A plain Cloudy message' },
  ]) {
    assert.equal(
      withCloudyFooter(payload).content,
      `${payload.content}\n\n${CLOUDY_STANDARD_FOOTER}`,
    );
  }
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
