import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_BUTTON_FIELDS] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_BUTTON_FIELDS] ${path}: patched`);
}

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  text = text.replace(
    'deleteAfterMs: Number(source.deleteAfterMs) === 10_000 ? 10_000 : null,',
    `deleteAfterMs: Number.isFinite(Number(source.deleteAfterMs))
      && Number(source.deleteAfterMs) >= 1_000
      && Number(source.deleteAfterMs) <= 15 * 60_000
        ? Number(source.deleteAfterMs)
        : null,`,
  );

  {
    const start = text.indexOf('function managerPayload(state) {');
    const end = text.indexOf('\n}\n\nfunction normalizeButtonFunction', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_BUTTON_FIELDS] manager payload block missing');

    const replacement = `function managerPayload(state) {
  const rows = getBuilderMessageComponents(state);
  const buttons = listButtons(rows);
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

  return {
    embeds: [
      new EmbedBuilder()
        .setTitle('Embed buttons')
        .setDescription([
          ...lines,
          '',
          'Response buttons use separate fields for visibility and duration.',
          'Link and disabled buttons have their own setup so no function code needs to be typed.',
        ].join('\\n').slice(0, 4096))
        .setColor(0xFFFFFF),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('embed_button_add_response')
          .setLabel('Add response button')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('embed_button_add_link')
          .setLabel('Add link button')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('embed_button_add_disabled')
          .setLabel('Add disabled button')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}`;

    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  {
    const start = text.indexOf('function normalizeButtonFunction(');
    const end = text.indexOf('\nasync function replyButtonEditorError', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_BUTTON_FIELDS] function parser block missing');

    const replacement = `function normalizeButtonVisibility(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'private' || raw === 'ephemeral' || raw === 'privé') return 'private';
  if (raw === 'public' || raw === 'publiek') return 'public';
  return null;
}

function parseButtonDuration(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\\s+/g, '');
  if (!raw || ['none', 'off', 'keep', 'stay', 'stays', 'permanent'].includes(raw)) {
    return { valid: true, ms: null };
  }

  const match = raw.match(/^(\\d{1,3})(s|sec|secs|second|seconds|m|min|mins|minute|minutes)$/);
  if (!match) return { valid: false, ms: null };

  const amount = Number(match[1]);
  const unit = match[2].startsWith('m') ? 60_000 : 1_000;
  const ms = amount * unit;
  if (!Number.isFinite(ms) || ms < 1_000 || ms > 15 * 60_000) {
    return { valid: false, ms: null };
  }
  return { valid: true, ms };
}
`;

    text = text.slice(0, start) + replacement + text.slice(end);
  }

  {
    const start = text.indexOf('async function showAddResponseModal(');
    const end = text.indexOf('\nasync function showEditButtonModal(', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_BUTTON_FIELDS] response modal block missing');

    const replacement = `async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
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
          .setLabel('Color (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('gray, blue, green or red')
          .setMaxLength(12)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_visibility')
          .setLabel('Visibility (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('private or public • default: private')
          .setMaxLength(12)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_duration')
          .setLabel('Duration (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('10s, 30s, 1m, 5m • blank = stays')
          .setMaxLength(16)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_response')
          .setLabel('Response message')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(4000)
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
  const style = parseButtonStyle(
    submitted.fields.getTextInputValue('button_style'),
    ButtonStyle.Secondary,
  );
  const visibility = normalizeButtonVisibility(
    submitted.fields.getTextInputValue('button_visibility'),
  );
  const duration = parseButtonDuration(
    submitted.fields.getTextInputValue('button_duration'),
  );
  const responseText = submitted.fields.getTextInputValue('button_response').trim().slice(0, 4000);

  if (!visibility) {
    await replyButtonEditorError(submitted, 'Visibility must be private or public.');
    return;
  }
  if (!duration.valid) {
    await replyButtonEditorError(
      submitted,
      'Duration must be blank or a time such as 10s, 30s, 1m, 5m or 15m.',
    );
    return;
  }
  if (!responseText) {
    await replyButtonEditorError(submitted, 'A response button needs a response message.');
    return;
  }

  const actionId = randomUUID().replaceAll('-', '').slice(0, 24);
  const saved = await saveBuilderButtonAction(submitted.guildId, actionId, {
    responseText,
    visibility,
    deleteAfterMs: duration.ms,
  });
  if (!saved) {
    await replyButtonEditorError(submitted, 'Could not save the button action. Nothing was added.');
    return;
  }

  const next = appendButton(state.componentRows, {
    type: BUTTON_COMPONENT_TYPE,
    style: style === ButtonStyle.Link ? ButtonStyle.Secondary : style,
    label,
    custom_id: ACTION_CUSTOM_ID + ':' + actionId,
  });
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
  const url = submitted.fields.getTextInputValue('button_url').trim().slice(0, 512);
  if (!/^https?:\\/\\//i.test(url)) {
    await replyButtonEditorError(submitted, 'The URL must start with http:// or https://.');
    return;
  }

  const next = appendButton(state.componentRows, {
    type: BUTTON_COMPONENT_TYPE,
    style: ButtonStyle.Link,
    label,
    url,
  });
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

async function showAddDisabledModal(componentInteraction, state, refreshBuilder, panelMessage) {
  const modal = new ModalBuilder()
    .setCustomId('embed_button_add_disabled_modal')
    .setTitle('Add disabled button')
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
          .setLabel('Color (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('gray, blue, green or red')
          .setMaxLength(12)
          .setRequired(false),
      ),
    );

  await componentInteraction.showModal(modal);
  const submitted = await componentInteraction.awaitModalSubmit({
    filter: interaction => interaction.customId === 'embed_button_add_disabled_modal'
      && interaction.user.id === componentInteraction.user.id,
    time: 120_000,
  }).catch(() => null);
  if (!submitted) return;

  const label = submitted.fields.getTextInputValue('button_label').trim().slice(0, 80);
  const style = parseButtonStyle(
    submitted.fields.getTextInputValue('button_style'),
    ButtonStyle.Secondary,
  );

  const next = appendButton(state.componentRows, {
    type: BUTTON_COMPONENT_TYPE,
    style: style === ButtonStyle.Link ? ButtonStyle.Secondary : style,
    label,
    custom_id: 'cloudy_builder_disabled:' + randomUUID().replaceAll('-', '').slice(0, 24),
    disabled: true,
  });
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
`;

    text = text.slice(0, start) + replacement + text.slice(end);
  }

  {
    const responseCase = `        if (componentInteraction.customId === 'embed_button_add_response') {
          await showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }`;
    if (!text.includes(responseCase)) {
      throw new Error('[BUILDER_BUTTON_FIELDS] response collector branch missing');
    }

    const expanded = responseCase + `
        if (componentInteraction.customId === 'embed_button_add_link') {
          await showAddLinkModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }
        if (componentInteraction.customId === 'embed_button_add_disabled') {
          await showAddDisabledModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }`;

    text = text.replace(responseCase, expanded);
  }

  return text;
});

patchFile('src/interactions/buttons/cloudyBuilderAction.js', text => {
  const before = `function scheduleReplyDeletion(interaction, delayMs) {
  if (Number(delayMs) !== 10_000) return;
  const timer = setTimeout(() => {
    void interaction.deleteReply().catch(() => {});
  }, 10_000);
  timer.unref?.();
}`;

  const after = `function scheduleReplyDeletion(interaction, delayMs) {
  const ms = Number(delayMs);
  if (!Number.isFinite(ms) || ms < 1_000 || ms > 15 * 60_000) return;
  const timer = setTimeout(() => {
    void interaction.deleteReply().catch(() => {});
  }, ms);
  timer.unref?.();
}`;

  if (!text.includes(before)) {
    throw new Error('[BUILDER_BUTTON_FIELDS] reply deletion scheduler missing');
  }
  return text.replace(before, after);
});

console.log('[BUILDER_BUTTON_FIELDS] Button setup now uses explicit response fields with a clear duration field.');
