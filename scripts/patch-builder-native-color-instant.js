import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_NATIVE_COLOR_INSTANT] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after, 'utf8');
  console.log(`[BUILDER_NATIVE_COLOR_INSTANT] ${path}: patched`);
}

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  const marker = 'BUILDER_NATIVE_COLOR_INSTANT_V1';
  if (text.includes(marker)) return text;

  {
    const start = text.indexOf('export async function saveBuilderButtonAction(');
    const end = text.indexOf('\n}\n\nexport async function getBuilderButtonAction', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] action storage block missing');
    }

    const replacement = `export async function saveBuilderButtonAction(guildId, actionId, action) {
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
    url: /^https?:\\/\\//i.test(url) ? url.slice(0, 512) : null,
    linkLabel: String(source.linkLabel || '').trim().slice(0, 80) || null,
    updatedAt: new Date().toISOString(),
  });
}`;

    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  {
    const start = text.indexOf('function managerPayload(state) {');
    const end = text.indexOf('\n}\n\nfunction normalizeButtonVisibility', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] manager block missing');
    }

    const replacement = `function buttonDraftStyleName(state) {
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
        ].join('\\n').slice(0, 4096))
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
}`;

    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  {
    const start = text.indexOf('async function showAddResponseModal(');
    const end = text.indexOf('\nasync function showAddLinkModal(', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] Add button modal block missing');
    }

    const replacement = `async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
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
  if (url && !/^https?:\\/\\//i.test(url)) {
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
}`;

    text = text.slice(0, start) + replacement + text.slice(end);
  }

  {
    const responseCase = `        if (componentInteraction.customId === 'embed_button_add_response') {
          await showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage);
          return;
        }`;
    if (!text.includes(responseCase)) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] Add button collector branch missing');
    }

    const selectCases = `        if (componentInteraction.customId === 'embed_button_color_select') {
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
`;

    text = text.replace(responseCase, selectCases + responseCase);
  }

  return text;
});

patchFile('src/interactions/buttons/cloudyBuilderAction.js', text => {
  const importBefore = `import { EmbedBuilder, MessageFlags } from 'discord.js';`;
  const importAfter = `import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';`;
  if (text.includes(importBefore)) text = text.replace(importBefore, importAfter);

  const payloadNeedle = `    const payload = {
      embeds: [buildButtonResponseEmbed(action.responseText)],
    };`;
  const payloadReplacement = `    const payload = {
      embeds: [buildButtonResponseEmbed(action.responseText)],
    };

    const actionUrl = String(action.url || '').trim();
    if (/^https?:\\/\\//i.test(actionUrl)) {
      payload.components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel(String(action.linkLabel || 'Open link').slice(0, 80))
            .setStyle(ButtonStyle.Link)
            .setURL(actionUrl.slice(0, 512)),
        ),
      ];
    }`;
  if (!text.includes(payloadNeedle)) {
    throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] response payload block missing');
  }
  text = text.replace(payloadNeedle, payloadReplacement);
  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  const marker = 'BUILDER_NATIVE_COLOR_INSTANT_V1';
  if (text.includes(marker)) return text;

  {
    const start = text.indexOf('function buildControls(state) {');
    const end = text.indexOf('\n}\n\nfunction getPreviewUpdateQueue', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] buildControls block missing');
    }

    const replacement = `function buildControls(state) {
    const sourceHasLogo = Boolean(state.modifyTarget?.sourceEmbedData?.thumbnail?.url);
    const hasLogo = !state.removeExistingLogo && (state.showLogo || sourceHasLogo);

    const titleButton = new ButtonBuilder()
        .setLabel('Edit title & message')
        .setEmoji('✍🏼');
    if (state.contentEditorUrl) {
        titleButton
            .setURL(state.contentEditorUrl)
            .setStyle(ButtonStyle.Link);
    } else {
        titleButton
            .setCustomId('simple_embed_content')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);
    }

    const titleRow = new ActionRowBuilder().addComponents(titleButton);

    // ${marker}: keep Add logo and Remove logo in their own row so Discord
    // mobile cannot wrap another control between them.
    const logoRow = new ActionRowBuilder().addComponents(
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
        (() => {
            const button = new ButtonBuilder()
                .setLabel('Set side color')
                .setEmoji('🎨');
            if (state.colorPickerUrl) {
                return button
                    .setURL(state.colorPickerUrl)
                    .setStyle(ButtonStyle.Link);
            }
            return button
                .setCustomId('simple_embed_color_unavailable')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true);
        })(),
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

    return [titleRow, logoRow, contentRow, editRow, saveRow];
}`;

    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  {
    const start = text.indexOf('async function refreshBuilder(interaction, state) {');
    const end = text.indexOf('\n\nasync function editContent', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] refreshBuilder block missing');
    }

    const replacement = `function queueBuilderRefresh(interaction, state, includeDashboard = true) {
    if (state.colorSessionToken) {
        state.colorPickerUrl = COLOR_PICKER_URL + '/embed-color?session=' + state.colorSessionToken + '&color=' + encodeURIComponent(colorToHex(state.sideColor));
    }

    const previewPayload = {
        embeds: [buildPreviewEmbed(state)],
        components: getBuilderMessageComponents(state),
        attachments: [],
    };

    if (state.mediaBuffer && state.mediaName) {
        previewPayload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
    }

    const dashboardPayload = includeDashboard
        ? {
            embeds: [buildControlEmbed(state)],
            components: buildControls(state),
        }
        : null;

    state.previewEditPending = { previewPayload, dashboardPayload };
    if (state.previewEditRunning) return Promise.resolve(true);

    return (async () => {
        state.previewEditRunning = true;
        let result = true;
        try {
            while (state.previewEditPending) {
                const next = state.previewEditPending;
                state.previewEditPending = null;

                const previewPromise = editBuilderPreviewMessage(
                    state,
                    interaction,
                    next.previewPayload,
                );
                const dashboardPromise = next.dashboardPayload && state.builderDashboardMessageId
                    ? editBuilderDashboardMessage(state, next.dashboardPayload)
                    : Promise.resolve(true);

                const [previewUpdated, dashboardUpdated] = await Promise.all([
                    previewPromise,
                    dashboardPromise,
                ]);

                result = previewUpdated && dashboardUpdated;
                if (!previewUpdated && state.builderPreviewUnavailable) {
                    state.previewEditPending = null;
                    break;
                }
            }
        } finally {
            state.previewEditRunning = false;
        }
        return result;
    })();
}

async function refreshBuilder(interaction, state) {
    return queueBuilderRefresh(interaction, state, true);
}

async function refreshBuilderPreviewOnly(interaction, state) {
    return queueBuilderRefresh(interaction, state, false);
}`;

    text = text.slice(0, start) + replacement + text.slice(end);
  }

  {
    const editorStart = text.indexOf('                onEditorUpdate: async (field, value) => {');
    const editorEnd = text.indexOf('                onColor: async color => {', editorStart);
    if (editorStart < 0 || editorEnd < 0) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] editor update callback missing');
    }

    let block = text.slice(editorStart, editorEnd);
    block = block.replace(
      'const refreshed = await refreshBuilder(interaction, state);',
      'const refreshed = await refreshBuilderPreviewOnly(interaction, state);',
    );
    block = block.replace(
      'void refreshBuilder(interaction, state).catch(error => {',
      'void refreshBuilderPreviewOnly(interaction, state).catch(error => {',
    );
    text = text.slice(0, editorStart) + block + text.slice(editorEnd);
  }

  {
    const holdStart = text.indexOf('                onEditorHold: async () => {');
    const holdEnd = text.indexOf('                onEditorUpdate: async (field, value) => {', holdStart);
    if (holdStart >= 0 && holdEnd > holdStart) {
      const replacement = `                onEditorHold: async () => {
                    // ${marker}: heartbeat only extends the existing Builder lifetime.
                    // Do not spend a Discord edit every 20 seconds just to prove it is alive.
                    if (state.builderPreviewUnavailable || !state.builderDashboardMessage) {
                        const error = new Error('The message builder session has expired.');
                        error.code = 'EMBED_BUILDER_EXPIRED';
                        throw error;
                    }
                    touchBuilderSessionMessage(state.builderDashboardMessage);
                },
`;
      text = text.slice(0, holdStart) + replacement + text.slice(holdEnd);
    }
  }

  {
    const start = text.indexOf('async function editContent(buttonInteraction, state) {');
    const end = text.indexOf('\nasync function editBottomLine', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] editContent block missing');
    let block = text.slice(start, end);
    block = block.replaceAll(
      'await refreshBuilder(submitted, state);',
      'await refreshBuilderPreviewOnly(submitted, state);',
    );
    text = text.slice(0, start) + block + text.slice(end);
  }

  {
    const start = text.indexOf('async function editBottomLine(buttonInteraction, state) {');
    const end = text.indexOf('\nasync function editMedia', start);
    if (start < 0 || end < 0) throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] editBottomLine block missing');
    let block = text.slice(start, end);
    block = block.replaceAll(
      'await refreshBuilder(submitted, state);',
      'await refreshBuilderPreviewOnly(submitted, state);',
    );
    text = text.slice(0, start) + block + text.slice(end);
  }

  {
    const startupStart = text.indexOf(
      '            const initialShown = await InteractionHelper.safeReply(interaction, {',
    );
    const startupEndNeedle = '            state.builderDashboardWebhook = interaction.webhook;';
    const startupEnd = text.indexOf(startupEndNeedle, startupStart);
    if (startupStart < 0 || startupEnd < 0) {
      throw new Error('[BUILDER_NATIVE_COLOR_INSTANT] initial Builder delivery block missing');
    }

    const startupReplacement = `            // ${marker}: for guild Builders, launch the preview interaction reply and
            // the normal bot-managed dashboard send in the same turn. They are independent
            // Discord requests, so neither waits on a second follow-up round-trip.
            let previewMessage = null;
            let dashboardMessage = null;

            if (builderBotManaged
                && interaction.channel?.send
                && !interaction.replied
                && !interaction.deferred) {
                const previewResponsePromise = interaction.reply({
                    embeds: [buildPreviewEmbed(state)],
                    components: getBuilderMessageComponents(state),
                    withResponse: true,
                }).catch(() => null);
                const dashboardPromise = interaction.channel.send({
                    embeds: [buildControlEmbed(state)],
                    components: buildControls(state),
                }).catch(() => null);

                const [previewResponse, sentDashboard] = await Promise.all([
                    previewResponsePromise,
                    dashboardPromise,
                ]);
                previewMessage = previewResponse?.resource?.message || null;
                dashboardMessage = sentDashboard || null;

                if (!previewMessage && interaction.replied) {
                    previewMessage = await interaction.fetchReply().catch(() => null);
                }
            } else {
                const initialShown = await InteractionHelper.safeReply(interaction, {
                    embeds: [buildPreviewEmbed(state)],
                    components: getBuilderMessageComponents(state),
                    flags: MessageFlags.Ephemeral,
                });
                if (initialShown) {
                    const dashboardPromise = interaction.followUp({
                        embeds: [buildControlEmbed(state)],
                        components: buildControls(state),
                        flags: MessageFlags.Ephemeral,
                        fetchReply: true,
                    }).catch(() => null);
                    [previewMessage, dashboardMessage] = await Promise.all([
                        interaction.fetchReply().catch(() => null),
                        dashboardPromise,
                    ]);
                }
            }

            if (!previewMessage || !dashboardMessage) {
                await interaction.deleteReply().catch(() => {});
                await dashboardMessage?.delete?.().catch(() => {});
                return;
            }

            state.builderMessage = previewMessage;
            state.builderMessageId = previewMessage.id;
            state.builderWebhook = interaction.webhook;
            state.builderPreviewUnavailable = false;

            state.builderDashboardMessage = dashboardMessage;
            state.builderDashboardMessageId = dashboardMessage.id;
            state.builderDashboardWebhook = builderBotManaged ? null : interaction.webhook;`;

    text = text.slice(0, startupStart)
      + startupReplacement
      + text.slice(startupEnd + startupEndNeedle.length);
  }

  return text;
});

patchFile('src/services/embedColorPickerSessionService.js', text => {
  return text.replace(
    'const EDIT_FLUSH_DELAY_MS = 2; // EDITOR_UPDATE_COALESCING_V1: collapse same-field bursts without visible UI delay',
    'const EDIT_FLUSH_DELAY_MS = 0; // BUILDER_NATIVE_COLOR_INSTANT_V1: flush edits on the next event-loop turn',
  );
});

console.log('[BUILDER_NATIVE_COLOR_INSTANT] native color/visibility controls, mixed response+link actions, mobile logo row and faster live preview enabled.');
