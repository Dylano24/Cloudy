import test from 'node:test';
import assert from 'node:assert/strict';
import { primeSystemSourceDefinitionPreview } from '../src/services/systemEmbedCatalogService.js';
import { loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';

// Cloudy's code copy of the welcome embed: placeholders and the code's own
// field names. It must never replace what a real Discord message shows.
const codeCopy = {
  kind: 'embed',
  context: 'welcome/guild-member-add',
  title: 'Welcome to Cloudy Inc.',
  description: '{dynamic} {dynamic}',
  fields: [
    { name: '📜 Rules', value: '[Check our rules]({dynamic})\n\\u200b', inline: false },
    { name: '📩 Support & Help', value: '[Contact us]({dynamic})', inline: false },
  ],
  footer: { text: 'Code footer' },
  thumbnail: { url: 'https://example.com/code-logo.png' },
  image: { url: 'https://example.com/code-banner.gif' },
  color: 0x123456,
};

const live = {
  title: 'Welcome to Cloudy Inc.',
  description: 'You are the **9**th member of the server <@1274048370775687198>',
  fields: [
    { name: 'Rules', value: '[Check our rules](https://discord.com/channels/1/2)\n​', inline: false },
    { name: 'Support & Help', value: '[Contact us](https://discord.com/channels/1/3)', inline: false },
  ],
  footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
  thumbnail: { url: 'https://example.com/live-logo.png' },
  image: { url: 'https://example.com/live-banner.gif' },
  color: 0xFFFFFF,
};

for (const [label, extra] of [
  ['an owner-saved Builder post', { source: 'embed-builder', manualSaved: true }],
  ['a Cloudy bot post', { source: 'cloudy' }],
]) {
  test(`${label} opens with its own content, never Cloudy's code copy`, () => {
    primeSystemSourceDefinitionPreview(codeCopy);
    const guild = { id: 'own-content-guild', channels: { cache: new Map() } };
    const record = {
      guildId: guild.id, channelId: '1532882647838228701', messageId: '1532882647838228702',
      embedIndex: 0, title: live.title, name: live.title, snapshot: structuredClone(live), ...extra,
    };
    const state = {};
    assert.equal(loadRecordSnapshotIntoState(state, guild, record), true);
    assert.equal(state.message, live.description);
    assert.deepEqual(state.embedFields, live.fields, 'the real fields, no {dynamic} or \\u200b text');
    assert.equal(state.bottomLine, live.footer.text);
    assert.equal(state.mediaUrl, live.image.url);
    assert.equal(state.sideColor, live.color);
    assert.equal(state.showLogo, true);
    const preview = state.modifyTarget.previewSourceData;
    assert.deepEqual(preview.fields, live.fields);
    assert.equal(preview.thumbnail.url, live.thumbnail.url);
    assert.equal(preview.image.url, live.image.url);
    assert.doesNotMatch(JSON.stringify(preview), /\{dynamic\}|\\\\u200b/);
  });
}
