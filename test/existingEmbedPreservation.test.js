import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, Embed } from 'discord.js';
import { normalizeManualIndent } from '../src/utils/manualEmbedIndent.js';
import { applySavedEmbedTemplates } from '../src/services/embedTemplateService.js';
import { normalizeCloudyMessage } from '../src/services/cloudyBrandingService.js';
import { normalizeCloudyLogoMessage } from '../src/services/cloudyLogoService.js';
import { cleanupSystemCatalogEntries } from '../src/services/systemEmbedCatalogService.js';
import { reconcileZorpGuide } from '../src/services/zorpGuideService.js';
import { saveModifiedEmbed } from '../src/services/embedManagerService.js';

function existingMessage(title = '☑️ ZORP Guide') {
  return {
    id: 'guide', guildId: 'guild', channelId: 'channel', editable: true,
    author: { id: 'bot' },
    embeds: [new Embed({ title, description: '⠀  Keep  spacing', color: 0x123456,
      fields: [{ name: 'Custom', value: '  Keep this too' }] })],
    edit: async () => { assert.fail('Existing embed was rewritten'); },
    delete: async () => { assert.fail('Existing embed was deleted'); },
  };
}

test('background template, branding, logo and catalog passes leave existing embeds intact', async () => {
  for (const title of ['☑️ ZORP Guide', 'My custom guide']) {
    const message = existingMessage(title);
    const before = JSON.stringify(message.embeds);
    assert.equal(await applySavedEmbedTemplates(message), true);
    assert.equal(await normalizeCloudyMessage(message, { ensureFooter: true }), false);
    assert.equal(await normalizeCloudyLogoMessage(message), false);
    assert.equal(await cleanupSystemCatalogEntries([message]), false);
    assert.equal(JSON.stringify(message.embeds), before);
  }
});

test('ZORP restart reconciliation preserves the complete current guide', async () => {
  const message = existingMessage();
  const channel = {
    isTextBased: () => true, isThread: () => false,
    guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Collection([[message.id, message]]) },
    send: async () => assert.fail('Duplicate guide sent'),
  };
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } };
  assert.deepEqual(await reconcileZorpGuide(client), { ok: true, action: 'preserved', messageId: 'guide' });
});

test('future Save spacing is idempotent, keeps interior spaces, emoji, markdown and code blocks', () => {
  const input = '  • **Text**  <:emoji:123>\n\u2063\u2002\u2800Text\n```js\n  code();\n```\n\tEnd';
  const expected = '⠀⠀• **Text**  <:emoji:123>\n⠀⠀Text\n```js\n  code();\n```\n⠀⠀⠀⠀End';
  assert.equal(normalizeManualIndent(input), expected);
  assert.equal(normalizeManualIndent(expected), expected);
});

test('manual Save changes the selected embed and keeps sibling embeds byte-for-byte', async () => {
  const message = existingMessage();
  message.embeds.push(new Embed({ title: 'Sibling', description: '   exact', color: 0xff0000 }));
  const sibling = message.embeds[1].toJSON();
  let payload;
  message.edit = async data => { payload = data; return { ...message, embeds: data.embeds.map(e => new Embed(e)) }; };
  const channel = { id: 'channel', messages: { fetch: async () => message } };
  message.channel = channel;
  const guild = { id: 'guild', client: { user: { id: 'bot' } }, channels: { cache: new Map([['channel', channel]]) } };
  const result = await saveModifiedEmbed(guild, {
    title: 'Saved title', message: '  Saved text', sideColor: 0x123456,
    embedFields: [], showLogo: false, bottomLine: '',
    modifyTarget: { channelId: 'channel', messageId: message.id, embedIndex: 0,
      sourceEmbedData: message.embeds[0].toJSON(), cachedMessage: message, templateMode: false },
  });
  assert.equal(result.ok, true);
  assert.equal(payload.embeds[0].description, '⠀⠀Saved text');
  assert.deepEqual(payload.embeds[1], sibling);
});
