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
    deleteAfterMs: Number(source.deleteAfterMs) === 10_000 ? 10_000 : null,
    updatedAt: new Date().toISOString(),
  });
}`;
    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  // Compact editor: one Add response button. Link is an optional action inside it.
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
          'Add a button and choose its function in one place. Response, visibility and URL are optional.',
          'Supported functions: private response, public response, 10-second response, link or disabled.',
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

function normalizeButtonFunction(value, responseText, url) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\\s+/g, ' ');

  if (!raw) {
    if (url && responseText) return 'ambiguous';
    if (url) return 'link';
    if (responseText) return 'private';
    return 'disabled';
  }

  const aliases = new Map([
    ['private', 'private'],
    ['ephemeral', 'private'],
    ['privé', 'private'],
    ['private 10s', 'private10'],
    ['private10', 'private10'],
    ['ephemeral 10s', 'private10'],
    ['public', 'public'],
    ['publiek', 'public'],
    ['public 10s', 'public10'],
    ['public10', 'public10'],
    ['link', 'link'],
    ['url', 'link'],
    ['disabled', 'disabled'],
    ['off', 'disabled'],
  ]);
  return aliases.get(raw) || 'invalid';
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

  // One professional modal handles response/link/disabled actions.
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
          .setCustomId('button_function')
          .setLabel('Function (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('private, public, private 10s, public 10s, link, disabled')
          .setMaxLength(24)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_response')
          .setLabel('Response message (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(4000)
          .setRequired(false),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('button_url')
          .setLabel('URL (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://example.com')
          .setMaxLength(512)
          .setRequired(false),
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
  const responseText = submitted.fields.getTextInputValue('button_response').trim().slice(0, 4000);
  const url = submitted.fields.getTextInputValue('button_url').trim().slice(0, 512);
  const action = normalizeButtonFunction(
    submitted.fields.getTextInputValue('button_function'),
    responseText,
    url,
  );

  if (action === 'ambiguous') {
    await replyButtonEditorError(
      submitted,
      'Choose a function when both a response message and URL are filled in.',
    );
    return;
  }
  if (action === 'invalid') {
    await replyButtonEditorError(
      submitted,
      'Use private, public, private 10s, public 10s, link or disabled.',
    );
    return;
  }

  let component;
  if (action === 'link') {
    if (!/^https?:\\/\\//i.test(url)) {
      await replyButtonEditorError(submitted, 'A link button needs a valid http:// or https:// URL.');
      return;
    }
    component = {
      type: BUTTON_COMPONENT_TYPE,
      style: ButtonStyle.Link,
      label,
      url,
    };
  } else if (action === 'disabled') {
    component = {
      type: BUTTON_COMPONENT_TYPE,
      style: style === ButtonStyle.Link ? ButtonStyle.Secondary : style,
      label,
      custom_id: 'cloudy_builder_disabled:' + randomUUID().replaceAll('-', '').slice(0, 24),
      disabled: true,
    };
  } else {
    if (!responseText) {
      await replyButtonEditorError(submitted, 'A response button needs a response message.');
      return;
    }

    const actionId = randomUUID().replaceAll('-', '').slice(0, 24);
    const saved = await saveBuilderButtonAction(submitted.guildId, actionId, {
      responseText,
      visibility: action.startsWith('public') ? 'public' : 'private',
      deleteAfterMs: action.endsWith('10') ? 10_000 : null,
    });
    if (!saved) {
      await replyButtonEditorError(submitted, 'Could not save the button action. Nothing was added.');
      return;
    }

    component = {
      type: BUTTON_COMPONENT_TYPE,
      style: style === ButtonStyle.Link ? ButtonStyle.Secondary : style,
      label,
      custom_id: ACTION_CUSTOM_ID + ':' + actionId,
    };
  }

  const next = appendButton(state.componentRows, component);
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
}`;
    text = text.slice(0, start) + replacement + text.slice(end);
  }

  // Remove the separate Add link implementation entirely.
  {
    const start = text.indexOf('async function showAddLinkModal(');
    const end = text.indexOf('\nasync function showEditButtonModal(', start);
    if (start >= 0 && end > start) {
      text = text.slice(0, start) + text.slice(end + 1);
    }
  }

  // Remove the obsolete collector branch if an earlier patch left it behind.
  text = text.replace(
    /\n\s*if \(componentInteraction\.customId === 'embed_button_add_link'\) \{[\s\S]*?\n\s*\}\n/,
    '\n',
  );

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

console.log('[BUILDER_PRO_BUTTONS] Professional all-in-one button flow enabled.');
