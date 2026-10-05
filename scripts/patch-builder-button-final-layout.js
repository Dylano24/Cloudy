import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after === before) {
    console.log(`[BUILDER_BUTTON_FINAL] ${path}: already current`);
    return;
  }
  fs.writeFileSync(path, after);
  console.log(`[BUILDER_BUTTON_FINAL] ${path}: patched`);
}

patchFile('src/services/embedBuilderButtonEditorService.js', text => {
  if (!text.includes('  LabelBuilder,')) {
    const importAnchor = '  EmbedBuilder,\n';
    if (!text.includes(importAnchor)) {
      throw new Error('[BUILDER_BUTTON_FINAL] EmbedBuilder import missing');
    }
    text = text.replace(importAnchor, importAnchor + '  LabelBuilder,\n');
  }

  {
    const start = text.indexOf('function managerPayload(state) {');
    const end = text.indexOf('\n}\n\nfunction normalizeButtonVisibility', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_BUTTON_FINAL] manager payload block missing');
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
          'Add a response or link button from one form.',
          'Duration is entered as seconds only.',
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
}`;

    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  {
    const start = text.indexOf('function parseButtonDuration(value) {');
    const end = text.indexOf('\n}\n\nasync function replyButtonEditorError', start);
    if (start < 0 || end < 0) {
      throw new Error('[BUILDER_BUTTON_FINAL] duration parser block missing');
    }

    const replacement = `function parseButtonDuration(value) {
  const raw = String(value || '').trim();
  if (!raw) return { valid: true, ms: null };
  if (!/^\\d{1,3}$/.test(raw)) return { valid: false, ms: null };

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 900) {
    return { valid: false, ms: null };
  }
  return { valid: true, ms: seconds * 1_000 };
}`;

    text = text.slice(0, start) + replacement + text.slice(end + 2);
  }

  {
    const start = text.indexOf('async function showAddResponseModal(');
    const editStart = text.indexOf('async function showEditButtonModal(', start);
    if (start < 0 || editStart < 0) {
      throw new Error('[BUILDER_BUTTON_FINAL] button modal range missing');
    }

    const replacement = `async function showAddResponseModal(componentInteraction, state, refreshBuilder, panelMessage) {
  const settings = new StringSelectMenuBuilder()
    .setCustomId('button_settings')
    .setPlaceholder('Choose color and visibility')
    .setMinValues(1)
    .setMaxValues(1)
    .setRequired(true)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Gray · private').setValue('gray:private').setDefault(true),
      new StringSelectMenuOptionBuilder().setLabel('Gray · public').setValue('gray:public'),
      new StringSelectMenuOptionBuilder().setLabel('Blue · private').setValue('blue:private'),
      new StringSelectMenuOptionBuilder().setLabel('Blue · public').setValue('blue:public'),
      new StringSelectMenuOptionBuilder().setLabel('Green · private').setValue('green:private'),
      new StringSelectMenuOptionBuilder().setLabel('Green · public').setValue('green:public'),
      new StringSelectMenuOptionBuilder().setLabel('Red · private').setValue('red:private'),
      new StringSelectMenuOptionBuilder().setLabel('Red · public').setValue('red:public'),
    );

  const modal = new ModalBuilder()
    .setCustomId('embed_button_add_response_modal')
    .setTitle('Add response button')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Button name')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('button_label')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(80)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel('Color & visibility')
        .setStringSelectMenuComponent(settings),
      new LabelBuilder()
        .setLabel('Duration in seconds (optional)')
        .setDescription('Use numbers only. Leave blank to keep the response.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('button_duration')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('10')
            .setMaxLength(3)
            .setRequired(false),
        ),
      new LabelBuilder()
        .setLabel('Response message (optional)')
        .setDescription('Fill this for a response button.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('button_response')
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(4000)
            .setRequired(false),
        ),
      new LabelBuilder()
        .setLabel('Link URL (optional)')
        .setDescription('Fill this instead of a response message for a link button.')
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('button_url')
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
  const settingsValue = submitted.fields.getStringSelectValues('button_settings')?.[0] || 'gray:private';
  const [styleName = 'gray', visibilityName = 'private'] = String(settingsValue).split(':');
  const style = parseButtonStyle(styleName, ButtonStyle.Secondary);
  const visibility = normalizeButtonVisibility(visibilityName) || 'private';
  const duration = parseButtonDuration(
    submitted.fields.getTextInputValue('button_duration'),
  );
  const responseText = submitted.fields.getTextInputValue('button_response').trim().slice(0, 4000);
  const url = submitted.fields.getTextInputValue('button_url').trim().slice(0, 512);

  if (!duration.valid) {
    await replyButtonEditorError(
      submitted,
      'Duration must be blank or a number from 1 to 900 seconds.',
    );
    return;
  }
  if (responseText && url) {
    await replyButtonEditorError(
      submitted,
      'Use either Response message or Link URL, not both.',
    );
    return;
  }
  if (!responseText && !url) {
    await replyButtonEditorError(
      submitted,
      'Add a response message or a link URL.',
    );
    return;
  }

  let component;
  if (url) {
    if (!/^https?:\\/\\//i.test(url)) {
      await replyButtonEditorError(submitted, 'The link must start with http:// or https://.');
      return;
    }
    component = {
      type: BUTTON_COMPONENT_TYPE,
      style: ButtonStyle.Link,
      label,
      url,
    };
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
  await closeButtonEditorPanel(submitted, state).catch(() => {});
}

`;

    text = text.slice(0, start) + replacement + text.slice(editStart);
  }

  text = text.replace(
    /\n\s*if \(componentInteraction\.customId === 'embed_button_add_link'\) \{[\s\S]*?\n\s*\}\n/,
    '\n',
  );
  text = text.replace(
    /\n\s*if \(componentInteraction\.customId === 'embed_button_add_disabled'\) \{[\s\S]*?\n\s*\}\n/,
    '\n',
  );

  return text;
});

patchFile('src/commands/Tools/embedbuilder.js', text => {
  const controlsPattern = /function buildControls\(state\) \{[\s\S]*?\n\}\n\nfunction getPreviewUpdateQueue/;
  if (!controlsPattern.test(text)) {
    throw new Error('[BUILDER_BUTTON_FINAL] buildControls block missing');
  }

  text = text.replace(controlsPattern, `function buildControls(state) {
    const sourceHasLogo = Boolean(state.modifyTarget?.sourceEmbedData?.thumbnail?.url);
    const hasLogo = !state.removeExistingLogo && (state.showLogo || sourceHasLogo);

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

    return [titleRow, contentRow, editRow, saveRow];
}

function buildPreviewPayload(state) {
    const previewData = fitEmbedToTextBudget(
        buildPreviewEmbed(state),
        DISCORD_EMBED_TOTAL_TEXT_LIMIT,
    );
    const payload = {
        embeds: [new EmbedBuilder(previewData)],
        components: getBuilderMessageComponents(state),
        attachments: [],
    };

    if (state.mediaBuffer && state.mediaName) {
        payload.files = [{ attachment: state.mediaBuffer, name: state.mediaName }];
    }
    return payload;
}

function buildDashboardPayload(state) {
    return {
        embeds: [buildControlEmbed(state)],
        components: buildControls(state),
    };
}

async function editBuilderDashboard(interaction, state, payload) {
    if (!state.dashboardMessageId) return true;

    if (state.dashboardMessage?.edit) {
        const edited = await state.dashboardMessage.edit(payload).catch(() => null);
        if (edited) {
            state.dashboardMessage = edited;
            return true;
        }
    }

    const webhook = interaction?.webhook || state.rootInteraction?.webhook;
    if (webhook?.editMessage) {
        const edited = await webhook.editMessage(String(state.dashboardMessageId), payload).catch(() => null);
        if (edited) {
            state.dashboardMessage = edited;
            return true;
        }
    }
    return false;
}

async function deleteBuilderDashboard(interaction, state) {
    const id = state.dashboardMessageId ? String(state.dashboardMessageId) : null;
    if (!id) return;

    const webhook = interaction?.webhook || state.rootInteraction?.webhook;
    const deleted = webhook?.deleteMessage
        ? await webhook.deleteMessage(id).then(() => true).catch(() => false)
        : false;
    if (!deleted) await state.dashboardMessage?.delete?.().catch(() => {});
    state.dashboardMessage = null;
    state.dashboardMessageId = null;
}

function getPreviewUpdateQueue`);

  const refreshPattern = /async function flushPreviewUpdateQueue\(state\) \{[\s\S]*?\n\}\n\nfunction refreshBuilder\(interaction, state\) \{[\s\S]*?\n\}\n\nasync function editContent/;
  if (!refreshPattern.test(text)) {
    throw new Error('[BUILDER_BUTTON_FINAL] refresh queue block missing');
  }

  text = text.replace(refreshPattern, `async function flushPreviewUpdateQueue(state) {
    const queue = getPreviewUpdateQueue(state);
    if (queue.running) return;
    queue.running = true;

    try {
        while (queue.pending) {
            const update = queue.pending;
            queue.pending = null;
            let previewUpdated = false;
            let dashboardUpdated = true;

            try {
                previewUpdated = await InteractionHelper.safeEditReply(
                    state.rootInteraction || update.interaction,
                    update.previewPayload,
                );
            } catch {
                previewUpdated = false;
            }

            if (state.dashboardMessageId) {
                dashboardUpdated = await editBuilderDashboard(
                    update.interaction,
                    state,
                    update.dashboardPayload,
                );
            }

            update.resolve(
                (previewUpdated && dashboardUpdated) || Boolean(queue.pending),
            );
        }
    } finally {
        queue.running = false;
    }
}

function refreshBuilder(interaction, state) {
    if (state.colorSessionToken) {
        state.colorPickerUrl = COLOR_PICKER_URL + '/embed-color?session=' + state.colorSessionToken + '&color=' + encodeURIComponent(colorToHex(state.sideColor));
    }

    const queue = getPreviewUpdateQueue(state);
    return new Promise(resolve => {
        if (queue.pending) queue.pending.resolve(true);
        queue.pending = {
            interaction,
            previewPayload: buildPreviewPayload(state),
            dashboardPayload: buildDashboardPayload(state),
            resolve,
        };
        void flushPreviewUpdateQueue(state);
    });
}

async function editContent`);

  const initAnchor = `            await refreshBuilder(interaction, state);

            const dashboardMessage = await interaction.fetchReply();
            const collector = dashboardMessage.createMessageComponentCollector({`;

  const initReplacement = `            state.rootInteraction = interaction;
            await refreshBuilder(interaction, state);

            const dashboardMessage = await interaction.followUp({
                ...buildDashboardPayload(state),
                flags: MessageFlags.Ephemeral,
                fetchReply: true,
            }).catch(() => null);
            if (!dashboardMessage) {
                await interaction.deleteReply().catch(() => {});
                return;
            }
            state.dashboardMessage = dashboardMessage;
            state.dashboardMessageId = String(dashboardMessage.id);

            const collector = dashboardMessage.createMessageComponentCollector({`;

  if (!text.includes(initAnchor)) {
    throw new Error('[BUILDER_BUTTON_FINAL] initial dashboard anchor missing');
  }
  text = text.replace(initAnchor, initReplacement);

  const closeStart = text.indexOf("case 'simple_embed_close':");
  if (closeStart >= 0) {
    const closeEnd = text.indexOf("\n                        case '", closeStart + 8);
    let block = text.slice(closeStart, closeEnd >= 0 ? closeEnd : text.length);
    if (!block.includes('deleteBuilderDashboard(buttonInteraction, state)')) {
      const stopNeedle = "collector.stop('manual-close');";
      if (!block.includes(stopNeedle)) {
        throw new Error('[BUILDER_BUTTON_FINAL] close stop anchor missing');
      }
      block = block.replace(
        stopNeedle,
        "await deleteBuilderDashboard(buttonInteraction, state).catch(() => {});\n                            " + stopNeedle,
      );
      text = text.slice(0, closeStart) + block + text.slice(closeEnd >= 0 ? closeEnd : text.length);
    }
  }

  return text;
});

console.log('[BUILDER_BUTTON_FINAL] Unified response/link form and top preview button layout enabled.');
