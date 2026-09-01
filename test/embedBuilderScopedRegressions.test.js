import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChannelPayload,
  buildEmbedPayload,
  mergeDynamicTemplateText,
  mergeTemplateFields,
} from '../src/services/embedManagerService.js';
import {
  applyRuntimeEmbedTemplateData,
  indexSystemEmbedCatalogMessage,
  systemEmbedResponseSignature,
} from '../src/services/systemEmbedCatalogService.js';
import { patchInteractionCapture } from '../src/events/fullResponseCatalogReady.js';
import {
  isInternalResponsePayload,
} from '../src/services/internalResponsePayloadService.js';
import { InteractionHelper } from '../src/utils/interactionHelper.js';
import { refreshBuilder } from '../src/commands/Tools/embedbuilder.js';
import {
  applyEmbedColorPickerSession,
  createEmbedColorPickerSession,
  deleteEmbedColorPickerSession,
} from '../src/services/embedColorPickerSessionService.js';

function catalogMessage(guildId, data) {
  return {
    guildId,
    embeds: [{
      toJSON: () => structuredClone(data),
    }],
  };
}

function context(guildId) {
  return {
    guildId,
    commandName: 'shared-command',
  };
}

test('historical peer field labels stay static while values remain live', () => {
  const fields = mergeTemplateFields(
    [{ name: 'Your Hand 1', value: 'sample' }],
    [{ name: 'Bet 9', value: 'edited sample', inline: true }],
    [{ name: 'Your Hand 2', value: '$25 live', inline: false }],
  );

  assert.equal(fields[0].name, 'Bet 9');
  assert.equal(fields[0].value, '$25 live');
  assert.equal(fields[0].inline, true);
  assert.equal(mergeDynamicTemplateText('Your Hand 1', 'Seat {dynamic}', 'Your Hand 2'), 'Seat 2');
  assert.equal(mergeDynamicTemplateText('Your Hand {dynamic}', 'Seat {dynamic}', 'Your Hand 3'), 'Seat 3');
});

test('system catalog templates are isolated by guild', () => {
  const author = {
    name: 'Cloudy template key: shared response || Cloudy context: botlog/shared-command || Cloudy kind: embed',
  };
  indexSystemEmbedCatalogMessage(catalogMessage('guild-a', {
    title: 'Shared response',
    description: 'Guild A style',
    color: 0x111111,
    author,
  }));
  indexSystemEmbedCatalogMessage(catalogMessage('guild-b', {
    title: 'Shared response',
    description: 'Guild B style',
    color: 0x222222,
    author,
  }));

  const runtime = { title: 'Shared response', description: 'Runtime text', color: 0xFFFFFF };
  assert.equal(applyRuntimeEmbedTemplateData(runtime, context('guild-a')).color, 0x111111);
  assert.equal(applyRuntimeEmbedTemplateData(runtime, context('guild-b')).color, 0x222222);
  assert.equal(applyRuntimeEmbedTemplateData(runtime, context('guild-c')).color, 0xFFFFFF);
});

test('catalog omissions preserve runtime footer, thumbnail and image', () => {
  const guildId = 'guild-media';
  indexSystemEmbedCatalogMessage(catalogMessage(guildId, {
    title: 'Media response',
    description: 'Styled response',
    color: 0x123456,
    fields: [{ name: 'Bet 9', value: 'Catalog sample' }],
    author: {
      name: 'Cloudy template key: media response || Cloudy context: botlog/shared-command || Cloudy kind: embed',
    },
  }));

  const runtime = {
    title: 'Media response',
    description: 'Runtime text',
    footer: { text: 'Runtime footer' },
    thumbnail: { url: 'https://example.com/runtime-thumbnail.png' },
    image: { url: 'https://example.com/runtime-image.png' },
    fields: [{ name: 'Runtime field 2', value: 'Live field value' }],
  };
  const result = applyRuntimeEmbedTemplateData(runtime, context(guildId));

  assert.deepEqual(result.footer, runtime.footer);
  assert.deepEqual(result.thumbnail, runtime.thumbnail);
  assert.deepEqual(result.image, runtime.image);
  assert.equal(result.fields[0].name, 'Bet 9');
  assert.equal(result.fields[0].value, 'Live field value');
});

function patchedInteraction(guildId, outgoing) {
  const send = async payload => {
    outgoing.push(payload);
    return payload;
  };
  const interaction = {
    id: `interaction-${outgoing.length}`,
    user: { id: 'owner-user' },
    guildId,
    commandName: 'shared-command',
    deferred: true,
    replied: false,
    reply: send,
    editReply: send,
    followUp: send,
    update: send,
  };
  patchInteractionCapture();
  InteractionHelper.patchInteractionResponses(interaction);
  return interaction;
}

test('loaded-existing refresh and color callback preserve live color and logo changes', async () => {
  const guildId = 'guild-marked-builder-preview';
  const cloudyLogo = 'https://raw.githubusercontent.com/Dylano24/Cloudy/main/assets/cloudy-c-logo-auf-auf.gif';
  const runtime = { title: 'Existing response', description: 'Live response' };
  const key = systemEmbedResponseSignature(runtime);
  indexSystemEmbedCatalogMessage(catalogMessage(guildId, {
    ...runtime,
    color: 0x111111,
    thumbnail: { url: 'https://example.com/catalog-logo.png' },
    author: {
      name: `Cloudy template key: ${key} || Cloudy context: botlog/shared-command || Cloudy kind: embed`,
    },
  }));

  const outgoing = [];
  const interaction = patchedInteraction(guildId, outgoing);
  const state = {
    title: runtime.title,
    message: runtime.description,
    embedFields: [],
    sideColor: 0xABCDEF,
    showLogo: true,
    removeExistingLogo: false,
    bottomLine: null,
    mediaUrl: null,
    mediaBuffer: null,
    mediaName: null,
    mediaConvertedFromVideo: false,
    colorSessionToken: null,
    colorPickerUrl: 'https://example.com/embed-color',
    contentEditorUrl: 'https://example.com/embed-content',
    modifyTarget: {
      sourceEmbedData: {
        ...runtime,
        color: 0x111111,
        thumbnail: { url: 'https://example.com/existing-logo.png' },
      },
    },
  };

  await refreshBuilder(interaction, state);
  Object.assign(state, { removeExistingLogo: true });
  await refreshBuilder(interaction, state);

  const token = createEmbedColorPickerSession({
    userId: interaction.user.id,
    getEditorState: () => ({}),
    onEditorUpdate: async () => {},
    onColor: async color => {
      state.sideColor = color;
      await refreshBuilder(interaction, state);
    },
  });
  Object.assign(state, { colorSessionToken: token });

  try {
    const colorResult = await applyEmbedColorPickerSession(token, '#FEDCBA');
    assert.equal(colorResult.ok, true);
  } finally {
    deleteEmbedColorPickerSession(token);
  }

  const firstPreview = outgoing[0].embeds[0].toJSON();
  const removedLogoPreview = outgoing[1].embeds[0].toJSON();
  const colorPreview = outgoing[2].embeds[0].toJSON();
  assert.equal(firstPreview.color, 0xABCDEF);
  assert.equal(firstPreview.thumbnail.url, cloudyLogo);
  assert.equal(removedLogoPreview.color, 0xABCDEF);
  assert.equal(removedLogoPreview.thumbnail, undefined);
  assert.equal(colorPreview.color, 0xFEDCBA);
  assert.equal(colorPreview.thumbnail, undefined);
  assert.ok(outgoing.every(payload => !isInternalResponsePayload(payload)));
});

test('marked embed manager UI bypasses response decoration and strips its marker', async () => {
  const guildId = 'guild-marked-manager';
  const outgoing = [];
  const interaction = patchedInteraction(guildId, outgoing);
  const guild = {
    channels: {
      cache: new Map([['channel-1', {
        id: 'channel-1',
        name: 'general',
        rawPosition: 1,
        parent: null,
      }]]),
    },
  };
  const payload = buildChannelPayload(guild, [{
    guildId,
    channelId: 'channel-1',
    messageId: 'message-1',
    embedIndex: 0,
    source: 'embed-builder',
    title: 'Normal embed',
  }]);

  assert.equal(isInternalResponsePayload(payload), true);
  await interaction.editReply(payload);
  assert.equal(outgoing[0].embeds[0].toJSON().color, 0xFFFFFF);
  assert.equal(isInternalResponsePayload(outgoing[0]), false);
});

test('manager reports physical embeds separately from catalog-only templates', () => {
  const guildId = 'guild-manager-counts';
  const channelId = 'channel-counts';
  const guild = {
    channels: {
      cache: new Map([[channelId, {
        id: channelId,
        name: 'feature-channel',
        rawPosition: 1,
        parent: null,
        toString: () => `<#${channelId}>`,
      }]]),
    },
  };
  const staticSuffix = index => {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    return `${first}${second}`;
  };
  const normal = Array.from({ length: 60 }, (_, index) => ({
    guildId,
    channelId,
    messageId: `normal-${index}`,
    embedIndex: 0,
    source: 'embed-builder',
    title: `Normal response ${staticSuffix(index)}`,
  }));
  const catalogOnly = Array.from({ length: 14 }, (_, index) => ({
    guildId,
    channelId,
    messageId: `catalog-${index}`,
    embedIndex: 0,
    source: 'system-catalog',
    title: `Catalog response ${staticSuffix(index)}`,
  }));
  const records = [...normal, ...catalogOnly];

  const channelsPayload = buildChannelPayload(guild, records);
  const channelDescription = channelsPayload.embeds[0].toJSON().description;
  assert.match(channelDescription, /\*\*Embeds found:\*\* 60/);
  assert.match(channelDescription, /\*\*Cloudy templates:\*\* 14/);
  assert.doesNotMatch(channelDescription, /Embeds found:\*\* 74/);
  assert.match(
    channelsPayload.components[0].toJSON().components[0].options[0].label,
    /60 embeds • 14 Cloudy templates/,
  );

  const firstPage = buildEmbedPayload(guild, records, channelId, 0);
  const lastPage = buildEmbedPayload(guild, records, channelId, 2);
  assert.match(firstPage.embeds[0].toJSON().description, /\*\*Embeds:\*\* 60/);
  assert.match(firstPage.embeds[0].toJSON().description, /\*\*Cloudy templates:\*\* 14/);
  assert.equal(firstPage.components[0].toJSON().components[0].options.length, 25);
  assert.equal(lastPage.components[0].toJSON().components[0].options.length, 24);
});

test('matching catalog and live responses remain independently editable', () => {
  const channelId = 'matching-channel';
  const guild = {
    channels: {
      cache: new Map([[channelId, {
        id: channelId,
        name: 'matching',
        rawPosition: 1,
        parent: null,
        toString: () => `<#${channelId}>`,
      }]]),
    },
  };
  const common = {
    guildId: 'matching-guild',
    channelId,
    embedIndex: 0,
    title: 'Balance for user 123',
  };
  const payload = buildEmbedPayload(guild, [
    {
      ...common,
      messageId: 'catalog',
      source: 'system-catalog',
      backingChannelId: 'catalog-backing-channel',
    },
    { ...common, messageId: 'live', source: 'runtime' },
  ], channelId);

  const options = payload.components[0].toJSON().components[0].options;
  assert.equal(options.length, 2);
  assert.equal(new Set(options.map(option => option.value)).size, 2);
  assert.ok(options.some(option => option.description === 'Edit this Cloudy template'));
  assert.match(payload.embeds[0].toJSON().description, /\*\*Embeds:\*\* 1/);
  assert.match(payload.embeds[0].toJSON().description, /\*\*Cloudy templates:\*\* 1/);
});