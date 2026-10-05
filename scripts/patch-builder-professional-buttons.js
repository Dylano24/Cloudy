import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_PRO_BUTTONS] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_PRO_BUTTONS] ${path}: patched`);
}

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  // Store richer action metadata while keeping old string callers/backward compatibility.
  {
    const start = text.indexOf('export async function saveBuilderButtonAction(');
    const end = text.indexOf('\n}\n\nexport async function getBuilderButtonAction', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_PRO_BUTTONS] action storage block missing');
    const replacement = `export async function saveBuilderButtonAction(guildId, actionId, action) {
  if (!guildId || !actionId) return false;
  const source = typeof action === 'string'
    ? { responseText: action }
    : (action && typeof action === 'object' ? action : {});

  return setInDb(actionKey(guildId, actionId), {
    responseText: String(source.responseText || '').slice(0, 4000),
    visibility: source.visibility === 'public' ? 'public' : 'private',
    deleteAfterMs: Number.isFinite(Number(source.deleteAfterMs))
      && Number(source.deleteAfterMs) >= 1_000
      && Number(source.deleteAfterMs) <= 15 * 60_000
        ? Number(source.deleteAfterMs)
        : null,
    updatedAt: new Date().toISOString(),
  });
}`;
    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  // Keep each button behavior explicit instead of overloading one Function field.
  {
    const start = text.indexOf('function managerPayload(state) {');
    const end = text.indexOf('\n}\n\nasync function showAddResponseModal', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_PRO_BUTTONS] manager payload block missing');
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
          'Add a response or link button from the same form.',
        ].join('\\n').slice(0, 4096))
        .setColor(0xFFFFFF),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('embed_button_add_response')
          .setLabel('Add response button')
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

async function replyButtonEditorError(interaction, content) {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
  const timer = setTimeout(() => {
    void interaction.deleteReply().catch(() => {});
  }, 10_000);
  timer.unref?.();
}`;
    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  // Response buttons get explicit visibility and duration fields.
  {
    const start = text.indexOf('async function showAddResponseModal(');
    const end = text.indexOf('\nasync function showAddLinkModal(', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_PRO_BUTTONS] response modal block missing');
    const replacement = `async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
  const modal = new ModalBuilder()
    .setCustomId('embed_button_add_response_modal')
    .setTitle('Add response button')
    .addComponents(
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
          .setPlaceholder('10s, 30s, 1m, 5m • blank stays')
          .setMaxLength(16)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_label')
          .setLabel('Button / link name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('This becomes the button or link name')
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_action')
          .setLabel('Response message / add link')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Response text or https://example.com')
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
  const actionValue = submitted.fields.getTextInputValue('button_action').trim();
  const isLink = /^https?:\\/\\//i.test(actionValue);
  const responseText = isLink ? '' : actionValue.slice(0, 4000);
  const url = isLink ? actionValue.slice(0, 512) : '';

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
  if (!actionValue) {
    await replyButtonEditorError(submitted, 'Add a response message or a link.');
    return;
  }

  let next;
  if (url) {
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
}`;
    text = text.slice(0, start) + replacement + text.slice(end);
  }

  const responseCase = `        if (componentInteraction.customId === 'embed_button_add_response') {
          await showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }`;
  const linkCase = `        if (componentInteraction.customId === 'embed_button_add_link') {
          await showAddLinkModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }`;
  const disabledCase = `        if (componentInteraction.customId === 'embed_button_add_disabled') {
          await showAddDisabledModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }`;

  if (!text.includes(responseCase)) {
    throw new Error('[BUILDER_PRO_BUTTONS] response collector branch missing');
  }
  text = text.replace('\n' + linkCase, '');
  text = text.replace('\n' + disabledCase, '');

  // The main Builder now owns the live button preview. Remove any old child preview.
  {
    const start = text.indexOf('export async function syncBuilderButtonPreview(');
    const end = text.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_PRO_BUTTONS] sync preview helper missing');
    const replacement = `export async function syncBuilderButtonPreview(interaction, state) {
  const oldId = state?.activeButtonPreviewMessageId
    ? String(state.activeButtonPreviewMessageId)
    : null;
  if (oldId) {
    await deletePrivateBuilderMessage(interaction, oldId, state.activeButtonPreviewMessage);
  }
  state.activeButtonPreviewMessageId = null;
  state.activeButtonPreviewMessage = null;
  return null;
}`;
    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  const pattern = /function buildControls\(state\) \{[\s\S]*?\n\}\n\nfunction getPreviewUpdateQueue/;
  if (!pattern.test(text)) throw new Error('[BUILDER_PRO_BUTTONS] buildControls block missing');

  text = text.replace(pattern, `function buildControls(state) {
    const sourceHasLogo = Boolean(state.modifyTarget?.sourceEmbedData?.thumbnail?.url);
    const hasLogo = !state.removeExistingLogo && (state.showLogo || sourceHasLogo);

    const buttonPreviewComponents = getBuilderMessageComponents(state)
        .flatMap(row => Array.isArray(row?.components) ? row.components : [])
        .filter(component => Number(component?.type) === 2)
        .slice(0, 5);
    const previewRows = buttonPreviewComponents.length
        ? [{ type: 1, components: buttonPreviewComponents }]
        : [];

    const titleRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setURL(state.contentEditorUrl)
            .setLabel('Edit title & message')
            .setStyle(ButtonStyle.Link)
            .setEmoji('✍🏼'),
        new ButtonBuilder()
            .setCustomId('simple_embed_logo')
            .setLabel('Add logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('☁️')
            .setDisabled(state.showLogo && !state.removeExistingLogo),
        new ButtonBuilder()
            .setCustomId('simple_embed_remove_logo')
            .setLabel('Remove logo')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🗑️')
            .setDisabled(!hasLogo),
    );

    const contentRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_media')
            .setLabel('Add media')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📷'),
        new ButtonBuilder()
            .setCustomId('simple_embed_clear_media')
            .setLabel('Remove media')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('❌')
            .setDisabled(!hasMedia(state)),
        new ButtonBuilder()
            .setCustomId('simple_embed_footer')
            .setLabel('Edit footer')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📝'),
        new ButtonBuilder()
            .setURL(state.colorPickerUrl)
            .setLabel('Set side color')
            .setStyle(ButtonStyle.Link)
            .setEmoji('🎨'),
    );

    const editRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_buttons')
            .setLabel('Add buttons')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔘'),
        new ButtonBuilder()
            .setCustomId('simple_embed_remove_buttons')
            .setLabel('Remove buttons')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⛔'),
        new ButtonBuilder()
            .setCustomId('simple_embed_modify')
            .setLabel('Modify embed')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🛠️'),
        new ButtonBuilder()
            .setCustomId('simple_embed_close')
            .setLabel('Close message')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('✖️'),
    );

    const saveRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('simple_embed_post')
            .setLabel(state.pendingBuilderDelete
                ? 'Save deletion'
                : (state.modifyTarget ? 'Save changes' : 'Post message'))
            .setStyle(state.pendingBuilderDelete ? ButtonStyle.Danger : ButtonStyle.Success)
            .setEmoji(state.pendingBuilderDelete ? '🗑️' : (state.modifyTarget ? '💾' : '📤')),
        new ButtonBuilder()
            .setCustomId('simple_embed_delete_from_builder')
            .setLabel(state.pendingBuilderDelete ? 'Cancel delete' : 'Delete from builder')
            .setStyle(state.pendingBuilderDelete ? ButtonStyle.Secondary : ButtonStyle.Danger)
            .setEmoji(state.pendingBuilderDelete ? '↩️' : '🗑️')
            .setDisabled(!state.modifyTarget),
        new ButtonBuilder()
            .setCustomId('simple_embed_reset')
            .setLabel('Reset')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('♻️'),
    );

    return [...previewRows, titleRow, contentRow, editRow, saveRow].slice(0, 5);
}

function getPreviewUpdateQueue`);

  return text;
});

console.log('[BUILDER_PRO_BUTTONS] Professional explicit button fields enabled.');
