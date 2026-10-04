import fs from 'node:fs';

function patchFile(path, patcher) {
  const before = fs.readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const after = patcher(before);
  if (after !== before) fs.writeFileSync(path, after);
  console.log(`[RUNTIME_PERFORMANCE] ${path}: ${after === before ? 'already current' : 'patched'}`);
}

function replaceRequired(text, before, after, label) {
  if (text.includes(after)) return text;
  if (!text.includes(before)) {
    throw new Error(`[RUNTIME_PERFORMANCE] Could not find ${label}; refusing to start with an unknown source shape.`);
  }
  return text.replace(before, after);
}

patchFile('src/services/embedManagerService.js', text => {
  text = replaceRequired(
    text,
`export async function discoverEmbedManagerOverviewRecords(guild, records, botUserId) {
    if (!guild || !botUserId) return [];`,
`export async function discoverEmbedManagerOverviewRecords(guild, records, botUserId) {
    // The registry already contains the canonical Builder inventory. Scanning
    // every empty channel on each Builder open can generate dozens of Discord
    // REST requests and make unrelated interactions feel frozen. Keep the old
    // recovery scan available only as an explicit maintenance opt-in.
    if (process.env.CLOUDY_BUILDER_GUILD_SCAN !== '1') return [];
    if (!guild || !botUserId) return [];`,
    'Embed Manager overview discovery guard',
  );

  text = replaceRequired(
    text,
`async function loadCurrentRegistry(guild, botUserId) {
    let result = await reconcileEmbedRegistry(guild);
    if (result.records.length) {
        void refreshRecentEmbedHistory(guild, botUserId)
            .catch(error => logger.error('Background embed history sync failed:', error));
        return result.records;
    }

    await refreshRecentEmbedHistory(guild, botUserId, true);
    result = await reconcileEmbedRegistry(guild);
    return result.records;
}`,
`async function loadCurrentRegistry(guild, botUserId) {
    // Opening the Builder must be a local/DB operation. Reconciling the entire
    // registry resolves every stored Discord message and grows linearly with the
    // catalog. Only bootstrap from Discord when the registry is genuinely empty.
    const records = await getEmbedRegistry(guild.id);
    if (records.length) return records;

    await refreshRecentEmbedHistory(guild, botUserId, true);
    const result = await reconcileEmbedRegistry(guild);
    return result.records;
}`,
    'registry-first Builder load',
  );

  return text;
});

patchFile('src/events/fullResponseCatalogReady.js', text => {
  text = replaceRequired(
    text,
`    const timer = setTimeout(() => {
      void scanRecentBotResponses(client).catch(error => {
        logger.warn('[EMBED_BUILDER] Full response history sync failed: ' + error.message);
      });
    }, STARTUP_SCAN_DELAY_MS);
    timer.unref?.();`,
`    // Live responses are captured as they are created/updated. A full guild
    // history sweep is expensive (many channel fetches) and is not needed on
    // every deploy. Keep it available only for an intentional one-off recovery.
    if (process.env.CLOUDY_HISTORY_BOOTSTRAP === '1') {
      const timer = setTimeout(() => {
        void scanRecentBotResponses(client).catch(error => {
          logger.warn('[EMBED_BUILDER] Full response history sync failed: ' + error.message);
        });
      }, STARTUP_SCAN_DELAY_MS);
      timer.unref?.();
    }`,
    'automatic full response history scan',
  );

  return text;
});

console.log('[RUNTIME_PERFORMANCE] Registry-first Builder loading and opt-in history recovery enabled.');
