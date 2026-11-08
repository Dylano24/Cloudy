import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseDisplayRecords, contentCreatorGuideRecordIdentity, contentCreatorGuidePlatform, buildEmbedPayload, loadRecordSnapshotIntoState } from '../src/services/embedManagerService.js';
import {
  buildSearchChoices, buildMatches, buildAutocompleteMatches, isRetiredCreatorGuideSearchAlias,
  resolvePhysicalCreatorGuideSelection,
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
    'Content creators', 'Content creators', 'Content creators',
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
  assert.equal(newOptions[0].name, '<:Z94tiktok:1543280394508701857>My YouTube embed');
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

test('real TikTok ID survives a legacy raw-emoji title and hides the external duplicate', () => {
  const names = ['youtube', 'twitch', 'tiktok'];
  const channelIds = [
    '1554538629102309416', '1554538630129778702', '1554538632323272755',
  ];
  const records = names.map((platform, index) => ({
    guildId: 'creator-no-dupes',
    channelId: channelIds[index],
    channelName: `🔗 │ ${platform}`,
    messageId: String(1568880000000000000n + BigInt(index)),
    embedIndex: 0, source: 'content-creators',
    snapshot: {title: index === 2
      ? '<:Z94tiktok:1543280394508701857>Content creators'
      : 'Content creators', description: 'Same body for now'},
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
  assert.equal(isRetiredCreatorGuideSearchAlias(records[2]), false,
    'do not filter the live TikTok message just because its title has that emoji');
  assert.equal(contentCreatorGuideRecordIdentity(records[2]),
    'content-creators:1554538632323272755');
  assert.equal(contentCreatorGuidePlatform({ ...records[2], channelName: '' }), 'tiktok',
    'the known channel ID remains enough even when channelName is absent');
  const guild = {channels: {cache:new Map()}};
  const matches = buildMatches(guild, [...records, retired], 'content');
  const choices = buildSearchChoices(matches);
  assert.equal(choices.length, 3);
  assert.equal(new Set(choices.map(x => x.value)).size, 3,
    'each Search selection must keep its own channel and message ID');
  assert.deepEqual(choices.map(x => x.name).sort(), [
    '<:Z94tiktok:1543280394508701857>Content creators', 'Content creators', 'Content creators',
  ]);
  assert.equal(buildSearchChoices(buildAutocompleteMatches(guild, [...records, retired], 'con')).length, 3);
  // The obsolete entry can also appear as a title/name overlay with an older
  // saved snapshot title. Search must remove that alias, not the real channel.
  const staleOverlay = { ...retired,
    messageId: '1567700000000000001',
    snapshot: {title:'Content creators', description:'Old copy'},
    name: '<:Z94tiktok:1543280394508701857>Content creators',
  };
  assert.equal(isRetiredCreatorGuideSearchAlias(staleOverlay), true);
  assert.equal(buildSearchChoices(buildMatches(guild, [...records, retired, staleOverlay], 'con')).length, 3);
  assert.equal(isRetiredCreatorGuideSearchAlias({
    snapshot: {title:'<:Z94tiktok:1543280394508701857>Some other embed'}
  }), false, 'do not hide unrelated custom emoji embeds');
});

test('choosing YouTube fetches only its exact Discord message, never a stale Twitch preview', async () => {
  const youtubeId = '1554538629102309416';
  const twitchId = '1554538630129778702';
  const youtubeMessageId = '1570000000000000001';
  const twitchMessageId = '1570000000000000002';
  const calls = [];
  const messages = new Map([
    [youtubeId, {
      id: youtubeMessageId, channelId: youtubeId, author: { id: 'cloudy-bot' },
      embeds: [{ toJSON: () => ({ title:'<:YTbrand:111111111111111111>Content creators', description:'YouTube only.' }) }],
      components: [],
    }],
    [twitchId, {
      id: twitchMessageId, channelId: twitchId, author: { id: 'cloudy-bot' },
      embeds: [{ toJSON: () => ({ title:'<:TWbrand:222222222222222222>Content creators', description:'Twitch only.' }) }],
      components: [],
    }],
  ]);
  const guild = { channels: { cache: new Map(
    [...messages.entries()].map(([id, message]) => [id,
      { id, messages: { async fetch(arg) { calls.push([id,arg]); return message; } } }]),
  ) } };
  const record = {
    channelId: youtubeId, messageId: youtubeMessageId, channelName:'🔗 │ youtube',
    source:'content-creators', snapshot: { title: 'Twitch cached title', description:'Wrong cached body' },
    previewRecord: { channelId:twitchId, messageId:twitchMessageId, snapshot:{ description:'Twitch cached preview' } },
  };
  const target = await resolvePhysicalCreatorGuideSelection(guild, 'cloudy-bot', record,
    {channelId:youtubeId, messageId:youtubeMessageId, embedIndex:0});
  assert.equal(target.snapshot.description, 'YouTube only.');
  assert.equal(target.snapshot.title, '<:YTbrand:111111111111111111>Content creators');
  assert.equal(target.previewRecord, null);
  assert.equal(target.sourceRecord, null);
  assert.deepEqual(calls, [[youtubeId, {message:youtubeMessageId, force:true}]]);
  assert.equal(target.creatorGuideVerified, true);
  const wrong = await resolvePhysicalCreatorGuideSelection(guild, 'cloudy-bot', record,
    {channelId:twitchId, messageId:twitchMessageId, embedIndex:0});
  assert.equal(wrong, null, 'channel mismatch must fail before any live fetch');
});

test('creator search keeps the custom emoji IDs in the visible titles', () => {
  const youtube = {
    guildId:'title-creator', channelId:'1554538629102309416',
    channelName:'🔗 │ youtube', messageId:'1570000000000000001',
    source:'content-creators', snapshot: {
      title:'<:YTbrand:111111111111111111>Content creators', description:'Channel content',
    },
  };
  const twitch = { ...youtube, channelId:'1554538630129778702',
    channelName:'🔗 │ twitch', messageId:'1570000000000000002', snapshot: {
      title:'<:TWbrand:222222222222222222>Content creators', description:'Channel content',
    },
  };
  const matches = buildMatches({channels:{cache:new Map()}}, [youtube,twitch], 'content');
  const choices = buildSearchChoices(matches);
  assert.deepEqual(choices.map(x=>x.name).sort(), [
    '<:TWbrand:222222222222222222>Content creators',
    '<:YTbrand:111111111111111111>Content creators',
  ]);
  assert.equal(new Set(choices.map(x=>x.value)).size, 2);
});

test('stale YouTube autocomplete ID follows its current sticky message and loads the full preview', async () => {
  const channelId = '1554538629102309416';
  const staleId = '1570000000000000001';
  const currentId = '1570000000000000123';
  const requests = [];
  const currentMessage = {
    id: currentId, channelId, author: { id: 'cloudy-bot' }, components: [],
    embeds: [{ toJSON: () => ({
      title: '<:YTbrand:111111111111111111>Content creators',
      description: 'Only the current YouTube review.',
      color: 0xffffff,
    }) }],
  };
  const channel = {
    id: channelId, name: 'youtube',
    client: { db: { async get(key) {
      assert.equal(key, 'global:content-creators:guide:guild-1:' + channelId);
      return { messageId: currentId };
    } } },
    messages: { async fetch(options) {
      requests.push(options);
      if (options.message === staleId) return null;
      if (options.message === currentId) return currentMessage;
      throw new Error('Unexpected fetch');
    } },
  };
  const guild = { id: 'guild-1', channels: { cache: new Map([[channelId, channel]]) } };
  const record = {
    guildId: guild.id, channelId, channelName: 'youtube', messageId: staleId,
    source: 'content-creators',
    snapshot: {title: 'Outdated title', description: 'This is not the current preview.'},
    previewRecord: {channelId: '1554538630129778702', messageId: '1570000000000000888',
      snapshot: {description: 'Twitch should never appear'}},
  };
  const selected = await resolvePhysicalCreatorGuideSelection(guild, 'cloudy-bot', record,
    {channelId, messageId: staleId, embedIndex: 0});
  assert.equal(selected.messageId, currentId);
  assert.equal(selected.previewRecord, null);
  assert.equal(selected.sourceRecord, null);
  assert.equal(selected.snapshot.description, 'Only the current YouTube review.');
  assert.deepEqual(requests, [
    {message:staleId,force:true}, {message:currentId,force:true},
  ]);
  const editor = {};
  assert.equal(loadRecordSnapshotIntoState(editor, guild, selected), true);
  assert.equal(editor.title, '<:YTbrand:111111111111111111>Content creators');
  assert.equal(editor.message, 'Only the current YouTube review.');
  assert.equal(editor.modifyTarget.channelId, channelId);
  assert.equal(editor.modifyTarget.messageId, currentId);
  assert.equal(editor.modifyTarget.templateMode, false);
});

test('a deleted autocomplete ID can recover a newer guide only in the same channel', async () => {
  const channelId = '1554538629102309416';
  const staleId = '1570000000000000001';
  const currentId = '1570000000000000333';
  const currentMessage = {
    id: currentId, channelId, author: { id: 'cloudy-bot' },
    embeds: [{title:'My own unique title', toJSON() {
      return {title:'My own unique title', description:'Current YouTube content'};
    }}],
    components:[{components:[{label:'Subscribe'}]}],
  };
  const wrongChannelMessage = {
    ...currentMessage, id:'1570000000000000444',
    channelId:'1554538630129778702',
  };
  const channel = {id:channelId, messages:{async fetch(options) {
    if (options.message === staleId) return null;
    if (options.limit) return new Map([
      [wrongChannelMessage.id, wrongChannelMessage],
      [currentMessage.id, currentMessage],
    ]);
    return null;
  }}};
  const guild = {id:'guild-1',channels:{cache:new Map([[channelId,channel]])}};
  const record = {guildId:guild.id,channelId,messageId:staleId,
    channelName:'youtube',source:'content-creators',snapshot:{
      title:'Content creators',description:'Old guide'
    }};
  const selected = await resolvePhysicalCreatorGuideSelection(guild,'cloudy-bot',record,
    {channelId,messageId:staleId,embedIndex:0});
  assert.equal(selected.messageId,currentId);
  assert.equal(selected.snapshot.title,'My own unique title');
  assert.equal(selected.snapshot.description,'Current YouTube content');
  const crossChannel = await resolvePhysicalCreatorGuideSelection(guild,'cloudy-bot',record,
    {channelId:'1554538630129778702',messageId:wrongChannelMessage.id,embedIndex:0});
  assert.equal(crossChannel,null,'must never switch to another creator channel');
});
