import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const MAX_FILE_SIZE = 1_000_000;
const SKIPPED_FILES = new Set([
  'embedManagerService.js',
  'embedDefinitionDiscoveryService.js',
  'embedTemplateService.js',
  'builderRuntimePreviewService.js',
  'embedColorPickerSessionService.js',
  'embedColorPickerPage.js',
  'systemEmbedCatalogService.js',
  'systemEmbedCaptureReady.js',
  'systemEmbedCatalogReady.js',
  'systemEmbedCatalogMessageUpdate.js',
]);

function decodeStringPreserve(value, { allowDynamic = true } = {}) {
  if (value == null) return null;
  if (!allowDynamic && value.includes('${')) return null;
  return String(value)
    .replace(/\$\{[^}]*\}/g, '{dynamic}')
    .replace(/\$\{dynamic\}/g, '{dynamic}')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\`/g, '`')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function decodeString(value, options = {}) {
  const decoded = decodeStringPreserve(value, options);
  return decoded == null ? null : decoded.trim();
}

function literalFromText(text) {
  const match = String(text || '').match(/(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/s);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function allLiterals(text, limit = 2) {
  const output = [];
  const regex = /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/gs;
  let match;
  while ((match = regex.exec(String(text || ''))) && output.length < limit) {
    output.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return output;
}

function splitTopLevelArguments(value = '') {
  const source = String(value || '');
  const args = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let round = 0;
  let square = 0;
  let curly = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') round += 1;
    else if (char === ')') round = Math.max(0, round - 1);
    else if (char === '[') square += 1;
    else if (char === ']') square = Math.max(0, square - 1);
    else if (char === '{') curly += 1;
    else if (char === '}') curly = Math.max(0, curly - 1);
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }

  args.push(source.slice(start).trim());
  return args;
}

function decodeLiteralExpression(value, { allowDynamic = true } = {}) {
  const literals = allLiterals(value, 64)
    .map(raw => decodeStringPreserve(raw, { allowDynamic }))
    .filter(part => part != null);
  if (!literals.length) return null;
  return literals.join('').trim();
}

function safeSlug(value) {
  return String(value || '')
    .replace(/\.js$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function inferContext(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const file = safeSlug(parts.at(-1));
  const category = parts[0] === 'commands' ? String(parts[1] || '').toLowerCase() : '';

  if (category === 'economy') {
    if (/shop|store|purchase|subscription|buy|sell/.test(file)) return `shop/${file}`;
    return `gambling/${file}`;
  }
  if (category === 'fun') {
    if (/^(fight|flip|roll|dice|slots?|roulette|blackjack)/.test(file)) return `gambling/${file}`;
    return `botlog/${file}`;
  }
  if (category === 'music') return `music/${file}`;
  if (category === 'ticket') return `tickets/${file}`;
  if (category === 'giveaway') return `giveaway/${file}`;
  if (category === 'moderation' || category === 'logging') return `botlog/${file}`;
  if (category === 'community') {
    if (/appeal/.test(file)) return `ban-appeal/${file}`;
    if (/report/.test(file)) return `reports/${file}`;
    if (/shop|store|purchase|subscription/.test(file)) return `shop/${file}`;
    return `botlog/${file}`;
  }
  if (category) return `botlog/${file}`;

  if (/welcome/.test(file)) return `welcome/${file}`;
  if (/faq/.test(file)) return `faq/${file}`;
  if (/staff.*review/.test(file)) return `staff-reviews/${file}`;
  if (/appeal/.test(file)) return `ban-appeal/${file}`;
  if (/report/.test(file)) return `reports/${file}`;
  if (/music/.test(file)) return `music/${file}`;
  if (/ticket|transcript/.test(file)) return `tickets/${file}`;
  if (/shop|store|purchase|subscription/.test(file)) return `shop/${file}`;
  if (/gambl|economy|coin|flip|slots|blackjack|roulette|baccarat|fight|dice|roll/.test(file)) return `gambling/${file}`;
  return `botlog/${file}`;
}

function inferColor(title, kind = 'embed') {
  const value = String(title || '').toLowerCase();
  if (/success|completed|created|saved|enabled|added|joined|won|winner|purchased|received/.test(value)) return 0x57F287;
  if (/warning|cooldown|wait|pending|slow|too fast/.test(value)) return 0xFEE75C;
  if (/error|wrong|invalid|failed|denied|missing|not enough|blocked|disabled|cannot|could not|lost|loss/.test(value)) return 0xED4245;
  return kind === 'content' ? 0x99AAB5 : 0x5865F2;
}

function commandLabel(relativePath) {
  const file = safeSlug(relativePath.split('/').at(-1));
  return file
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Bot';
}

function plainIntentLabel(content, ordinal = 0) {
  const value = String(content || '')
    .replace(/<a?:[^:>]+:\d+>/g, '')
    .replace(/\{dynamic\}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const explicit = [
    [/choose one of the (?:staff members|owners) first.*select your rating/i, 'Select staff first'],
    [/that member is no longer available for staff reviews/i, 'Member unavailable'],
    [/review selectors could not be updated/i, 'Selector update failed'],
    [/review session expired/i, 'Session expired'],
    [/community reviews channel .*unavailable/i, 'Reviews channel unavailable'],
    [/staff review could not be published/i, 'Publish failed'],
    [/staff review has been published/i, 'Review published'],
    [/wrong channel/i, 'Wrong channel'],
    [/permission denied|access denied/i, 'Permission denied'],
    [/not enough/i, 'Not enough'],
    [/could not|failed|failure|error/i, 'Error'],
    [/expired/i, 'Expired'],
    [/saved|updated/i, 'Saved'],
    [/success|completed|done/i, 'Success'],
  ].find(([pattern]) => pattern.test(value));
  if (explicit) return explicit[1];

  const firstLine = value.split(/[\r\n]+/).find(Boolean) || '';
  const words = firstLine.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  return (words || `Message ${ordinal + 1}`).slice(0, 48);
}

function plainLabel(relativePath, content, ordinal = 0) {
  return `${commandLabel(relativePath)} • ${plainIntentLabel(content, ordinal)}`.slice(0, 256);
}

function findDescription(lines, startIndex) {
  const end = Math.min(lines.length, startIndex + 24);
  for (let index = startIndex; index < end; index += 1) {
    const line = lines[index];
    const marker = line.includes('.setDescription(')
      ? '.setDescription('
      : /\bdescription\s*:/.test(line)
        ? 'description:'
        : null;
    if (!marker) continue;

    const combined = lines.slice(index, Math.min(end, index + 12)).join('\n');
    const tail = combined.slice(combined.indexOf(marker) + marker.length);

    if (marker === '.setDescription(') {
      const boundary = tail.search(/\)\s*(?:;|\n\s*\.)/);
      const expression = boundary >= 0 ? tail.slice(0, boundary) : tail;
      const literals = allLiterals(expression, 32)
        .map(raw => decodeStringPreserve(raw, { allowDynamic: true }))
        .filter(value => value != null);
      const decoded = literals.join('').trim();
      if (decoded) return decoded;
    }

    const raw = literalFromText(tail);
    const decoded = decodeString(raw, { allowDynamic: true });
    if (decoded) return decoded;
  }
  return null;
}

function safeDynamicTitle(raw, decoded) {
  const text = String(decoded || '').trim();
  if (!raw?.includes('${') || !text.includes('{dynamic}')) return null;

  // Arbitrary expressions, ternaries and calculated titles created bogus
  // Builder catalog rows. Pre-discover only the reusable member-possessive
  // family that cannot exist as a fixed string, e.g. `${user.username}'s Balance`.
  if (!/^\{dynamic\}'s\s+[^\n]{1,160}$/i.test(text)) return null;

  const expressions = [...String(raw).matchAll(/\$\{([^{}]+)\}/g)]
    .map(match => String(match[1] || '').trim());
  if (!expressions.length) return null;
  if (expressions.some(expression =>
    !/^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*$/.test(expression)
  )) return null;

  return text.length <= 256 ? text : null;
}

function decodeDiscoveredTitle(raw) {
  const fixed = decodeString(raw, { allowDynamic: false });
  if (fixed) return fixed.length <= 256 ? fixed : null;

  const dynamic = decodeString(raw, { allowDynamic: true });
  return safeDynamicTitle(raw, dynamic);
}

function findTitlesOnLine(lines, index) {
  const line = lines[index];
  let marker = null;
  if (line.includes('.setTitle(')) marker = '.setTitle(';
  else if (/\btitleOverride\s*:/.test(line)) marker = 'titleOverride:';
  else if (/\btitle\s*:/.test(line)) marker = 'title:';
  if (!marker) return [];

  const markerIndex = line.indexOf(marker);
  const sameLineExpression = line.slice(markerIndex + marker.length);
  if (marker !== '.setTitle(' && !/^[\s]*[\'"\`]/.test(sameLineExpression)) return [];
  const titleCall = marker === '.setTitle(' ? scanBalancedCall(line, markerIndex + marker.length - 1) : null;
  const candidates = allLiterals(titleCall?.content || sameLineExpression, marker === '.setTitle(' ? 8 : 1)
    .map(decodeDiscoveredTitle)
    .filter(Boolean);

  if (candidates.length) return [...new Set(candidates)];

  const combined = lines.slice(index, Math.min(lines.length, index + 8)).join('\n');
  const raw = literalFromText(combined.slice(combined.indexOf(marker) + marker.length));
  const decoded = decodeDiscoveredTitle(raw);
  return decoded ? [decoded] : [];
}

function addDefinition(results, seen, definition) {
  const identity = `${definition.kind}|${definition.context}|${definition.title || definition.label || ''}|${definition.description || ''}`;

  if (definition.kind === 'embed' && definition.title) {
    const sameTitle = results.findIndex(existing =>
      existing.kind === 'embed'
      && existing.context === definition.context
      && existing.title === definition.title
    );

    if (sameTitle >= 0) {
      const existing = results[sameTitle];
      if (!existing.description && definition.description) {
        results[sameTitle] = {
          ...existing,
          ...definition,
          fields: definition.fields?.length ? definition.fields : existing.fields,
          footer: definition.footer?.text ? definition.footer : existing.footer,
        };
        seen.add(identity);
        return;
      }
      if (existing.description && !definition.description) return;
    }
  }

  if (seen.has(identity)) return;
  seen.add(identity);
  results.push(definition);
}


function scanBalancedCall(source, openParenIndex) {
  const opening = source[openParenIndex];
  const closing = opening === '[' ? ']' : ')';
  if (!['(', '['].includes(opening)) return null;

  let depth = 1;
  let quote = null;
  let escaped = false;

  for (let index = openParenIndex + 1; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'" || char.charCodeAt(0) === 96) {
      quote = char;
      continue;
    }
    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return {
          content: source.slice(openParenIndex + 1, index),
          endIndex: index + 1,
        };
      }
    }
  }

  return null;
}

function assignedEmbedIdentifier(source, callStart) {
  const before = source.slice(Math.max(0, callStart - 160), callStart);
  const match = before.match(/(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*$/);
  return match?.[1] || null;
}

function regexEscape(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAssignedMethodCall(source, identifier, method, startIndex) {
  if (!identifier) return null;
  const tail = source.slice(startIndex, Math.min(source.length, startIndex + 7000));
  const pattern = new RegExp(
    '\\b' + regexEscape(identifier) + '\\b[\\s\\S]{0,5200}?\\.' + regexEscape(method) + '\\s*\\(',
  );
  const match = pattern.exec(tail);
  if (!match) return null;
  const relativeOpen = match.index + match[0].lastIndexOf('(');
  return scanBalancedCall(source, startIndex + relativeOpen);
}

function extractLiteralFields(content) {
  return splitTopLevelArguments(content).flatMap(argument => {
    const object = argument.trim().replace(/^\[/, '').replace(/\]$/, '');
    const properties = splitTopLevelArguments(object.replace(/^\{/, '').replace(/\}$/, ''));
    const field = {};
    for (const property of properties) {
      const match = /^(name|value|inline)\s*:\s*([\s\S]*)$/.exec(property.trim());
      if (!match) continue;
      field[match[1]] = match[1] === 'inline'
        ? match[2].trim() === 'true'
        : (decodeLiteralExpression(match[2], { allowDynamic: true }) || '{dynamic}');
    }
    return field.name && field.value ? [{ ...field, inline: Boolean(field.inline) }] : [];
  }).slice(0, 25);
}

function chainedEmbedModifiers(source, callEnd) {
  const calls = new Map();
  let index = callEnd;
  while (index < source.length) {
    const match = /^\s*\.([A-Za-z_$][\w$]*)\s*\(/.exec(source.slice(index));
    if (!match) break;
    const open = index + match[0].lastIndexOf('(');
    const call = scanBalancedCall(source, open);
    if (!call) break;
    if (['addFields', 'setFields', 'setFooter'].includes(match[1])) calls.set(match[1], call);
    index = call.endIndex;
  }
  return calls;
}

function assignedEmbedModifiers(source, callStart, callEnd) {
  const identifier = assignedEmbedIdentifier(source, callStart);
  const chained = chainedEmbedModifiers(source, callEnd);
  const fieldsCall = chained.get('setFields') || chained.get('addFields')
    || findAssignedMethodCall(source, identifier, 'addFields', callEnd);
  const footerCall = chained.get('setFooter')
    || findAssignedMethodCall(source, identifier, 'setFooter', callEnd);
  const fields = fieldsCall ? extractLiteralFields(fieldsCall.content) : [];
  const footerLiteral = footerCall ? allLiterals(footerCall.content, 1)[0] : null;
  const footerText = decodeString(footerLiteral, { allowDynamic: true });
  return {
    ...(fields.length ? { fields } : {}),
    ...(footerText ? { footer: { text: footerText } } : {}),
  };
}

function helperCallDefinition(source, helper, callStart, callContent, callEnd) {
  const args = splitTopLevelArguments(callContent).filter(argument => argument.trim());
  // Conditional titles have multiple alternatives, not one concatenated name.
  if (/\?/.test(args[0] || '') && allLiterals(args[0], 2).length > 1) return null;
  const titleArg = decodeLiteralExpression(args[0], { allowDynamic: true });
  const descriptionArg = decodeLiteralExpression(args[1], { allowDynamic: true });

  if (helper === 'buildUserErrorEmbed') {
    const optionLiterals = allLiterals(args.slice(2).join(','), 16)
      .map(value => decodeString(value, { allowDynamic: true }))
      .filter(Boolean);
    const titleOverride = optionLiterals.at(-1);
    if (!descriptionArg || !titleOverride) return null;
    return {
      title: titleOverride,
      description: descriptionArg,
      ...assignedEmbedModifiers(source, callStart, callEnd),
    };
  }

  if (!titleArg) return null;
  const fallback = helper === 'successEmbed' ? 'Success'
    : helper === 'infoEmbed' ? 'Information'
      : helper === 'warningEmbed' ? 'Warning' : 'Error';
  // Helper overloads depend on arity, not whether the body is a literal.
  // A variable/random body still belongs to the supplied response title.
  const hasBody = args.length > 1;
  return {
    title: hasBody ? titleArg : fallback,
    description: hasBody ? (descriptionArg || '{dynamic}') : titleArg,
    ...assignedEmbedModifiers(source, callStart, callEnd),
  };
}

function extractEmbedDefinitions(source, relativePath, results, seen) {
  const context = inferContext(relativePath);
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const prefix = lines.slice(Math.max(0, index - 12), index + 1).join('\n');
    const lastBuilder = [...prefix.matchAll(/new\s+(\w+Builder)\s*\(/g)].at(-1);
    if (lines[index].includes('.setTitle(') && lastBuilder && lastBuilder[1] !== 'EmbedBuilder') continue;
    const titles = findTitlesOnLine(lines, index);
    if (!titles.length) continue;
    const description = findDescription(lines, index);
    const chain = lines.slice(index, index + 60).join('\n').split(/;\s*(?:\n|$)/)[0];
    const modifiers = {};
    const fieldMatch = /\.addFields\s*\(/.exec(chain);
    if (fieldMatch) {
      const call = scanBalancedCall(chain, fieldMatch.index + fieldMatch[0].lastIndexOf('('));
      if (call) modifiers.fields = extractLiteralFields(call.content);
    }
    if (!modifiers.fields?.length) {
      const fieldProperty = /\bfields\s*:\s*\[/.exec(chain);
      if (fieldProperty) {
        const call = scanBalancedCall(chain, fieldProperty.index + fieldProperty[0].lastIndexOf('['));
        if (call) modifiers.fields = extractLiteralFields(call.content);
      }
    }
    const footerMatch = /\.setFooter\s*\(/.exec(chain);
    if (footerMatch) {
      const call = scanBalancedCall(chain, footerMatch.index + footerMatch[0].lastIndexOf('('));
      const text = call && decodeString(allLiterals(call.content, 1)[0], { allowDynamic: true });
      if (text) modifiers.footer = { text };
    }
    for (const title of titles) {
      addDefinition(results, seen, {
        kind: 'embed',
        title,
        description,
        ...modifiers,
        color: inferColor(title),
        context,
        variantId: `${relativePath}:embed:${index + 1}:${safeSlug(title)}`,
      });
    }
  }

  const helperRegex = /\b(successEmbed|infoEmbed|warningEmbed|errorEmbed|buildUserErrorEmbed)\s*\(/g;
  let helperMatch;
  while ((helperMatch = helperRegex.exec(source))) {
    const openParenIndex = helperRegex.lastIndex - 1;
    const call = scanBalancedCall(source, openParenIndex);
    if (!call) continue;

    const helper = helperMatch[1];
    const definition = helperCallDefinition(source, helper, helperMatch.index, call.content, call.endIndex);
    if (definition?.title && definition?.description) {
      addDefinition(results, seen, {
        kind: 'embed',
        title: definition.title,
        description: definition.description,
        color: inferColor(definition.title),
        ...(definition.fields?.length ? { fields: definition.fields } : {}),
        ...(definition.footer?.text ? { footer: definition.footer } : {}),
        context,
        variantId: `${relativePath}:helper:${helperMatch.index}`,
      });
    }
    helperRegex.lastIndex = Math.max(helperRegex.lastIndex, call.endIndex);
  }
}

function extractPlainDefinitions(source, relativePath, results, seen) {
  const context = inferContext(relativePath);
  const patterns = [
    /\bcontent\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs,
    /\.(?:reply|followUp|editReply|send|respond)\s*\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/gs,
  ];

  patterns.forEach((pattern, patternIndex) => {
    let match;
    let ordinal = 0;
    while ((match = pattern.exec(source))) {
      const currentOrdinal = ordinal;
      ordinal += 1;
      const raw = literalFromText(match[1]);
      const content = decodeString(raw, { allowDynamic: true });
      if (!content || content.length > 4000) continue;
      if (/^(?:https?:\/\/|attachment:\/\/)/i.test(content) && !content.includes(' ')) continue;
      addDefinition(results, seen, {
        kind: 'content',
        label: plainLabel(relativePath, content, currentOrdinal),
        description: content,
        color: inferColor(content, 'content'),
        context,
        // Stable across copy edits. Inserting/reordering a response may change
        // its ordinal, but editing the response itself no longer creates a new
        // template identity just because its text changed.
        variantId: `${relativePath}:content:${patternIndex}:${currentOrdinal}`,
      });
    }
  });
}

export function extractDefinitions(source, relativePath) {
  const results = [];
  const seen = new Set();
  extractEmbedDefinitions(source, relativePath, results, seen);
  extractPlainDefinitions(source, relativePath, results, seen);
  return results;
}

async function walk(dir, output = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, output);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !SKIPPED_FILES.has(entry.name)) {
      output.push(absolute);
    }
  }
  return output;
}

export async function discoverEmbedDefinitions() {
  const files = await walk(SOURCE_ROOT);
  const definitions = [];
  const unique = new Set();

  const rows = new Array(files.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      const index = cursor++;
      const absolute = files[index];
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
        const source = await fs.readFile(absolute, 'utf8');
        const relativePath = path.relative(SOURCE_ROOT, absolute).replace(/\\/g, '/');
        rows[index] = extractDefinitions(source, relativePath);
      } catch { /* An unavailable source file must not block other definitions. */ }
    }
  }));
  for (const row of rows) {
    for (const definition of row || []) {
      const identity = `${definition.kind}|${definition.context}|${definition.title || definition.label || ''}|${definition.description || ''}`;
      if (unique.has(identity)) continue;
      unique.add(identity);
      definitions.push(definition);
    }
  }

  return definitions;
}
