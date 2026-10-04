import test from 'node:test';
import assert from 'node:assert/strict';
import { REST } from '@discordjs/rest';
import { withCloudyFooter, installCloudyFooterOutput, CLOUDY_STANDARD_FOOTER } from '../src/utils/cloudyFooter.js';

test('standalone ticket/member/staff mentions stay bare, while actual messages keep their footer', () => {
  for (const content of ['<@123456789012345678>', '<@!123456789012345678>', '<@&223456789012345678> <@123456789012345678>', '@everyone', '@here\n<@123456789012345678>']) {
    const payload = { content, allowed_mentions: { parse: [] } };
    assert.deepEqual(withCloudyFooter(payload), payload);
  }
  assert.equal(withCloudyFooter({ content: '<@123456789012345678> Please read this.' }).content, `<@123456789012345678> Please read this.\n\n${CLOUDY_STANDARD_FOOTER}`);
  const embed = withCloudyFooter({ content: '<@123456789012345678>', embeds: [{ title: 'Ticket reopened' }] });
  assert.equal(embed.content, '<@123456789012345678>');
  assert.equal(embed.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
});

test('actual Discord REST message and interaction paths preserve bare tags and embed footers', async () => {
  const original = REST.prototype.request;
  const captured = [];
  REST.prototype.request = async options => { captured.push(options); return options; };
  try {
    installCloudyFooterOutput();
    const rest = new REST();
    const mention = '<@&223456789012345678> <@123456789012345678>';
    await rest.request({ fullRoute: '/channels/123456789012345678/messages', method: 'POST', body: { content: mention } });
    await rest.request({ fullRoute: '/interactions/123456789012345678/token/callback', method: 'POST', body: { type: 4, data: { content: mention } } });
    await rest.request({ fullRoute: '/webhooks/123456789012345678/token', method: 'POST', body: { content: mention, embeds: [{ title: 'Report action log' }] } });
    assert.equal(captured[0].body.content, mention);
    assert.equal(captured[1].body.data.content, mention);
    assert.equal(captured[2].body.content, mention);
    assert.equal(captured[2].body.embeds[0].footer.text, CLOUDY_STANDARD_FOOTER);
  } finally { REST.prototype.request = original; }
});

