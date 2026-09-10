import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(path, after);
  console.log(`[UI_LATENCY] ${path}: ${after === before ? 'already current' : 'patched'}`);
}

function replaceRequired(text, before, after, label) {
  if (text.includes(after)) return text;
  if (!text.includes(before)) {
    throw new Error(`[UI_LATENCY] Could not find ${label}; refusing to start with an unknown source shape.`);
  }
  return text.replace(before, after);
}

patchFile('src/commands/Tools/embedbuilder.js', text => {
  text = replaceRequired(
    text,
`            const deferred = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferred) return;
`,
`            // Do not spend a Discord round-trip on a defer before rendering a
            // panel that can be built locally. The first panel is sent directly.
`,
    'Embed Builder initial defer',
  );

  text = replaceRequired(
    text,
`            const guildEmojis = interaction.guild
                ? await interaction.guild.emojis.fetch().catch(() => interaction.guild.emojis.cache)
                : new Map();`,
`            // Guild emojis are already populated by Discord READY. Avoid a REST
            // fetch before the first Builder paint; the cache is the fast path.
            const guildEmojis = interaction.guild?.emojis?.cache || new Map();`,
    'Embed Builder startup emoji fetch',
  );

  text = replaceRequired(
    text,
`            await refreshBuilder(interaction, state);

            const dashboardMessage = await interaction.fetchReply();`,
`            const initialShown = await InteractionHelper.safeReply(interaction, {
                embeds: [buildPreviewEmbed(state), buildControlEmbed(state)],
                components: buildControls(state),
                flags: MessageFlags.Ephemeral,
            });
            if (!initialShown) return;

            const dashboardMessage = await interaction.fetchReply();`,
    'Embed Builder direct initial reply',
  );

  text = replaceRequired(
    text,
`    await buttonInteraction.deferUpdate();
    await refreshAllTicketChannels(guild, true);

    const initialPicker = buildChannelPicker(guild, 0);`,
`    await buttonInteraction.deferUpdate();
    // Channel cache is already authoritative for the picker. Refreshing ticket
    // channel metadata is maintenance work and must not block this click.
    void refreshAllTicketChannels(guild, true).catch(() => {});

    const initialPicker = buildChannelPicker(guild, 0);`,
    'Embed Builder post-channel blocking refresh',
  );

  return text;
});

patchFile('src/commands/Logging/modules/logging_dashboard.js', text => {
  text = replaceRequired(
    text,
`async function formatChannelMention(guild, id) {
  if (!id) return '\`Not configured\`';
  const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
  return channel ? channel.toString() : \`⚠️ Missing (\${id})\`;
}`,
`async function formatChannelMention(guild, id) {
  if (!id) return '\`Not configured\`';
  // Guild channel state is populated by READY. A dashboard render should never
  // wait on a REST fetch merely to format a mention.
  const channel = guild.channels.cache.get(id) || null;
  return channel ? channel.toString() : \`⚠️ Missing (\${id})\`;
}`,
    'logging dashboard channel lookup',
  );

  text = replaceRequired(
    text,
`export async function buildLoggingDashboardView(interaction, client) {
  const guildConfig = await getGuildConfig(client, interaction.guildId);
  const loggingStatus = await getLoggingStatus(client, interaction.guildId);`,
`export async function buildLoggingDashboardView(interaction, client, providedGuildConfig = null) {
  const [guildConfig, loggingStatus] = await Promise.all([
    providedGuildConfig ? Promise.resolve(providedGuildConfig) : getGuildConfig(client, interaction.guildId),
    getLoggingStatus(client, interaction.guildId),
  ]);`,
    'logging dashboard config reads',
  );

  text = replaceRequired(
    text,
`  const auditChannel = await formatChannelMention(interaction.guild, channels.audit);
  const applicationsChannel = await formatChannelMention(interaction.guild, channels.applications);
  const reportsChannel = await formatChannelMention(interaction.guild, channels.reports);
  const lifecycleChannel = await formatChannelMention(interaction.guild, guildConfig.ticketLogsChannelId);
  const transcriptChannel = await formatChannelMention(interaction.guild, guildConfig.ticketTranscriptChannelId);`,
`  const [auditChannel, applicationsChannel, reportsChannel, lifecycleChannel, transcriptChannel] = await Promise.all([
    formatChannelMention(interaction.guild, channels.audit),
    formatChannelMention(interaction.guild, channels.applications),
    formatChannelMention(interaction.guild, channels.reports),
    formatChannelMention(interaction.guild, guildConfig.ticketLogsChannelId),
    formatChannelMention(interaction.guild, guildConfig.ticketTranscriptChannelId),
  ]);`,
    'logging dashboard channel formatting',
  );

  text = replaceRequired(
    text,
`      await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      const { embed, components } = await buildLoggingDashboardView(interaction, client);
      await InteractionHelper.safeEditReply(interaction, { embeds: [embed], components });`,
`      const { embed, components } = await buildLoggingDashboardView(interaction, client, config);
      await InteractionHelper.safeReply(interaction, {
        embeds: [embed],
        components,
        flags: MessageFlags.Ephemeral,
      });`,
    'logging dashboard initial response',
  );

  return text;
});

patchFile('src/commands/Economy/modules/economy_dashboard.js', text => {
  text = replaceRequired(
    text,
`        if (economyKeys && economyKeys.length > 0) {
            for (const key of economyKeys) {
                const userId = key.split(':').pop();

                const member = await guild.members.fetch(userId).catch(() => null);
                if (member?.user?.bot) continue;

                const userData = await client.db.get(key, {});
                if (userData) {
                    totalInCirculation += (userData.wallet || 0) + (userData.bank || 0);
                    userCount++;
                }
            }
        }`,
`        if (economyKeys && economyKeys.length > 0) {
            // The old dashboard did one Discord member fetch and one DB read per
            // account in series. Use READY's member cache and bounded parallel
            // DB batches so account count does not translate into UI latency.
            const batchSize = 20;
            for (let offset = 0; offset < economyKeys.length; offset += batchSize) {
                const batch = economyKeys.slice(offset, offset + batchSize);
                const rows = await Promise.all(batch.map(async key => {
                    const userId = key.split(':').pop();
                    const member = guild.members.cache.get(userId);
                    if (member?.user?.bot) return null;
                    return client.db.get(key, {});
                }));

                for (const userData of rows) {
                    if (!userData) continue;
                    totalInCirculation += (userData.wallet || 0) + (userData.bank || 0);
                    userCount++;
                }
            }
        }`,
    'economy dashboard serial account scan',
  );
  return text;
});

patchFile('src/commands/Core/modules/commands_dashboard.js', text => {
  text = replaceRequired(
    text,
`export async function buildDashboardView(client, guildId, guild, view = 'overview', categoryKey = null) {
  const config = await getGuildConfig(client, guildId);`,
`export async function buildDashboardView(client, guildId, guild, view = 'overview', categoryKey = null, providedConfig = null) {
  const config = providedConfig || await getGuildConfig(client, guildId);`,
    'commands dashboard provided-config fast path',
  );

  return text;
});

patchFile('src/commands/Core/commands.js', text => {
  text = replaceRequired(
    text,
`    if (subcommand === 'dashboard') {
      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) {
        return;
      }

      const view = await buildDashboardView(client, interaction.guildId, interaction.guild, 'overview');
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [view.embed],
        components: view.components,
      });`,
`    if (subcommand === 'dashboard') {
      // The dispatcher already resolved the guild config. Build locally and use
      // a single Discord reply instead of defer + edit + duplicate config read.
      const view = await buildDashboardView(client, interaction.guildId, interaction.guild, 'overview', null, config);
      const shown = await InteractionHelper.safeReply(interaction, {
        embeds: [view.embed],
        components: view.components,
        flags: MessageFlags.Ephemeral,
      });
      if (!shown) return;`,
    'commands dashboard initial response',
  );

  return text;
});

patchFile('src/commands/JoinToCreate/jointocreate.js', text => {
  text = replaceRequired(
    text,
`            const subcommand = interaction.options.getSubcommand();
            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

            if (subcommand === "setup") {
                await handleSetupSubcommand(interaction, client);
                return;
            } else if (subcommand === "dashboard") {
                await handleConfigSubcommand(interaction, client);
                return;
            }`,
`            const subcommand = interaction.options.getSubcommand();

            if (subcommand === "setup") {
                await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
                await handleSetupSubcommand(interaction, client);
                return;
            } else if (subcommand === "dashboard") {
                // Dashboard configuration is a small local/DB read. Avoid a
                // defer + edit pair so the panel can arrive in one Discord call.
                await handleConfigSubcommand(interaction, client);
                return;
            }`,
    'Join to Create initial defer',
  );

  text = replaceRequired(
    text,
`        await InteractionHelper.safeEditReply(interaction, { embeds: [configEmbed], components: [row] });
        const message = await interaction.fetchReply();`,
`        await InteractionHelper.safeReply(interaction, {
            embeds: [configEmbed],
            components: [row],
            flags: MessageFlags.Ephemeral,
        });
        const message = await interaction.fetchReply();`,
    'Join to Create initial dashboard reply',
  );

  text = replaceRequired(
    text,
`                // Always refresh from storage before acting. An older dashboard may never
                // overwrite the latest value just because another administrator opened it first.
                await refreshDashboard(message, triggerChannel, client);

                const customId = buttonInteraction.customId;`,
`                // Each editor action reads the latest configuration itself. Do
                // not add a database read + Discord edit before opening a modal.
                const customId = buttonInteraction.customId;`,
    'Join to Create pre-action refresh',
  );

  return text;
});

patchFile('src/events/fullResponseCatalogReady.js', text => {
  text = replaceRequired(
    text,
`const STARTUP_SCAN_DELAY_MS = 7000;`,
`// Historical reconciliation is background maintenance. Keep it away from the
// first minute after startup so dashboards and Builder interactions get all
// available Discord/API bandwidth first.
const STARTUP_SCAN_DELAY_MS = 90_000;`,
    'response history startup delay',
  );
  return text;
});

console.log('[UI_LATENCY] fast interaction paths ready');
