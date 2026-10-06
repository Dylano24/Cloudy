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
const BUTTON_EMOJI_SELECT_ROWS = 3;
const BUTTON_EMOJIS_PER_SELECT = 25;
const BUTTON_EMOJIS_PER_PAGE = BUTTON_EMOJI_SELECT_ROWS * BUTTON_EMOJIS_PER_SELECT;
const BUTTON_EMOJI_GUILD_LIMIT = 125;
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

export async function syncBuilderButtonPreview(interaction, state) {
  const rows = getBuilderPreviewComponents(state);
  const existingId = state?.activeButtonPreviewMessageId
    ? String(state.activeButtonPreviewMessageId)
    : null;

  if (!rows.length) {
    if (existingId) {
      await deletePrivateBuilderMessage(interaction, existingId, state.activeButtonPreviewMessage);
    }
    state.activeButtonPreviewMessageId = null;
    state.activeButtonPreviewMessage = null;
    return null;
  }

  if (existingId && interaction?.webhook?.editMessage) {
    const edited = await interaction.webhook.editMessage(existingId, {
      content: '',
      embeds: [],
      components: rows,
    }).catch(() => null);
    if (edited) {
      state.activeButtonPreviewMessage = edited;
      return edited;
    }
  }

  const preview = await interaction.followUp({
    components: rows,
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  }).catch(() => null);

  if (preview) {
    state.activeButtonPreviewMessageId = String(preview.id);
    state.activeButtonPreviewMessage = preview;
  }
  return preview;
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

export async function saveBuilderButtonAction(guildId, actionId, responseText) {
  if (!guildId || !actionId) return false;
  return setInDb(actionKey(guildId, actionId), {
    responseText: String(responseText || '').slice(0, 2000),
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

function parseButtonKey(key) {
  const [rowIndexRaw, componentIndexRaw] = String(key || '').split(':');
  const rowIndex = Number(rowIndexRaw);
  const componentIndex = Number(componentIndexRaw);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || !Number.isInteger(componentIndex) || componentIndex < 0) {
    return null;
  }
  return { rowIndex, componentIndex };
}

function buttonAt(rows, key) {
  const parsed = parseButtonKey(key);
  if (!parsed) return null;
  const component = rows?.[parsed.rowIndex]?.components?.[parsed.componentIndex];
  if (!component || Number(component.type) !== BUTTON_COMPONENT_TYPE) return null;
  return { ...parsed, component };
}

function normalizeCustomEmoji(emoji) {
  const id = String(emoji?.id || '').trim();
  if (!id) return null;
  const name = String(emoji?.name || 'emoji').trim().slice(0, 32) || 'emoji';
  return {
    id,
    name,
    animated: Boolean(emoji?.animated),
  };
}

export function setBuilderButtonEmoji(rows, key, emoji) {
  const next = normalizeRows(rows);
  const target = buttonAt(next, key);
  if (!target) return next;

  const normalized = normalizeCustomEmoji(emoji);
  if (normalized) target.component.emoji = normalized;
  else delete target.component.emoji;
  return next;
}

function lastButtonKey(rows) {
  const next = normalizeRows(rows);
  for (let rowIndex = next.length - 1; rowIndex >= 0; rowIndex -= 1) {
    for (let componentIndex = next[rowIndex].components.length - 1; componentIndex >= 0; componentIndex -= 1) {
      if (Number(next[rowIndex].components[componentIndex]?.type) === BUTTON_COMPONENT_TYPE) {
        return `${rowIndex}:${componentIndex}`;
      }
    }
  }
  return null;
}

function encodedButtonKey(key) {
  return String(key || '').replace(':', '.');
}

function decodedButtonKey(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)$/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function buttonEmojiText(component) {
  const emoji = component?.emoji;
  if (!emoji?.id) return '';
  return `<${emoji.animated ? 'a' : ''}:${emoji.name || 'emoji'}:${emoji.id}>`;
}

async function getSharedEmojiGuilds(client, userId) {
  const shared = [];
  for (const guild of client?.guilds?.cache?.values?.() || []) {
    const member = guild.members?.cache?.get?.(userId)
      || await guild.members?.fetch?.(userId).catch(() => null);
    if (member) shared.push(guild);
  }
  return shared.sort((left, right) => String(left.name || '').localeCompare(String(right.name || '')));
}

function buildButtonEmojiServerPayload(guilds, key) {
  const visible = guilds.slice(0, BUTTON_EMOJI_GUILD_LIMIT);
  const components = [];
  const safeKey = encodedButtonKey(key);

  for (let offset = 0; offset < visible.length && components.length < 5; offset += 25) {
    const segment = visible.slice(offset, offset + 25);
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`embed_button_emoji_server:${safeKey}:${Math.floor(offset / 25)}`)
          .setPlaceholder(`Servers ${offset + 1}-${offset + segment.length} of ${guilds.length}`)
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(...segment.map(guild =>
            new StringSelectMenuOptionBuilder()
              .setLabel(String(guild.name || 'Discord server').slice(0, 100))
              .setDescription(`${guild.memberCount || 0} members • ${guild.id}`.slice(0, 100))
              .setValue(String(guild.id))
          )),
      ),
    );
  }

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Button custom emoji')
        .setDescription([
          'Choose a Discord server that both you and Cloudy are in.',
          '',
          `**Shared servers:** ${guilds.length}`,
          guilds.length > BUTTON_EMOJI_GUILD_LIMIT
            ? `Showing the first ${BUTTON_EMOJI_GUILD_LIMIT} servers.`
            : null,
        ].filter(Boolean).join('\n'))
        .setColor(0xFFFFFF),
    ],
    components,
  };
}

export function buildButtonEmojiPagePayload(guild, emojis, key, page = 0) {
  const values = [...(emojis?.values?.() || [])]
    .sort((left, right) => String(left?.name || '').localeCompare(String(right?.name || '')));
  const totalPages = Math.max(1, Math.ceil(values.length / BUTTON_EMOJIS_PER_PAGE));
  const safePage = Math.max(0, Math.min(Number(page) || 0, totalPages - 1));
  const start = safePage * BUTTON_EMOJIS_PER_PAGE;
  const pageValues = values.slice(start, start + BUTTON_EMOJIS_PER_PAGE);
  const safeKey = encodedButtonKey(key);
  const components = [];

  for (let offset = 0; offset < pageValues.length; offset += BUTTON_EMOJIS_PER_SELECT) {
    const segment = pageValues.slice(offset, offset + BUTTON_EMOJIS_PER_SELECT);
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`embed_button_emoji_pick:${guild.id}:${safeKey}:${safePage}:${Math.floor(offset / BUTTON_EMOJIS_PER_SELECT)}`)
          .setPlaceholder(`Emojis ${start + offset + 1}-${start + offset + segment.length} of ${values.length}`)
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(...segment.map(emoji => {
            const option = new StringSelectMenuOptionBuilder()
              .setLabel(`:${emoji.name || 'emoji'}:`.slice(0, 100))
              .setDescription('Use this custom emoji on the selected button')
              .setValue(String(emoji.id));
            if (emoji?.id) {
              option.setEmoji({
                id: String(emoji.id),
                name: String(emoji.name || 'emoji'),
                animated: Boolean(emoji.animated),
              });
            }
            return option;
          })),
      ),
    );
  }

  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`embed_button_emoji_prev:${guild.id}:${safeKey}:${safePage}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage <= 0),
      new ButtonBuilder()
        .setCustomId(`embed_button_emoji_remove:${safeKey}`)
        .setLabel('Remove emoji')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`embed_button_emoji_back:${safeKey}`)
        .setLabel('Servers')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`embed_button_emoji_next:${guild.id}:${safeKey}:${safePage}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1),
    ),
  );

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`Button emoji • ${guild.name}`.slice(0, 256))
        .setDescription(values.length
          ? `Choose an emoji for the selected button. Page ${safePage + 1}/${totalPages} • ${values.length} custom emojis.`
          : 'This server has no custom emojis available to Cloudy.')
        .setColor(0xFFFFFF),
    ],
    components,
  };
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

function managerPayload(state) {
  const rows = getBuilderMessageComponents(state);
  const buttons = listButtons(rows);
  const lines = buttons.length
    ? buttons.map((item, index) => {
      const action = item.component.custom_id
        ? `Action: \`${String(item.component.custom_id).slice(0, 45)}${String(item.component.custom_id).length > 45 ? '…' : ''}\``
        : item.component.url
          ? 'Action: Link'
          : 'Action: Discord-managed';
      return `**${index + 1}. ${buttonLabel(item.component, index)}** — ${buttonStyleName(item.component.style)}\n${action}`;
    })
    : ['No buttons are attached to this message yet.'];

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('embed_button_add_response')
        .setLabel('Add response button')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  const editable = buttons.filter(item => Number(item.component.style) !== ButtonStyle.Premium).slice(0, 25);
  if (editable.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('embed_button_edit_select')
          .setPlaceholder('Edit button name / color')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(...editable.map((item, index) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(buttonLabel(item.component, index))
              .setDescription(`${buttonStyleName(item.component.style)} • action stays unchanged`.slice(0, 100))
              .setValue(item.key)
          )),
      ),
    );
  }

  if (editable.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('embed_button_emoji_target')
          .setPlaceholder('Add custom emoji to button')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(...editable.map((item, index) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(buttonLabel(item.component, index))
              .setDescription(
                (buttonEmojiText(item.component)
                  ? `Current emoji: ${buttonEmojiText(item.component)}`
                  : 'Choose custom emoji').slice(0, 100)
              )
              .setValue(item.key)
          )),
      ),
    );
  }

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Embed buttons')
        .setDescription([
          ...lines,
          '',
          'Changing a button name/color never changes its existing action or custom ID.',
          'New colored response buttons send an ephemeral response. New link buttons open a URL.',
        ].join('\n').slice(0, 4096))
        .setColor(0xFFFFFF),
    ],
    components,
  };
}

export function buildBuilderButtonManagerPayload(state) {
  return managerPayload(state);
}

async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
  // Only one Add-response modal may own a submit for this builder session.
  // Re-opening the editor invalidates every older waiter immediately.
  const modalGeneration = (state.buttonModalGeneration || 0) + 1;
  state.buttonModalGeneration = modalGeneration;
  const modalId = `embed_button_add_response_modal:${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Add response button')
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
          .setCustomId('button_style')
          .setLabel('Color: blue, gray, green or red')
          .setStyle(TextInputStyle.Short)
          .setValue('gray')
          .setMaxLength(12)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_response')
          .setLabel('Ephemeral response when clicked')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(2000)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_url')
          .setLabel('Link (optional)')
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
    if (!submitted.replied && !submitted.deferred) await submitted.deferUpdate().catch(() => {});
    return;
  }

  // Redis-backed idempotency: even if Discord or an old collector delivers the
  // same modal submit twice, only one handler is allowed to create a button.
  const ownsSubmit = await redisAcquireLock(`embed-button-submit:${submitted.id}`, 5 * 60_000);
  if (!ownsSubmit) {
    if (!submitted.replied && !submitted.deferred) await submitted.deferUpdate().catch(() => {});
    return;
  }

  const label = submitted.fields.getTextInputValue('button_label').trim().slice(0, 80);
  const style = parseButtonStyle(submitted.fields.getTextInputValue('button_style'), ButtonStyle.Secondary);
  const responseText = submitted.fields.getTextInputValue('button_response').trim().slice(0, 2000);
  const url = submitted.fields.getTextInputValue('button_url').trim();
  if (modalSubmissions.has(submitted.id)) return;
  modalSubmissions.add(submitted.id);
  setTimeout(() => modalSubmissions.delete(submitted.id), 5 * 60_000).unref?.();
  if (url && !/^https?:\/\//i.test(url)) {
    await submitted.reply({ content: 'The optional link must start with http:// or https://.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (style === ButtonStyle.Link) {
    await submitted.reply({ content: 'Use Add link button for link buttons.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const actionId = randomUUID().replaceAll('-', '').slice(0, 24);
  if (!url) {
    const saved = await setInDb(actionKey(submitted.guildId, actionId), { responseText, deleteAfterMs: DEFAULT_RESPONSE_DELETE_MS, updatedAt: new Date().toISOString() });
    if (!saved) {
      await submitted.reply({ content: 'Could not save the button action. Nothing was added.', flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
  }

  const next = appendButton(state.componentRows, url ? {
    type: BUTTON_COMPONENT_TYPE,
    style: ButtonStyle.Link,
    label,
    url: url.slice(0, 512),
  } : {
    type: BUTTON_COMPONENT_TYPE,
    style,
    label,
    custom_id: `${ACTION_CUSTOM_ID}:${actionId}`,
  });
  // One unique modal submit commits exactly one button. Opening, closing or
  // switching editor options never mutates componentRows.
  if (!next) {
    await submitted.reply({ content: 'Discord allows at most 5 component rows. Remove/reuse a row before adding another button.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  state.componentRows = next;
  state.componentsDirty = true;
  await submitted.deferUpdate().catch(() => {});
  await panelMessage.edit(managerPayload(state)).catch(() => {});
  await refreshBuilder(submitted, state).catch(() => {});
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
  state.componentsDirty = true;
  await submitted.deferUpdate().catch(() => {});
  await panelMessage.edit(managerPayload(state)).catch(() => {});
  await refreshBuilder(submitted, state).catch(() => {});
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
}

async function openButtonEmojiBrowser(componentInteraction, state, key, refreshBuilder, panelMessage) {
  const target = buttonAt(state.componentRows, key);
  if (!target) {
    if (!componentInteraction.replied && !componentInteraction.deferred) {
      await componentInteraction.deferUpdate().catch(() => {});
    }
    return;
  }

  if (!componentInteraction.replied && !componentInteraction.deferred) {
    await componentInteraction.deferUpdate().catch(() => {});
  }

  const sharedGuilds = await getSharedEmojiGuilds(componentInteraction.client, componentInteraction.user.id);
  if (!sharedGuilds.length) {
    await componentInteraction.followUp({
      content: 'Cloudy could not find a shared server with custom emojis.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return;
  }

  const browserMessage = await componentInteraction.followUp({
    ...buildButtonEmojiServerPayload(sharedGuilds, key),
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  }).catch(() => null);
  if (!browserMessage) return;

  if (!state.builderChildMessages) state.builderChildMessages = new Map();
  state.builderChildMessages.set(browserMessage.id, browserMessage);

  let currentGuild = null;
  let currentEmojis = null;
  let currentPage = 0;

  const collector = browserMessage.createMessageComponentCollector({
    filter: interaction => interaction.user.id === componentInteraction.user.id,
    idle: EDITOR_IDLE_MS,
  });

  collector.on('end', async () => {
    state.builderChildMessages?.delete(browserMessage.id);
    await deletePrivateBuilderMessage(componentInteraction, browserMessage.id, browserMessage);
  });

  collector.on('collect', interaction => {
    void (async () => {
      try {
        const customId = String(interaction.customId || '');

        if (customId.startsWith('embed_button_emoji_server:')) {
          const guildId = interaction.values?.[0];
          currentGuild = guildId ? interaction.client.guilds.cache.get(guildId) : null;
          if (!currentGuild) {
            await interaction.deferUpdate().catch(() => {});
            return;
          }
          currentEmojis = await currentGuild.emojis.fetch().catch(() => currentGuild.emojis.cache);
          currentPage = 0;
          await interaction.update(buildButtonEmojiPagePayload(currentGuild, currentEmojis, key, currentPage));
          return;
        }

        if (customId.startsWith('embed_button_emoji_prev:') || customId.startsWith('embed_button_emoji_next:')) {
          if (!currentGuild || !currentEmojis) {
            await interaction.deferUpdate().catch(() => {});
            return;
          }
          const parts = customId.split(':');
          const page = Number(parts.at(-1)) || 0;
          currentPage = customId.startsWith('embed_button_emoji_prev:')
            ? Math.max(0, page - 1)
            : page + 1;
          await interaction.update(buildButtonEmojiPagePayload(currentGuild, currentEmojis, key, currentPage));
          return;
        }

        if (customId.startsWith('embed_button_emoji_back:')) {
          currentGuild = null;
          currentEmojis = null;
          currentPage = 0;
          await interaction.update(buildButtonEmojiServerPayload(sharedGuilds, key));
          return;
        }

        if (customId.startsWith('embed_button_emoji_remove:')) {
          state.componentRows = setBuilderButtonEmoji(state.componentRows, key, null);
          state.componentsDirty = true;
          await interaction.deferUpdate().catch(() => {});
          await panelMessage.edit(managerPayload(state)).catch(() => {});
          await refreshBuilder(interaction, state).catch(() => {});
          await syncBuilderButtonPreview(interaction, state).catch(() => {});
          return;
        }

        if (customId.startsWith('embed_button_emoji_pick:')) {
          const emojiId = interaction.values?.[0];
          const emoji = emojiId && currentEmojis ? currentEmojis.get(emojiId) : null;
          if (!emoji) {
            await interaction.deferUpdate().catch(() => {});
            return;
          }

          state.componentRows = setBuilderButtonEmoji(state.componentRows, key, emoji);
          state.componentsDirty = true;
          await interaction.deferUpdate().catch(() => {});
          await panelMessage.edit(managerPayload(state)).catch(() => {});
          await refreshBuilder(interaction, state).catch(() => {});
          await syncBuilderButtonPreview(interaction, state).catch(() => {});
          return;
        }

        await interaction.deferUpdate().catch(() => {});
      } catch (error) {
        logger.error('Button custom emoji browser failed:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.deferUpdate().catch(() => {});
        }
      }
    })();
  });
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
        if (componentInteraction.customId === 'embed_button_add_response') {
          await showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }
        if (componentInteraction.customId === 'embed_button_add_link') {
          await showAddLinkModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }
        if (componentInteraction.customId === 'embed_button_edit_select') {
          await showEditButtonModal(
            componentInteraction,
            state,
            componentInteraction.values?.[0],
            refreshBuilder,
            panelMessage,
          );
          return;
        }
        if (componentInteraction.customId === 'embed_button_emoji_target') {
          await openButtonEmojiBrowser(
            componentInteraction,
            state,
            componentInteraction.values?.[0],
            refreshBuilder,
            panelMessage,
          );
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
