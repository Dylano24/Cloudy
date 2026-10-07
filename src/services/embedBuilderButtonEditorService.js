import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getFromDb, setInDb } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { redisAcquireLock } from '../utils/redisCache.js';

const ACTION_PREFIX = 'cloudy:builder-button-action:';
const ACTION_CUSTOM_ID = 'cloudy_builder_action';
const BUTTON_COMPONENT_TYPE = 2;
const ACTION_ROW_TYPE = 1;
const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const EDITOR_IDLE_MS = 5 * 60_000;
const DEFAULT_RESPONSE_DELETE_MS = 10_000;
const modalSubmissions = new Set();

const STYLE_BY_NAME = new Map([
  ['blue', ButtonStyle.Primary],
  ['primary', ButtonStyle.Primary],
  ['blauw', ButtonStyle.Primary],
  ['gray', ButtonStyle.Secondary],
  ['grey', ButtonStyle.Secondary],
  ['secondary', ButtonStyle.Secondary],
  ['grijs', ButtonStyle.Secondary],
  ['green', ButtonStyle.Success],
  ['success', ButtonStyle.Success],
  ['groen', ButtonStyle.Success],
  ['red', ButtonStyle.Danger],
  ['danger', ButtonStyle.Danger],
  ['rood', ButtonStyle.Danger],
  ['link', ButtonStyle.Link],
]);

const STYLE_NAME = new Map([
  [ButtonStyle.Primary, 'Blue'],
  [ButtonStyle.Secondary, 'Gray'],
  [ButtonStyle.Success, 'Green'],
  [ButtonStyle.Danger, 'Red'],
  [ButtonStyle.Link, 'Link'],
  [ButtonStyle.Premium, 'Premium'],
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function actionKey(guildId, actionId) {
  return `${ACTION_PREFIX}${guildId}:${actionId}`;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(0, MAX_ROWS)
    .map(row => {
      const data = row?.toJSON ? row.toJSON() : clone(row);
      if (!data || Number(data.type) !== ACTION_ROW_TYPE || !Array.isArray(data.components)) return null;
      return {
        ...data,
        type: ACTION_ROW_TYPE,
        components: data.components.slice(0, MAX_BUTTONS_PER_ROW).map(component =>
          component?.toJSON ? component.toJSON() : clone(component)
        ),
      };
    })
    .filter(Boolean);
}

export function componentRowsFromMessage(message) {
  return normalizeRows(message?.components || []);
}

export function loadBuilderComponentsFromRecord(state, record) {
  if (!state || !record?.messageId) return false;

  const hasStoredComponents = Array.isArray(record.components);
  state.componentRows = hasStoredComponents ? normalizeRows(record.components) : [];
  state.componentRowsSourceMessageId = hasStoredComponents ? String(record.messageId) : null;
  state.componentsDirty = false;
  return hasStoredComponents;
}

export function loadBuilderComponentsFromMessage(state, message) {
  if (!state || !message?.id) return false;
  state.componentRows = componentRowsFromMessage(message);
  state.componentRowsSourceMessageId = String(message.id);
  state.componentsDirty = false;
  return true;
}

export async function hydrateBuilderMessageComponents(guild, state) {
  const target = state?.modifyTarget;
  const targetId = target?.messageId ? String(target.messageId) : '';
  if (!guild || !targetId || state.componentsDirty) return false;

  if (state.componentRowsSourceMessageId === targetId && Array.isArray(state.componentRows)) {
    return false;
  }

  let message = target.cachedMessage && String(target.cachedMessage.id) === targetId
    ? target.cachedMessage
    : null;

  if (!message) {
    const backingChannelId = String(target?.backingChannelId || target?.channelId || '');
    const channel = guild.channels?.cache?.get?.(backingChannelId)
      || await guild.channels?.fetch?.(backingChannelId).catch(() => null);
    message = await channel?.messages?.fetch?.(targetId).catch(() => null);
  }

  if (!message) return false;
  loadBuilderComponentsFromMessage(state, message);
  state.modifyTarget.cachedMessage = message;
  return true;
}

export function getBuilderMessageComponents(state) {
  return normalizeRows(state?.componentRows || []);
}

export function getBuilderPreviewComponents(state) {
  return getBuilderMessageComponents(state).map(row => ({
    ...row,
    components: row.components.map(component =>
      Number(component?.type) === BUTTON_COMPONENT_TYPE
        ? { ...component, disabled: true }
        : component
    ),
  }));
}

export function countBuilderButtons(state) {
  return getBuilderMessageComponents(state).reduce(
    (total, row) => total + row.components.filter(component => Number(component?.type) === BUTTON_COMPONENT_TYPE).length,
    0,
  );
}

async function deletePrivateBuilderMessage(interaction, messageId, message = null) {
  if (!messageId) return;
  const deleted = interaction?.webhook?.deleteMessage
    ? await interaction.webhook.deleteMessage(String(messageId)).then(() => true).catch(() => false)
    : false;
  if (!deleted) await message?.delete?.().catch(() => {});
}

export async function cleanupBuilderButtonUi(interaction, state) {
  if (!state) return;

  const editorMessage = state.activeButtonEditorMessage || null;
  const editorId = state.activeButtonEditorMessageId
    ? String(state.activeButtonEditorMessageId)
    : editorMessage?.id
      ? String(editorMessage.id)
      : null;
  const previewMessage = state.activeButtonPreviewMessage || null;
  const previewId = state.activeButtonPreviewMessageId
    ? String(state.activeButtonPreviewMessageId)
    : previewMessage?.id
      ? String(previewMessage.id)
      : null;

  const editorCollector = state.activeButtonEditorCollector || null;
  state.activeButtonEditorCollector = null;
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorMessageId = null;
  state.activeButtonPreviewMessage = null;
  state.activeButtonPreviewMessageId = null;

  editorCollector?.stop?.('builder-cleanup');

  await Promise.all([
    editorId ? deletePrivateBuilderMessage(interaction, editorId, editorMessage) : null,
    previewId ? deletePrivateBuilderMessage(interaction, previewId, previewMessage) : null,
  ].filter(Boolean));
}

async function closeButtonEditorPanel(interaction, state) {
  const editorMessage = state.activeButtonEditorMessage || null;
  const editorId = state.activeButtonEditorMessageId
    ? String(state.activeButtonEditorMessageId)
    : editorMessage?.id
      ? String(editorMessage.id)
      : null;
  const editorCollector = state.activeButtonEditorCollector || null;

  state.activeButtonEditorCollector = null;
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorMessageId = null;
  editorCollector?.stop?.('preview-ready');

  if (editorId) {
    await deletePrivateBuilderMessage(interaction, editorId, editorMessage);
  }
}

export async function syncBuilderButtonPreview(interaction, state) {
  const oldId = state?.activeButtonPreviewMessageId
    ? String(state.activeButtonPreviewMessageId)
    : null;
  if (oldId) {
    await deletePrivateBuilderMessage(interaction, oldId, state.activeButtonPreviewMessage);
  }
  state.activeButtonPreviewMessageId = null;
  state.activeButtonPreviewMessage = null;
  return null;
}

export function parseButtonStyle(value, fallback = ButtonStyle.Secondary) {
  return STYLE_BY_NAME.get(String(value || '').trim().toLowerCase()) || fallback;
}

export function buttonStyleName(style) {
  return STYLE_NAME.get(Number(style)) || 'Unknown';
}

export function isBuilderActionCustomId(customId) {
  return String(customId || '').startsWith(`${ACTION_CUSTOM_ID}:`);
}

export async function saveBuilderButtonAction(guildId, actionId, action) {
  if (!guildId || !actionId) return false;
  const source = typeof action === 'string'
    ? { responseText: action }
    : (action && typeof action === 'object' ? action : {});

  const url = String(source.url || '').trim();
  return setInDb(actionKey(guildId, actionId), {
    responseText: String(source.responseText || '').slice(0, 4000),
    visibility: source.visibility === 'public' ? 'public' : 'private',
    deleteAfterMs: Number.isFinite(Number(source.deleteAfterMs))
      && Number(source.deleteAfterMs) >= 1_000
      && Number(source.deleteAfterMs) <= 15 * 60_000
        ? Number(source.deleteAfterMs)
        : null,
    url: /^https?:\/\//i.test(url) ? url.slice(0, 512) : null,
    linkLabel: String(source.linkLabel || '').trim().slice(0, 80) || null,
    updatedAt: new Date().toISOString(),
  });
}

export async function getBuilderButtonAction(guildId, actionId) {
  if (!guildId || !actionId) return null;
  return getFromDb(actionKey(guildId, actionId), null);
}

function listButtons(rows) {
  const result = [];
  rows.forEach((row, rowIndex) => {
    (row.components || []).forEach((component, componentIndex) => {
      if (Number(component?.type) !== BUTTON_COMPONENT_TYPE) return;
      result.push({
        rowIndex,
        componentIndex,
        component,
        key: `${rowIndex}:${componentIndex}`,
      });
    });
  });
  return result;
}

function buttonLabel(component, index) {
  return String(component?.label || `Button ${index + 1}`).slice(0, 80);
}

function appendButton(rows, component) {
  const next = normalizeRows(rows);
  let target = next.find(row =>
    row.components.length < MAX_BUTTONS_PER_ROW
    && row.components.every(item => Number(item?.type) === BUTTON_COMPONENT_TYPE)
  );

  if (!target) {
    if (next.length >= MAX_ROWS) return null;
    target = { type: ACTION_ROW_TYPE, components: [] };
    next.push(target);
  }

  target.components.push(clone(component));
  return next;
}

export function removeRightmostBuilderButton(rows) {
  const next = normalizeRows(rows);

  for (let rowIndex = next.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = next[rowIndex];
    for (let componentIndex = row.components.length - 1; componentIndex >= 0; componentIndex -= 1) {
      if (Number(row.components[componentIndex]?.type) !== BUTTON_COMPONENT_TYPE) continue;
      row.components.splice(componentIndex, 1);
      if (!row.components.length) next.splice(rowIndex, 1);
      return next;
    }
  }

  return next;
}

async function ensureRowsLoaded(buttonInteraction, state) {
  const targetId = state?.modifyTarget?.messageId ? String(state.modifyTarget.messageId) : 'new';
  if (state.componentRowsSourceMessageId === targetId && Array.isArray(state.componentRows)) return;

  if (targetId === 'new') {
    state.componentRows = [];
    state.componentRowsSourceMessageId = 'new';
    state.componentsDirty = false;
    return;
  }

  await hydrateBuilderMessageComponents(buttonInteraction.guild, state);
}

function buttonDraftStyleName(state) {
  const raw = String(state?.builderButtonDraftStyle || 'gray').trim().toLowerCase();
  return ['gray', 'blue', 'green', 'red'].includes(raw) ? raw : 'gray';
}

function buttonDraftVisibility(state) {
  return String(state?.builderButtonDraftVisibility || 'private').trim().toLowerCase() === 'public'
    ? 'public'
    : 'private';
}

// BUILDER_NATIVE_COLOR_INSTANT_V1
function managerPayload(state) {
  const rows = getBuilderMessageComponents(state);
  const buttons = listButtons(rows);
  const styleName = buttonDraftStyleName(state);
  const visibility = buttonDraftVisibility(state);
  const lines = buttons.length
    ? buttons.map((item, index) => {
      const type = Number(item.component.style) === ButtonStyle.Link
        ? 'Link'
        : item.component.disabled
          ? 'Disabled'
          : 'Response';
      return '**' + (index + 1) + '. ' + buttonLabel(item.component, index) + '** — ' + type;
    })
    : ['No buttons are attached yet.'];

  const colorOptions = [
    ['Gray', 'gray'],
    ['Blue', 'blue'],
    ['Green', 'green'],
    ['Red', 'red'],
  ].map(([label, value]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setValue(value)
      .setDefault(styleName === value)
  );

  const visibilityOptions = [
    ['Private', 'private'],
    ['Public', 'public'],
  ].map(([label, value]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setValue(value)
      .setDefault(visibility === value)
  );

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Embed buttons')
        .setDescription([
          ...lines,
          '',
          'Choose the button color and visibility below, then press Add button.',
        ].join('\n').slice(0, 4096))
        .setColor(0xFFFFFF),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('embed_button_color_select')
          .setPlaceholder('Color • ' + styleName.charAt(0).toUpperCase() + styleName.slice(1))
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(...colorOptions),
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('embed_button_visibility_select')
          .setPlaceholder('Visibility (optional) • ' + (visibility === 'public' ? 'Public' : 'Private'))
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(...visibilityOptions),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('embed_button_add_response')
          .setLabel('Add button')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function normalizeButtonVisibility(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'private' || raw === 'ephemeral' || raw === 'privé') return 'private';
  if (raw === 'public' || raw === 'publiek') return 'public';
  return null;
}

function parseButtonDuration(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!raw || ['none', 'off', 'keep', 'stay', 'stays', 'permanent'].includes(raw)) {
    return { valid: true, ms: null };
  }

  const match = raw.match(/^(\d{1,3})(s|sec|secs|second|seconds|m|min|mins|minute|minutes)$/);
  if (!match) return { valid: false, ms: null };

  const amount = Number(match[1]);
  const unit = match[2].startsWith('m') ? 60_000 : 1_000;
  const ms = amount * unit;
  if (!Number.isFinite(ms) || ms < 1_000 || ms > 15 * 60_000) {
    return { valid: false, ms: null };
  }
  return { valid: true, ms };
}

async function replyButtonEditorError(interaction, content) {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
  const timer = setTimeout(() => {
    void interaction.deleteReply().catch(() => {});
  }, 10_000);
  timer.unref?.();
}

// BUILDER_LIVE_POLISH_V1
async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
  const modalGeneration = (state.buttonModalGeneration || 0) + 1;
  state.buttonModalGeneration = modalGeneration;
  const modalId = 'embed_button_add_response_modal:' + randomUUID().replaceAll('-', '').slice(0, 12);
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Add button')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_label')
          .setLabel('Button name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Name shown on the button')
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_duration')
          .setLabel('Duration (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('10s, 30s, 1m, 5m • blank stays')
          .setMaxLength(16)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_response')
          .setLabel('Response message (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Message sent when the button is clicked')
          .setMaxLength(4000)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_url')
          .setLabel('Add link (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://example.com')
          .setMaxLength(512)
          .setRequired(false),
      ),
    );

  await componentInteraction.showModal(modal);
  const submitted = await componentInteraction.awaitModalSubmit({
    filter: interaction => interaction.customId === modalId
      && interaction.user.id === componentInteraction.user.id,
    time: 120_000,
  }).catch(() => null);
  if (!submitted) return;
  if (state.buttonModalGeneration !== modalGeneration) {
    if (!submitted.replied && !submitted.deferred) {
      await submitted.deferUpdate().catch(() => {});
    }
    return;
  }

  const ownsSubmit = await redisAcquireLock('embed-button-submit:' + submitted.id, 5 * 60_000);
  if (!ownsSubmit) {
    if (!submitted.replied && !submitted.deferred) {
      await submitted.deferUpdate().catch(() => {});
    }
    return;
  }

  const label = submitted.fields.getTextInputValue('button_label').trim().slice(0, 80);
  const style = parseButtonStyle(buttonDraftStyleName(state), ButtonStyle.Secondary);
  const visibility = buttonDraftVisibility(state);
  const duration = parseButtonDuration(
    submitted.fields.getTextInputValue('button_duration'),
  );
  const responseText = submitted.fields.getTextInputValue('button_response').trim().slice(0, 4000);
  const url = submitted.fields.getTextInputValue('button_url').trim().slice(0, 512);

  if (!duration.valid) {
    await replyButtonEditorError(
      submitted,
      'Duration must be blank or a time such as 10s, 30s, 1m, 5m or 15m.',
    );
    return;
  }
  if (!responseText && !url) {
    await replyButtonEditorError(submitted, 'Add a response message, a link, or both.');
    return;
  }
  if (url && !/^https?:\/\//i.test(url)) {
    await replyButtonEditorError(submitted, 'The link must start with http:// or https://.');
    return;
  }

  let next;
  if (!responseText && url) {
    next = appendButton(state.componentRows, {
      type: BUTTON_COMPONENT_TYPE,
      style: ButtonStyle.Link,
      label,
      url,
    });
  } else {
    const actionId = randomUUID().replaceAll('-', '').slice(0, 24);
    const saved = await saveBuilderButtonAction(submitted.guildId, actionId, {
      responseText,
      visibility,
      deleteAfterMs: duration.ms,
      url: url || null,
      linkLabel: label,
    });
    if (!saved) {
      await replyButtonEditorError(submitted, 'Could not save the button action. Nothing was added.');
      return;
    }

    next = appendButton(state.componentRows, {
      type: BUTTON_COMPONENT_TYPE,
      style: style === ButtonStyle.Link ? ButtonStyle.Secondary : style,
      label,
      custom_id: ACTION_CUSTOM_ID + ':' + actionId,
    });
  }

  if (!next) {
    await replyButtonEditorError(
      submitted,
      'Discord allows at most 5 component rows. Remove a button before adding another one.',
    );
    return;
  }

  state.componentRows = next;
  state.componentRowsSourceMessageId = state.modifyTarget?.messageId
    ? String(state.modifyTarget.messageId)
    : 'new';
  state.componentsDirty = true;

  await submitted.deferUpdate().catch(() => {});
  await panelMessage.edit(managerPayload(state)).catch(() => {});
  await refreshBuilder(submitted, state).catch(() => {});
  await closeButtonEditorPanel(submitted, state).catch(() => {});
}
async function showAddLinkModal(componentInteraction, state, refreshBuilder, panelMessage) {
  const modal = new ModalBuilder()
    .setCustomId('embed_button_add_link_modal')
    .setTitle('Add link button')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_label')
          .setLabel('Button name')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_url')
          .setLabel('URL')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://example.com')
          .setMaxLength(512)
          .setRequired(true),
      ),
    );

  await componentInteraction.showModal(modal);
  const submitted = await componentInteraction.awaitModalSubmit({
    filter: interaction => interaction.customId === 'embed_button_add_link_modal'
      && interaction.user.id === componentInteraction.user.id,
    time: 120_000,
  }).catch(() => null);
  if (!submitted) return;

  const label = submitted.fields.getTextInputValue('button_label').trim().slice(0, 80);
  const url = submitted.fields.getTextInputValue('button_url').trim();
  if (!/^https?:\/\//i.test(url)) {
    await submitted.reply({ content: 'The URL must start with http:// or https://.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const next = appendButton(state.componentRows, {
    type: BUTTON_COMPONENT_TYPE,
    style: ButtonStyle.Link,
    label,
    url: url.slice(0, 512),
  });
  if (!next) {
    await submitted.reply({ content: 'Discord allows at most 5 component rows. Remove/reuse a row before adding another button.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  state.componentRows = next;
  state.componentRowsSourceMessageId = state.modifyTarget?.messageId
    ? String(state.modifyTarget.messageId)
    : 'new';
  state.componentsDirty = true;
  await submitted.deferUpdate().catch(() => {});
  await panelMessage.edit(managerPayload(state)).catch(() => {});
  await refreshBuilder(submitted, state).catch(() => {});
  await syncBuilderButtonPreview(submitted, state).catch(() => {});
  await closeButtonEditorPanel(submitted, state).catch(() => {});
}

async function showEditButtonModal(componentInteraction, state, key, refreshBuilder, panelMessage) {
  const [rowIndexRaw, componentIndexRaw] = String(key || '').split(':');
  const rowIndex = Number(rowIndexRaw);
  const componentIndex = Number(componentIndexRaw);
  const component = state.componentRows?.[rowIndex]?.components?.[componentIndex];
  if (!component || Number(component.type) !== BUTTON_COMPONENT_TYPE || Number(component.style) === ButtonStyle.Premium) {
    await componentInteraction.deferUpdate().catch(() => {});
    return;
  }

  const isLink = Number(component.style) === ButtonStyle.Link;
  const modal = new ModalBuilder()
    .setCustomId(`embed_button_edit_modal:${rowIndex}:${componentIndex}`)
    .setTitle('Edit button')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_label')
          .setLabel('Button name')
          .setStyle(TextInputStyle.Short)
          .setValue(String(component.label || '').slice(0, 80))
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_style')
          .setLabel(isLink ? 'Type: link (Discord fixes its color)' : 'Color: blue, gray, green or red')
          .setStyle(TextInputStyle.Short)
          .setValue(isLink ? 'link' : buttonStyleName(component.style).toLowerCase())
          .setMaxLength(12)
          .setRequired(true),
      ),
    );

  await componentInteraction.showModal(modal);
  const submitted = await componentInteraction.awaitModalSubmit({
    filter: interaction => interaction.customId === `embed_button_edit_modal:${rowIndex}:${componentIndex}`
      && interaction.user.id === componentInteraction.user.id,
    time: 120_000,
  }).catch(() => null);
  if (!submitted) return;

  const label = submitted.fields.getTextInputValue('button_label').trim().slice(0, 80);
  const requestedStyle = submitted.fields.getTextInputValue('button_style');
  component.label = label;
  component.style = isLink
    ? ButtonStyle.Link
    : parseButtonStyle(requestedStyle, Number(component.style) || ButtonStyle.Secondary);
  if (!isLink && component.style === ButtonStyle.Link) component.style = ButtonStyle.Secondary;

  state.componentsDirty = true;
  await submitted.deferUpdate().catch(() => {});
  await panelMessage.edit(managerPayload(state)).catch(() => {});
  await refreshBuilder(submitted, state).catch(() => {});
  await syncBuilderButtonPreview(submitted, state).catch(() => {});
  await closeButtonEditorPanel(submitted, state).catch(() => {});
}

export async function openEmbedButtonEditor(buttonInteraction, state, refreshBuilder) {
  // Acknowledge the Builder click before any database/message lookup so Discord
  // never shows "This interaction failed" while the editor is opening.
  await buttonInteraction.deferUpdate().catch(() => {});
  await ensureRowsLoaded(buttonInteraction, state);
  await syncBuilderButtonPreview(buttonInteraction, state).catch(() => {});

  const existingEditorId = state.activeButtonEditorMessageId
    ? String(state.activeButtonEditorMessageId)
    : null;

  if (
    existingEditorId
    && state.activeButtonEditorCollector
    && !state.activeButtonEditorCollector.ended
    && buttonInteraction.webhook?.editMessage
  ) {
    const edited = await buttonInteraction.webhook.editMessage(
      existingEditorId,
      managerPayload(state),
    ).catch(() => null);
    if (edited) {
      state.activeButtonEditorMessage = edited;
      return;
    }
  }

  if (existingEditorId) {
    await deletePrivateBuilderMessage(
      buttonInteraction,
      existingEditorId,
      state.activeButtonEditorMessage,
    );
  }
  state.activeButtonEditorMessageId = null;
  state.activeButtonEditorMessage = null;
  state.activeButtonEditorCollector?.stop?.('replaced');

  const panelMessage = await buttonInteraction.followUp({
    ...managerPayload(state),
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  }).catch(() => null);
  if (!panelMessage) return;

  if (!state.builderChildMessages) state.builderChildMessages = new Map();
  state.builderChildMessages.set(panelMessage.id, panelMessage);

  state.activeButtonEditorMessage = panelMessage;
  state.activeButtonEditorMessageId = String(panelMessage.id);

  const collector = panelMessage.createMessageComponentCollector({
    filter: interaction => interaction.user.id === buttonInteraction.user.id,
    idle: EDITOR_IDLE_MS,
  });
  state.activeButtonEditorCollector = collector;

  collector.on('end', async () => {
    state.builderChildMessages?.delete(panelMessage.id);
    state.buttonModalGeneration = (state.buttonModalGeneration || 0) + 1;
    if (state.activeButtonEditorCollector === collector) state.activeButtonEditorCollector = null;
    if (state.activeButtonEditorMessageId === String(panelMessage.id)) {
      state.activeButtonEditorMessage = null;
      state.activeButtonEditorMessageId = null;
      await deletePrivateBuilderMessage(buttonInteraction, panelMessage.id, panelMessage);
    }
  });

  collector.on('collect', componentInteraction => {
    void (async () => {
      try {
        if (componentInteraction.customId === 'embed_button_color_select') {
          state.builderButtonDraftStyle = String(componentInteraction.values?.[0] || 'gray');
          await componentInteraction.deferUpdate().catch(() => {});
          await panelMessage.edit(managerPayload(state)).catch(() => {});
          return;
        }
        if (componentInteraction.customId === 'embed_button_visibility_select') {
          state.builderButtonDraftVisibility = String(componentInteraction.values?.[0] || 'private');
          await componentInteraction.deferUpdate().catch(() => {});
          await panelMessage.edit(managerPayload(state)).catch(() => {});
          return;
        }
        if (componentInteraction.customId === 'embed_button_add_response') {
          await showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }
        await componentInteraction.deferUpdate().catch(() => {});
      } catch (error) {
        logger.error('Embed button editor action failed:', error);
        if (!componentInteraction.replied && !componentInteraction.deferred) {
          await componentInteraction.deferUpdate().catch(() => {});
        }
      }
    })();
  });
}
