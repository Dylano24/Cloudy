import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_LIVE_POLISH] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after, 'utf8');
  console.log(`[BUILDER_LIVE_POLISH] ${path}: patched`);
}

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  const marker = 'BUILDER_LIVE_POLISH_V1';
  if (text.includes(marker)) return text;

  {
    const start = text.indexOf('function managerPayload(state) {');
    const end = text.indexOf('\n}\n\nfunction normalizeButtonVisibility', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_LIVE_POLISH] manager payload block missing');
    }

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
          'Add a response button or link from one place.',
        ].join('\\n').slice(0, 4096))
        .setColor(0xFFFFFF),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('embed_button_add_response')
          .setLabel('Add button')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}`;

    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  {
    const start = text.indexOf('async function showAddResponseModal(');
    const end = text.indexOf('\nasync function showAddLinkModal(', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_LIVE_POLISH] add button modal block missing');
    }

    const replacement = `// BUILDER_LIVE_POLISH_V1
async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
  const modal = new ModalBuilder()
    .setCustomId('embed_button_add_response_modal')
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
          .setCustomId('button_settings')
          .setLabel('Color / visibility (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('gray private • default: gray private')
          .setMaxLength(32)
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
    filter: interaction => interaction.customId === 'embed_button_add_response_modal'
      && interaction.user.id === componentInteraction.user.id,
    time: 120_000,
  }).catch(() => null);
  if (!submitted) return;

  const label = submitted.fields.getTextInputValue('button_label').trim().slice(0, 80);
  const settingsParts = submitted.fields
    .getTextInputValue('button_settings')
    .trim()
    .toLowerCase()
    .split(/[\\s,|/]+/)
    .filter(Boolean);
  const styleName = settingsParts.find(value =>
    ['gray', 'grey', 'blue', 'green', 'red'].includes(value)
  ) || '';
  const visibilityName = settingsParts.find(value =>
    ['private', 'public', 'ephemeral', 'privé', 'publiek'].includes(value)
  ) || '';
  const style = parseButtonStyle(styleName, ButtonStyle.Secondary);
  const visibility = normalizeButtonVisibility(visibilityName);
  const duration = parseButtonDuration(
    submitted.fields.getTextInputValue('button_duration'),
  );
  const responseText = submitted.fields.getTextInputValue('button_response').trim().slice(0, 4000);
  const url = submitted.fields.getTextInputValue('button_url').trim().slice(0, 512);

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
  if (responseText && url) {
    await replyButtonEditorError(submitted, 'Use either Response message or Add link, not both.');
    return;
  }
  if (!responseText && !url) {
    await replyButtonEditorError(submitted, 'Add a response message or a link.');
    return;
  }
  if (url && !/^https?:\\/\\//i.test(url)) {
    await replyButtonEditorError(submitted, 'The link must start with http:// or https://.');
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

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  const marker = 'BUILDER_LIVE_POLISH_V1';
  if (text.includes(marker)) return text;

  const controlsStart = text.indexOf('function buildControls(state) {');
  const controlsEnd = text.indexOf('\n}\n\nfunction getPreviewUpdateQueue', controlsStart);
  if (controlsStart < 0 || controlsEnd < 0) {
    throw new Error('[BUILDER_LIVE_POLISH] buildControls block missing');
  }

  let controls = text.slice(controlsStart, controlsEnd + 2);
  const titleStart = controls.indexOf('    const titleRow = new ActionRowBuilder().addComponents(');
  const contentStart = controls.indexOf('\n\n    const contentRow = new ActionRowBuilder().addComponents(', titleStart);
  if (titleStart < 0 || contentStart < 0) {
    throw new Error('[BUILDER_LIVE_POLISH] title row block missing');
  }

  const titleRow = `    const titleRow = new ActionRowBuilder().addComponents(
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
    );`;

  controls = controls.slice(0, titleStart)
    + titleRow
    + controls.slice(contentStart);
  text = text.slice(0, controlsStart) + controls + text.slice(controlsEnd + 2);

  const refreshStart = text.indexOf('async function refreshBuilder(interaction, state) {');
  const refreshEnd = text.indexOf('\n\nasync function editContent', refreshStart);
  if (refreshStart < 0 || refreshEnd < 0) {
    throw new Error('[BUILDER_LIVE_POLISH] refreshBuilder block missing');
  }

  let refresh = text.slice(refreshStart, refreshEnd);
  const sequential = `            const previewUpdated = await editBuilderPreviewMessage(
                state,
                interaction,
                next.previewPayload,
            );

            const dashboardUpdated = state.builderDashboardMessageId
                ? await editBuilderDashboardMessage(state, next.dashboardPayload)
                : true;`;

  const concurrent = `            // ${marker}: paint the live preview and the Message builder at the
            // same time. One slow Discord edit must never make the second panel lag behind.
            const previewPromise = editBuilderPreviewMessage(
                state,
                interaction,
                next.previewPayload,
            );
            const dashboardPromise = state.builderDashboardMessageId
                ? editBuilderDashboardMessage(state, next.dashboardPayload)
                : Promise.resolve(true);
            const [previewUpdated, dashboardUpdated] = await Promise.all([
                previewPromise,
                dashboardPromise,
            ]);`;

  if (!refresh.includes(sequential)) {
    throw new Error('[BUILDER_LIVE_POLISH] sequential preview/dashboard refresh missing');
  }
  refresh = refresh.replace(sequential, concurrent);
  text = text.slice(0, refreshStart) + refresh + text.slice(refreshEnd);

  return text;
});

console.log('[BUILDER_LIVE_POLISH] final Builder layout, button fields and live refresh applied.');
