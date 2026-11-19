import test from 'node:test';
import assert from 'node:assert/strict';
import { REST } from '@discordjs/rest';
import { CLOUDY_LOGO_URL } from '../src/services/cloudyLogoService.js';
import { normalizeCloudyMessage } from '../src/services/cloudyBrandingService.js';
import { withCloudyFooter, installCloudyFooterOutput, CLOUDY_STANDARD_FOOTER, registerBuilderPreviewReplyToken, withManualBuilderSaveLogoChoice, withManualBuilderPostLogoChoice } from '../src/utils/cloudyFooter.js';
import { registerBuilderPreviewMessage, unregisterBuilderPreviewMessage } from '../src/utils/builderSessionCleanup.js';

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
  assert.equal(withCloudyFooter({ content: '<@123456789012345678> Please read this.' }).content, '<@123456789012345678> Please read this.');
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
    assert.equal(captured[4].body.content, 'Deferred interaction result');
    assert.equal(captured[5].body.content, mention);
    assert.equal(captured[5].body.embeds[0].title, 'Report action log');
    assert.equal(captured[5].body.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
    assert.match(captured[5].body.embeds[0].thumbnail.url, /cloudy-c-logo/);

    // Regression: the photo-visible C must truly disappear from the original
    // top preview after Remove logo, without being put back by REST branding.
    const previewId = '923456789012345679';
    registerBuilderPreviewMessage(previewId);
    await rest.request({
      fullRoute: `/channels/123456789012345678/messages/${previewId}`,
      method: 'PATCH',
      body: { embeds: [{ footer: { text: CLOUDY_STANDARD_FOOTER } }] },
    });
    assert.equal(captured.at(-1).body.embeds[0].thumbnail, undefined);
    assert.equal(captured.at(-1).body.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
    unregisterBuilderPreviewMessage(previewId);

    await rest.request({
      fullRoute: '/channels/123456789012345678/messages',
      method: 'POST',
      body: { embeds: [{ title: 'Message builder', footer: { text: CLOUDY_STANDARD_FOOTER } }] },
    });
    assert.equal(captured.at(-1).body.embeds[0].thumbnail, undefined, 'dashboard stays logo-free');

    // Manual Save also preserves an explicit no-logo choice, whereas ordinary
    // bot notifications retain their default branding, including edits.
    const savedId = '923456789012345680';
    await withManualBuilderSaveLogoChoice(savedId, () => rest.request({
      fullRoute: `/channels/123456789012345678/messages/${savedId}`,
      method: 'PATCH',
      body: { embeds: [{ title: 'My existing embed', footer: { text: CLOUDY_STANDARD_FOOTER } }] },
    }));
    assert.equal(captured.at(-1).body.embeds[0].thumbnail, undefined, 'manual Save must never restore C');

    await rest.request({
      fullRoute: '/channels/123456789012345678/messages/923456789012345681',
      method: 'PATCH',
      body: { embeds: [{ title: 'Ordinary system response', footer: { text: CLOUDY_STANDARD_FOOTER } }] },
    });
    assert.equal(captured.at(-1).body.embeds[0].thumbnail, undefined, 'existing bot messages cannot gain a C from an unrelated edit');

    registerBuilderPreviewReplyToken('builder-preview-token-123');
    await rest.request({
      fullRoute: '/interactions/123456789012345678/builder-preview-token-123/callback',
      method: 'POST',
      body: { type: 4, data: { embeds: [{ footer: { text: CLOUDY_STANDARD_FOOTER } }] } },
    });
    assert.equal(captured.at(-1).body.data.embeds[0].thumbnail, undefined, 'new Builder preview respects logo choice');

    await withManualBuilderPostLogoChoice(() => rest.request({
      fullRoute: '/channels/123456789012345678/messages',
      method: 'POST',
      body: { embeds: [{ title: 'A newly posted no-logo Builder embed' }] },
    }));
    assert.equal(captured.at(-1).body.embeds[0].thumbnail, undefined, 'new manually posted embed must honor Remove logo');
    assert.equal(captured.at(-1).body.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER, 'the native gray embed still gets its footer');

    await rest.request({
      fullRoute: '/channels/123456789012345678/messages',
      method: 'POST',
      body: { embeds: [{ title: 'A regular new bot embed' }] },
    });
    assert.match(captured.at(-1).body.embeds[0].thumbnail.url, /cloudy-c-logo/, 'new default embeds are still branded');

    await rest.request({
      fullRoute: '/channels/123456789012345678/messages',
      method: 'POST',
      body: { content: 'Only a text message', components: [{ type: 1, components: [] }] },
    });
    assert.equal(captured.at(-1).body.content, 'Only a text message');
    assert.equal(captured.at(-1).body.embeds, undefined, 'plain text and buttons cannot acquire a footer embed');

    await rest.request({
      fullRoute: '/channels/123456789012345678/messages',
      method: 'POST',
      body: { embeds: [{ title: 'Old authored style', footer: { text: CLOUDY_STANDARD_FOOTER } }] },
    });
    assert.equal(captured.at(-1).body.embeds[0].thumbnail?.url, CLOUDY_LOGO_URL, 'new ordinary embeds get the C even when the standard footer was supplied');
  } finally {
    Object.defineProperty(prototype, 'request', original);
  }
});
