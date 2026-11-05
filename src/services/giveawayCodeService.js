// Giveaway codes and countries.
// A giveaway either gives each winner a code (Cloudy generates a CLOUDY- code,
// or staff add their own existing codes) or has no code: then it is hosted
// outside the website and members give their country when they enter.
import {
  ActionRowBuilder, LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { CloudyError, ErrorTypes } from '../utils/errorHandler.js';
import { CLOUDY_C_LOGO_URL } from './giveawayService.js';
import { isGiveawayCountry, searchGiveawayCountries } from './giveawayCountries.js';

export const GIVEAWAY_CODE_TYPES = Object.freeze({
  none: { label: 'No code', option: 'No code', description: 'Hosted outside the website: members give their country' },
  standard: { label: 'Generated standard code', option: 'Generate standard code', description: 'CLOUDY-1893-1839' },
  kit: { label: 'Generated kit code', option: 'Generate kit code', description: 'CLOUDY-K678-3890' },
  credit: { label: 'Generated credit card code', option: 'Generate credit card code', description: 'CLOUDY-€678-3890' },
  discount: { label: 'Generated discount code', option: 'Generate discount code', description: 'CLOUDY-REDUC10-1047-3048' },
  added: { label: 'Added codes', option: 'Add existing code', description: 'Your own codes, one per winner' },
});
export const MAX_ADDED_CODES = 50;
const MAX_CODE_LENGTH = 100;

// Giveaways saved before codes existed have no codeType and keep working
// exactly as before: no country step and no generated code.
export function giveawayCodeType(giveaway) {
  const type = giveaway?.codeType;
  return typeof type === 'string' && Object.hasOwn(GIVEAWAY_CODE_TYPES, type) ? type : null;
}

export function requiresCountry(giveaway) {
  return giveawayCodeType(giveaway) === 'none';
}

export function givesGeneratedCode(giveaway) {
  return ['standard', 'kit', 'credit', 'discount'].includes(giveawayCodeType(giveaway));
}

export function usesAddedCodes(giveaway) {
  return giveawayCodeType(giveaway) === 'added';
}

export function validDiscount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 100 ? number : null;
}

export function giveawayCodeLabel(giveaway) {
  const type = giveawayCodeType(giveaway);
  if (!type) return 'Not set';
  if (type === 'discount') return `Generated discount code -${validDiscount(giveaway.codeDiscount) || 10}%`;
  if (type === 'added') return `Added codes (${(giveaway.addedCodes || []).length})`;
  return GIVEAWAY_CODE_TYPES[type].label;
}

const digits = count => Array.from({ length: count }, () => randomInt(10)).join('');

// One new random code per winner, e.g. CLOUDY-1893-1839, CLOUDY-K678-3890,
// CLOUDY-€678-3890 or CLOUDY-REDUC10-1047-3048.
export function generateGiveawayCode(giveaway) {
  const type = giveawayCodeType(giveaway);
  if (type === 'kit') return `CLOUDY-K${digits(3)}-${digits(4)}`;
  if (type === 'credit') return `CLOUDY-€${digits(3)}-${digits(4)}`;
  if (type === 'discount') {
    return `CLOUDY-REDUC${validDiscount(giveaway.codeDiscount) || 10}-${digits(4)}-${digits(4)}`;
  }
  return `CLOUDY-${digits(4)}-${digits(4)}`;
}

// Codes are stored encrypted when GIVEAWAY_CLAIM_ENCRYPTION_KEY (64 hex) is
// set; without it they stay readable only in Cloudy's private database.
function secretKey() {
  const text = process.env.GIVEAWAY_CLAIM_ENCRYPTION_KEY || '';
  return /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
}

export function hasGiveawayCodeKey() {
  return Boolean(secretKey());
}

export function protectGiveawayCode(code) {
  const key = secretKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: ciphertext.toString('base64') };
}

export function revealGiveawayCode(encrypted) {
  const key = secretKey();
  if (!key || !encrypted?.iv || !encrypted?.tag || !encrypted?.body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.body, 'base64')), decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

// { encryptedCode } with the key, otherwise { code }.
export function sealGiveawayCode(code) {
  const encryptedCode = protectGiveawayCode(code);
  return encryptedCode ? { encryptedCode, code: null } : { encryptedCode: null, code };
}

export function openGiveawayCode(entry) {
  if (entry?.encryptedCode) return revealGiveawayCode(entry.encryptedCode);
  return typeof entry?.code === 'string' && entry.code ? entry.code : null;
}

// Added codes: one entry per code; a winner takes the next unused one when
// they open their claim and keeps it on every later click.
export function unusedAddedCodes(giveaway) {
  return (giveaway?.addedCodes || []).filter(entry => !entry?.usedBy).map(openGiveawayCode).filter(Boolean);
}

export function withAddedCodes(giveaway, codes) {
  const used = (giveaway?.addedCodes || []).filter(entry => entry?.usedBy);
  return [...used, ...codes.map(code => ({ ...sealGiveawayCode(code), usedBy: null, usedAt: null }))];
}

export function takeAddedCode(giveaway, userId) {
  const entries = [...(giveaway?.addedCodes || [])];
  const own = entries.find(entry => entry?.usedBy === userId);
  if (own) return { giveaway, code: openGiveawayCode(own), changed: false };
  const index = entries.findIndex(entry => entry && !entry.usedBy && openGiveawayCode(entry));
  if (index < 0) return { giveaway, code: null, changed: false };
  entries[index] = { ...entries[index], usedBy: userId, usedAt: new Date().toISOString() };
  return { giveaway: { ...giveaway, addedCodes: entries }, code: openGiveawayCode(entries[index]), changed: true };
}

export function parseAddedCodes(text) {
  const codes = [...new Set(String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  if (codes.some(code => code.length > MAX_CODE_LENGTH)) {
    throw expectedError(`A code can have at most ${MAX_CODE_LENGTH} characters.`);
  }
  if (codes.length > MAX_ADDED_CODES) throw expectedError(`Add at most ${MAX_ADDED_CODES} codes.`);
  return codes;
}

export function giveawayCodeModal(customId, giveaway = {}) {
  const current = giveawayCodeType(giveaway) || 'none';
  const select = new StringSelectMenuBuilder()
    .setCustomId('codeType')
    .setPlaceholder('Choose the code')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(Object.entries(GIVEAWAY_CODE_TYPES).map(([value, type]) => ({
      label: type.option, description: type.description, value, default: value === current,
    })));
  const discount = new TextInputBuilder()
    .setCustomId('codeDiscount')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('10')
    .setRequired(false)
    .setMaxLength(3);
  const savedDiscount = validDiscount(giveaway.codeDiscount);
  if (current === 'discount' && savedDiscount) discount.setValue(String(savedDiscount));
  const existing = new TextInputBuilder()
    .setCustomId('addedCodes')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('CLOUDY-1893-1839')
    .setRequired(false)
    .setMaxLength(4000);
  // The builder keeps plain codes; a posted giveaway shows its unused codes.
  const unused = Array.isArray(giveaway.draftAddedCodes) ? giveaway.draftAddedCodes : unusedAddedCodes(giveaway);
  if (current === 'added' && unused.length) existing.setValue(unused.join('\n').slice(0, 4000));
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Giveaway code')
    .addLabelComponents(
      new LabelBuilder().setLabel('Code')
        .setDescription('Generated codes are new for every winner')
        .setStringSelectMenuComponent(select),
      new LabelBuilder().setLabel('Discount %')
        .setDescription('Only for a discount code, from 1 to 100')
        .setTextInputComponent(discount),
      new LabelBuilder().setLabel('Existing codes')
        .setDescription('Only for Add existing code: one per line, one per winner')
        .setTextInputComponent(existing),
    );
}

function expectedError(message) {
  return new CloudyError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

export function readGiveawayCodeModal(interaction) {
  const codeType = String(interaction.fields.getStringSelectValues('codeType')?.[0] || '');
  if (!Object.hasOwn(GIVEAWAY_CODE_TYPES, codeType)) throw expectedError('Choose a code.');
  if (codeType === 'added') {
    const addedCodes = parseAddedCodes(interaction.fields.getTextInputValue('addedCodes'));
    if (!addedCodes.length) throw expectedError('Add at least one code in Existing codes.');
    return { codeType, codeDiscount: null, addedCodes };
  }
  if (codeType !== 'discount') return { codeType, codeDiscount: null, addedCodes: null };
  const raw = String(interaction.fields.getTextInputValue('codeDiscount') || '').replace('%', '').trim();
  const codeDiscount = validDiscount(raw);
  if (!codeDiscount) throw expectedError('Enter a discount from 1 to 100 for a discount code.');
  return { codeType, codeDiscount, addedCodes: null };
}

// Country: the member types it (in any common form) and Cloudy searches the
// full English list. One match enters at once; several give a short list.
export function giveawayCountryModal(messageId) {
  return new ModalBuilder()
    .setCustomId(`giveaway_country:${messageId}`)
    .setTitle('Enter giveaway')
    .addLabelComponents(
      new LabelBuilder().setLabel('Country')
        .setDescription('Type the country you live in')
        .setTextInputComponent(new TextInputBuilder()
          .setCustomId('country')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Netherlands')
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(60)),
    );
}

export function readGiveawayCountryModal(interaction) {
  const query = String(interaction.fields.getTextInputValue('country') || '').replace(/\s+/g, ' ').trim();
  const matches = searchGiveawayCountries(query);
  if (!matches.length) {
    const shown = query.replace(/[`*_~|<>@#\\]/g, '').slice(0, 60);
    throw expectedError(`No country matches **${shown || 'that'}**. Type the country in English, for example Netherlands.`);
  }
  return { query, matches };
}

export function giveawayCountryPicker(messageId, query, matches) {
  const shown = String(query || '').replace(/[`*_~|<>@#\\]/g, '').slice(0, 60);
  return {
    embeds: [{
      title: 'Choose your country',
      description: `More than one country matches **${shown}**. Choose yours below.`,
      color: 0xFFFFFF,
      thumbnail: { url: CLOUDY_C_LOGO_URL },
      footer: { text: '© Cloudy Inc. • Quality. Innovation. Performance.' },
    }],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`giveaway_country_pick:${messageId}`)
      .setPlaceholder('Choose your country')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(matches.slice(0, 25).map(country => ({ label: country, value: country }))))],
  };
}

export function readGiveawayCountryPick(interaction) {
  const country = String(interaction.values?.[0] || '');
  if (!isGiveawayCountry(country)) throw expectedError('Choose your country.');
  return country;
}
