import test from 'node:test';
import assert from 'node:assert/strict';
import { REST } from '@discordjs/rest';
import { normalizeCloudyMessage } from '../src/services/cloudyBrandingService.js';
import { withCloudyFooter, installCloudyFooterOutput, CLOUDY_STANDARD_FOOTER } from '../src/utils/cloudyFooter.js';

test('message-create normalization does not reintroduce branding beside recipient tags', async () => {
  let edited = false;
  const result = await normalizeCloudyMessage({
    content: '<@&223456789012345678> <@123456789012345678>',
    editable: true,
    embeds: [{ title: 'Ticket opened' }],
    edit: async () => { edited = true; },
  }, { ensureFooter: true, initialCreation: true });
  assert.equal(result, false);
  assert.equal(edited, false);
});

test('mention-only messages retain tags and allowed-mentions rules without automatic branding', () => {
  for (const content of ['<@123456789012345678>', '<@!123456789012345678>', '<@&223456789012345678> <@123456789012345678>', '@everyone', '@here\n<@123456789012345678>']) {
    const payload = { content, allowed_mentions: { parse: [] } };
    const result = withCloudyFooter(payload);
    assert.equal(result, payload);
    assert.deepEqual(result.allowed_mentions, payload.allowed_mentions);
  }
  assert.equal(withCloudyFooter({ content: '<@123456789012345678> Please read this.' }).content, `<@123456789012345678> Please read this.\n\n${CLOUDY_STANDARD_FOOTER}`);
  const embed = withCloudyFooter({ content: '<@123456789012345678>', embeds: [{ title: 'Ticket reopened' }] });
  assert.equal(embed.content, '<@123456789012345678>');
  assert.equal(embed.embeds[0].title, 'Ticket reopened');
  assert.equal(embed.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
  assert.match(embed.embeds[0].thumbnail.url, /cloudy-c-logo/);
});

test('Discord REST message and interaction paths keep bare tags without automatic branding', async () => {
  const prototype = REST.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'request');
  const captured = [];
  Object.defineProperty(prototype, 'request', {
    ...original,
    value: async options => { captured.push(options); return options; },
  });
  try {
    installCloudyFooterOutput();
    const rest = new REST();
    const mention = '<@&223456789012345678> <@123456789012345678>';
    await rest.request({ fullRoute: '/channels/123456789012345678/messages', method: 'POST', body: { content: mention } });
    await rest.request({ fullRoute: '/channels/123456789012345678/messages/323456789012345678', method: 'PATCH', body: { content: 'Updated report status' } });
    await rest.request({ fullRoute: '/interactions/123456789012345678/token/callback', method: 'POST', body: { type: 4, data: { content: mention } } });
    await rest.request({ fullRoute: '/interactions/123456789012345678/deferred-token/callback', method: 'POST', body: { type: 5, data: { flags: 64 } } });
    await rest.request({ fullRoute: '/webhooks/123456789012345678/deferred-token/messages/@original', method: 'PATCH', body: { content: 'Deferred interaction result' } });
    await rest.request({ fullRoute: '/webhooks/123456789012345678/token', method: 'POST', body: { content: mention, embeds: [{ title: 'Report action log' }] } });
    assert.equal(captured[0].body.content, mention);
    assert.equal(captured[1].body.content, 'Updated report status');
    assert.equal(captured[2].body.data.content, mention);
    assert.equal(captured[3].body.data.flags, 64);
    assert.equal(captured[4].body.content, `Deferred interaction result\n\n${CLOUDY_STANDARD_FOOTER}`);
    assert.equal(captured[5].body.content, mention);
    assert.equal(captured[5].body.embeds[0].title, 'Report action log');
    assert.equal(captured[5].body.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
    assert.match(captured[5].body.embeds[0].thumbnail.url, /cloudy-c-logo/);
  } finally {
    Object.defineProperty(prototype, 'request', original);
  }
});
