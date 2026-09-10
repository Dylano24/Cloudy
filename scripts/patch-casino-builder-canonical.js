import fs from 'node:fs';

const path = 'src/services/embedManagerService.js';
const before = fs.readFileSync(path, 'utf8');
let text = before;

if (!text.includes('function canonicalCasinoBuilderTemplate(value)')) {
  const marker = '\n\nexport function templateIdentity';
  if (!text.includes(marker)) throw new Error('Embed Manager template identity marker was not found.');

  const helper = `

function customEmojiOption(value) {
    const match = String(value || '').match(/<(a?):([^:>]+):(\\d+)>/);
    if (!match) return null;
    return { id: match[3], name: match[2], animated: match[1] === 'a' };
}

function canonicalCasinoBuilderTemplate(value) {
    const data = value && typeof value === 'object' ? value : {};
    const stableKey = stableSystemTemplateKey(data);
    const stableLabels = new Map([
        ['game:roulette:won', 'Roulette win'],
        ['game:roulette:lost', 'Roulette loss'],
        ['game:blackjack:bet', 'Blackjack bet'],
        ['game:blackjack:result:bust', 'Blackjack bust'],
        ['game:blackjack:result:blackjack', 'Blackjack natural win'],
        ['game:blackjack:result:win', 'Blackjack win'],
        ['game:blackjack:result:push', 'Blackjack push'],
        ['game:blackjack:result:loss', 'Blackjack loss'],
        ['game:blackjack:result:expired', 'Blackjack expired'],
        ['game:baccarat:bet', 'Baccarat bet'],
        ['game:baccarat:win', 'Baccarat win'],
        ['game:baccarat:loss', 'Baccarat loss'],
        ['game:baccarat:tie', 'Baccarat tie'],
        ['game:baccarat:push', 'Baccarat push'],
        ['game:baccarat:expired', 'Baccarat expired'],
    ]);
    if (stableLabels.has(stableKey)) return { key: stableKey, label: stableLabels.get(stableKey) };

    const title = stripCustomEmojiMarkup(data.title || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const description = stripCustomEmojiMarkup(data.description || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const fields = new Set((Array.isArray(data.fields) ? data.fields : [])
        .map(field => stripCustomEmojiMarkup(field?.name || '').replace(/\\s+/g, ' ').trim().toLowerCase())
        .filter(Boolean));
    const context = stableSystemTemplateContext(data);

    let game = context.match(/^gambling\\/(blackjack|baccarat|roulette)$/)?.[1] || '';
    if (!game) {
        if (/\\bblackjack\\b/.test(title) || (fields.has('your hand') && fields.has('dealer hand'))) game = 'blackjack';
        else if (/\\bbaccarat\\b/.test(title) || (fields.has('player hand') && fields.has('banker hand'))) game = 'baccarat';
        else if (/\\broulette\\b|wheel landed/.test(\`${'${title} ${description}'}\`) || (fields.has('your bet') && fields.has('result'))) game = 'roulette';
    }
    if (!game) return null;

    const signal = \`${'${title} ${description}'}\`;
    if (game === 'roulette') {
        if (/\\b(?:loss|lost)\\b/.test(signal)) return { key: 'game:roulette:lost', label: 'Roulette loss' };
        if (/\\b(?:win|won)\\b/.test(signal)) return { key: 'game:roulette:won', label: 'Roulette win' };
        return null;
    }

    if (game === 'blackjack') {
        if (/\\bbet\\b/.test(title)) return { key: 'game:blackjack:bet', label: 'Blackjack bet' };
        if (/\\bexpired\\b/.test(signal)) return { key: 'game:blackjack:result:expired', label: 'Blackjack expired' };
        if (/\\bbust\\b/.test(signal)) return { key: 'game:blackjack:result:bust', label: 'Blackjack bust' };
        if (/\\b(?:natural|blackjack)\\s+win\\b|\\bnatural\\b/.test(signal)) return { key: 'game:blackjack:result:blackjack', label: 'Blackjack natural win' };
        if (/\\b(?:push|tie)\\b/.test(signal)) return { key: 'game:blackjack:result:push', label: 'Blackjack push' };
        if (/\\b(?:loss|lost)\\b/.test(signal)) return { key: 'game:blackjack:result:loss', label: 'Blackjack loss' };
        if (/\\b(?:win|won)\\b/.test(signal)) return { key: 'game:blackjack:result:win', label: 'Blackjack win' };
        return null;
    }

    if (/\\bbet\\b/.test(title)) return { key: 'game:baccarat:bet', label: 'Baccarat bet' };
    if (/\\bexpired\\b/.test(signal)) return { key: 'game:baccarat:expired', label: 'Baccarat expired' };
    if (/\\b(?:tie|push)\\b/.test(signal)) return { key: 'game:baccarat:push', label: 'Baccarat push' };
    if (/\\b(?:loss|lost)\\b/.test(signal)) return { key: 'game:baccarat:loss', label: 'Baccarat loss' };
    if (/\\b(?:win|won)\\b/.test(signal)) return { key: 'game:baccarat:win', label: 'Baccarat win' };
    return null;
}
`;
  text = text.replace(marker, helper + marker);
}

const loopMarker = `        const recordData = recordEmbedData(record);
        const ticketLog = canonicalTicketLogTemplate(recordData);`;
const loopReplacement = `        const recordData = recordEmbedData(record);
        const casinoTemplate = canonicalCasinoBuilderTemplate(recordData);
        if (casinoTemplate) {
            const key = \`casino:\${casinoTemplate.key}\`;
            if (!groups.has(key)) groups.set(key, {
                label: casinoTemplate.label,
                records: [],
                templateMode: true,
            });
            groups.get(key).records.push(record);
            continue;
        }

        const ticketLog = canonicalTicketLogTemplate(recordData);`;
if (!text.includes('const casinoTemplate = canonicalCasinoBuilderTemplate(recordData);')) {
  if (!text.includes(loopMarker)) throw new Error('Embed Manager record grouping marker was not found.');
  text = text.replace(loopMarker, loopReplacement);
}

const optionMarker = `                return new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(displayName, 'Untitled embed'))
                    .setDescription(description.slice(0, 100))
                    .setValue(\`${'${record.messageId}:${record.embedIndex || 0}'}\`);`;
const optionReplacement = `                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(shortLabel(displayName, 'Untitled embed'))
                    .setDescription(description.slice(0, 100))
                    .setValue(\`${'${record.messageId}:${record.embedIndex || 0}'}\`);
                const emoji = customEmojiOption(recordEmbedData(record).title || record.title || record.name);
                if (emoji) option.setEmoji(emoji);
                return option;`;
if (!text.includes('const emoji = customEmojiOption(recordEmbedData(record).title')) {
  if (!text.includes(optionMarker)) throw new Error('Embed Manager select option marker was not found.');
  text = text.replace(optionMarker, optionReplacement);
}

if (text !== before) fs.writeFileSync(path, text, 'utf8');
console.log(`[CASINO_BUILDER_CANONICAL] ${text === before ? 'already current' : 'patched canonical labels, grouping and emoji icons'}`);
