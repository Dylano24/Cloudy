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

  // Keep the explicit recovery helper available, but never fan out across all
  // channels merely because the owner opened the Builder.
  const openStart = text.indexOf('export async function openEmbedManager');
  const discoveryCallStart = openStart === -1 ? -1 : text.indexOf('            discoverEmbedManagerOverviewRecords(', openStart);
  const loadCallStart = discoveryCallStart === -1 ? -1 : text.indexOf('            loadCurrentRegistry(', discoveryCallStart);
  if (openStart === -1) {
    throw new Error('[RUNTIME_PERFORMANCE] Could not locate openEmbedManager.');
  }
  if (discoveryCallStart !== -1) {
    if (loadCallStart === -1) {
      throw new Error('[RUNTIME_PERFORMANCE] Builder discovery call exists but its registry-load anchor is missing.');
    }
    text = text.slice(0, discoveryCallStart) + '            Promise.resolve([]),\n' + text.slice(loadCallStart);
  }

  return text;
});

patchFile('src/events/fullResponseCatalogReady.js', text => {
  if (text.includes("process.env.CLOUDY_HISTORY_BOOTSTRAP === '1'")) return text;

  const readyStart = text.indexOf('  execute(client) {');
  const timerStart = readyStart === -1 ? -1 : text.indexOf('    const timer = setTimeout(() => {', readyStart);
  const timerEndMarker = '    timer.unref?.();';
  const timerEnd = timerStart === -1 ? -1 : text.indexOf(timerEndMarker, timerStart);

  if (readyStart === -1 || timerStart === -1 || timerEnd === -1) {
    throw new Error('[RUNTIME_PERFORMANCE] Could not locate the startup history timer; refusing to patch an unknown source shape.');
  }

  const timerBlock = text.slice(timerStart, timerEnd + timerEndMarker.length);
  const nestedTimerBlock = timerBlock
    .split('\n')
    .map(line => '  ' + line)
    .join('\n');

  const guarded = [
    '    // Live responses are captured as they are created/updated. A full guild',
    '    // history sweep is expensive and is not needed on every deploy.',
    "    if (process.env.CLOUDY_HISTORY_BOOTSTRAP === '1') {",
    nestedTimerBlock,
    '    }',
  ].join('\n');

  return text.slice(0, timerStart) + guarded + text.slice(timerEnd + timerEndMarker.length);
});

console.log('[RUNTIME_PERFORMANCE] Registry-first Builder loading and opt-in history recovery enabled.');
