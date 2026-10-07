import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbed } from '../src/utils/embeds.js';
import { withCloudyFooter, CLOUDY_STANDARD_FOOTER } from '../src/utils/cloudyFooter.js';
import { MESSAGE_BUILDER_FOOTER_MARKER } from '../src/services/cloudyBrandingService.js';

test('Permission denied and other Cloudy embeds contain both logo and footer', () => {
  for (const title of ['Permission denied', 'Report submitted', 'Invalid input', 'Too fast', 'Ticket reopened']) {
    const embed = createEmbed({ title, description: 'Example response' }).toJSON();
    assert.equal(embed.title, title);
    assert.equal(embed.description, 'Example response');
    assert.equal(embed.footer?.text, CLOUDY_STANDARD_FOOTER, title);
    assert.match(embed.thumbnail?.url || '', /cloudy-c-logo/, title);
  }
});

test('all separate rich Cloudy embeds get both marks with no duplicate branding', () => {
  const payload = {
    content: '<@&223456789012345678>',
    allowed_mentions: { parse: [], roles: ['223456789012345678'] },
    embeds: [
      { title: 'Permission denied', description: 'Only owners can ban members from reports.', color: 0xff0000 },
      { title: 'Information', description: 'Please read this.' },
    ],
  };
  const result = withCloudyFooter(payload);
  assert.equal(result.content, payload.content);
  assert.deepEqual(result.allowed_mentions, payload.allowed_mentions);
  assert.equal(result.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
  assert.equal(result.embeds[1].footer.text, CLOUDY_STANDARD_FOOTER);
  for (const embed of result.embeds) assert.match(embed.thumbnail?.url || '', /cloudy-c-logo/);
  assert.equal(result.embeds[0].title, 'Permission denied');
  assert.equal(result.embeds[0].description, 'Only owners can ban members from reports.');
  assert.equal(result.embeds[0].color, 0xff0000);
  assert.deepEqual(withCloudyFooter(result), result);
});

test('standalone tag notifications never acquire a footer, logo or extra embed', () => {
  for (const content of [
    '<@123456789012345678>',
    '<@&223456789012345678> <@123456789012345678>',
    '@everyone',
    '@here',
  ]) {
    const input = { content, allowed_mentions: { parse: [] } };
    assert.equal(withCloudyFooter(input), input);
    assert.equal(withCloudyFooter(input).embeds, undefined);
  }
});

test('existing Builder footers, custom images and protected ZORP Guide remain unchanged', () => {
  const originals = [
    { title: 'Custom builder', footer: { text: 'Custom' + MESSAGE_BUILDER_FOOTER_MARKER } },
    { title: 'ZORP Guide', description: 'Protected' },
  ];
  for (const embed of originals) {
    const payload = { embeds: [embed] };
    assert.equal(withCloudyFooter(payload), payload);
  }
  const saved = { title: 'Permission denied', footer: { text: 'Saved user footer' },
    thumbnail: { url: 'https://example.com/custom.png' }, color: 0x101010 };
  const result = withCloudyFooter({ embeds: [saved] });
  assert.deepEqual(result, { embeds: [saved] });
});

test('a pre-existing Cloudy thumbnail must not suppress the standard footer', () => {
  const before = createEmbed({ title: 'Permission denied', description: 'No permission' }).toJSON();
  const stripped = { ...before };
  delete stripped.footer;
  const result = withCloudyFooter({ embeds: [stripped] });
  assert.equal(result.embeds[0].footer?.text, CLOUDY_STANDARD_FOOTER);
  assert.deepEqual(result.embeds[0].thumbnail, before.thumbnail);
});
