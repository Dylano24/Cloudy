import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseDisplayRecords, contentCreatorGuideRecordIdentity, buildEmbedPayload, getCanonicalBuilderRecords } from '../src/services/embedManagerService.js';
import {
  buildSearchChoices, buildMatches, buildAutocompleteMatches, isRetiredCreatorGuideSearchAlias,
} from '../src/commands/Tools/zz_embedbuilderLiveSearchPatch.js';

test('same-looking YouTube, Twitch and TikTok embeds have separate editable identities', () => {
  const platforms = ['youtube', 'twitch', 'tiktok'];
  const records = platforms.map((platform, i) => ({
    guildId: '123', channelId: String(1000 + i), channelName: `🔗 │ ${platform}`,
    messageId: String(9000 + i), embedIndex: 0, source: 'content-creators',
    title: 'Content Creators', name: 'Content Creators',
    snapshot: { title: 'Content Creators', description: 'Same text', color: 0xffffff },
  }));
  const groups = collapseDisplayRecords(records);
  assert.equal(groups.length, 3);
  assert.ok(groups.every(group => !group.templateMode));
  assert.equal(new Set(records.map(contentCreatorGuideRecordIdentity)).size, 3);
  assert.deepEqual(groups.map(group => group.messageId), ['9000','9001','9002']);
  records[0].snapshot.description = 'YouTube only';
  assert.equal(records[1].snapshot.description, 'Same text');
  assert.equal(records[2].snapshot.description, 'Same text');
  assert.equal(contentCreatorGuideRecordIdentity({
    ...records[0], snapshot: { title: 'A custom title for YouTube' },
  }), 'content-creators:1000');
  assert.equal(contentCreatorGuideRecordIdentity({ ...records[0], channelName: 'general' }), null);
});

test('Search lists all three live guides even when title and body are identical', () => {
  const channels = ['youtube', 'twitch', 'tiktok'].map((name,i) => ({
    id: String(123456789012345100n + BigInt(i)), name: `🔗 │ ${name}`,
    type: 0, messages: { fetch: async () => null }, toString() { return `<#${this.id}>`; },
  }));
  const guild = { id: 'creator-search-guild',
    channels: { cache: new Map(channels.map(ch => [ch.id,ch])) } };
  const records = channels.map((channel,i) => ({
    guildId: guild.id, channelId: channel.id, channelName: channel.name,
    messageId: String(123456789012345200n + BigInt(i)), embedIndex: 0,
    source: 'content-creators', name: 'Content creators', title: 'Content creators',
    snapshot: { title: 'Content creators', description: 'Same default content', color: 0xffffff },
  }));
  const matches = buildMatches(guild, records, 'content creator');
  assert.equal(matches.length, 3, 'do not merge creator guides by title');
  const choices = buildSearchChoices(matches);
  assert.equal(choices.length, 3);
  assert.deepEqual(choices.map(c => c.name).sort(), [
    'Content creators — TikTok', 'Content creators — Twitch', 'Content creators — YouTube',
  ]);
  assert.equal(new Set(choices.map(c => c.value)).size, 3);

  const shown = buildSearchChoices(buildAutocompleteMatches(guild, records, 'content creat'));
  assert.equal(shown.length, 3, 'same behavior through indexed Search');
  const youtube = buildEmbedPayload(guild, records, channels[0].id);
  assert.equal(youtube.components[0].toJSON().components[0].options[0].label,
    'Content creators', 'channel selection uses the embed title with no channel suffix');

  // A custom title in the YouTube channel does not rename its siblings.
  records[0].snapshot.title = '<:Z94tiktok:1543280394508701857>My YouTube embed';
  const newOptions = buildSearchChoices(buildMatches(guild, records, 'embed'));
  assert.equal(newOptions.length, 1);
  assert.equal(newOptions[0].name, 'My YouTube embed — YouTube');
  const updatedChannel = buildEmbedPayload(guild, records, channels[0].id);
  assert.equal(updatedChannel.components[0].toJSON().components[0].options[0].label, 'My YouTube embed');
});

test('renamed physical creator guide stays in its own channel when Subscribe button exists', () => {
  const oldGuide = {
    guildId: 'creator-saved-title-guild', channelId: '123456789012345100',
    channelName: '🔗 │ youtube', messageId: '123456789012345200', source: 'modified',
    snapshot: { title: 'My custom title', description: 'Saved review' },
    components: [{ type: 1, components: [{type:2,style:5,label:'Subscribe',url:'https://example.com'}] }],
  };
  assert.equal(contentCreatorGuideRecordIdentity(oldGuide), 'content-creators:123456789012345100');
  assert.equal(contentCreatorGuideRecordIdentity({
    ...oldGuide, channelName:'general',
  }), null);
});

test('a retired raw TikTok emoji creator entry does not duplicate three live Search choices', () => {
  const names = ['youtube', 'twitch', 'tiktok'];
  const records = names.map((platform, index) => ({
    guildId: 'creator-no-dupes',
    channelId: String(1554538629102309416n + BigInt(index) * 101n),
    channelName: `🔗 │ ${platform}`,
    messageId: String(1568880000000000000n + BigInt(index)),
    embedIndex: 0, source: 'content-creators',
    snapshot: {title: 'Content creators', description: 'Same body for now'},
  }));
  const retired = {
    guildId: 'creator-no-dupes', channelId: '1554538600000000000',
    messageId: '1567700000000000000', embedIndex: 0,
    source: 'embed-builder', manualSaved: true,
    snapshot: {
      title: '<:Z94tiktok:1543280394508701857>Content creators',
      description: 'Old copy of creator guide',
    },
  };
  assert.equal(isRetiredCreatorGuideSearchAlias(retired), true);
  assert.equal(isRetiredCreatorGuideSearchAlias(records[2]), false);
  const guild = {channels: {cache:new Map()}};
  const matches = buildMatches(guild, [...records, retired], 'content');
  const choices = buildSearchChoices(matches);
  assert.equal(choices.length, 3);
  assert.equal(new Set(choices.map(x => x.value)).size, 3,
    'each Search selection must keep its own channel and message ID');
  assert.deepEqual(choices.map(x => x.name).sort(), [
    'Content creators — TikTok', 'Content creators — Twitch', 'Content creators — YouTube',
  ]);
  assert.equal(buildSearchChoices(buildAutocompleteMatches(guild, [...records, retired], 'con')).length, 3);
  assert.equal(isRetiredCreatorGuideSearchAlias({
    snapshot: {title:'<:Z94tiktok:1543280394508701857>Some other embed'}
  }), false, 'do not hide unrelated custom emoji embeds');
});
