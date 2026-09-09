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

const ACTION_PREFIX = 'cloudy:builder-button-action:';
const ACTION_CUSTOM_ID = 'cloudy_builder_action';
const BUTTON_COMPONENT_TYPE = 2;
const ACTION_ROW_TYPE = 1;
const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const EDITOR_IDLE_MS = 5 * 60_000;

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

export function getBuilderMessageComponents(state) {
  return normalizeRows(state?.componentRows || []);
}

export function countBuilderButtons(state) {
  return getBuilderMessageComponents(state).reduce(
    (total, row) => total + row.components.filter(component => Number(component?.type) === BUTTON_COMPONENT_TYPE).length,
    0,
  );
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

async function ensureRowsLoaded(buttonInteraction, state) {
  const targetId = state?.modifyTarget?.messageId ? String(state.modifyTarget.messageId) : 'new';
  if (state.componentRowsSourceMessageId === targetId && Array.isArray(state.componentRows)) return;

  state.componentRows = [];
  state.componentRowsSourceMessageId = targetId;
  state.componentsDirty = false;

  if (targetId === 'new') return;

  const target = state.modifyTarget;
  const cached = target?.cachedMessage && String(target.cachedMessage.id) === targetId
    ? target.cachedMessage
    : null;
  let message = cached;

  if (!message) {
    const backingChannelId = String(target?.backingChannelId || target?.channelId || '');
    const channel = buttonInteraction.guild?.channels?.cache?.get(backingChannelId)
      || await buttonInteraction.guild?.channels?.fetch?.(backingChannelId).catch(() => null);
    message = await channel?.messages?.fetch?.(targetId).catch(() => null);
  }

  state.componentRows = componentRowsFromMessage(message);
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
      new ButtonBuilder()
        .setCustomId('embed_button_add_link')
        .setLabel('Add link button')
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

async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
  const modal = new ModalBuilder()
    .setCustomId('embed_button_add_response_modal')
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
    );

  await componentInteraction.showModal(modal);
  const submitted = await componentInteraction.awaitModalSubmit({
    filter: interaction => interaction.customId === 'embed_button_add_response_modal'
      && interaction.user.id === componentInteraction.user.id,
    time: 120_000,
  }).catch(() => null);
  if (!submitted) return;

  const label = submitted.fields.getTextInputValue('button_label').trim().slice(0, 80);
  const style = parseButtonStyle(submitted.fields.getTextInputValue('button_style'), ButtonStyle.Secondary);
  const responseText = submitted.fields.getTextInputValue('button_response').trim().slice(0, 2000);
  if (style === ButtonStyle.Link) {
    await submitted.reply({ content: 'Use Add link button for link buttons.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const actionId = randomUUID().replaceAll('-', '').slice(0, 24);
  const saved = await saveBuilderButtonAction(submitted.guildId, actionId, responseText);
  if (!saved) {
    await submitted.reply({ content: 'Could not save the button action. Nothing was added.', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const next = appendButton(state.componentRows, {
    type: BUTTON_COMPONENT_TYPE,
    style,
    label,
    custom_id: `${ACTION_CUSTOM_ID}:${actionId}`,
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

export async function openEmbedButtonEditor(buttonInteraction, state, refreshBuilder) {
  await ensureRowsLoaded(buttonInteraction, state);
  await buttonInteraction.deferUpdate().catch(() => {});

  const panelMessage = await buttonInteraction.followUp({
    ...managerPayload(state),
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  }).catch(() => null);
  if (!panelMessage) return;

  const collector = panelMessage.createMessageComponentCollector({
    filter: interaction => interaction.user.id === buttonInteraction.user.id,
    idle: EDITOR_IDLE_MS,
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
