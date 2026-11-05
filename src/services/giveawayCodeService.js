// Giveaway codes and countries.
// A giveaway either gives each winner a code that Cloudy generates (website
// prizes, always starting with CLOUDY-) or has no code: then it is hosted
// outside the website and members choose their country when they enter.
import {
  LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { randomInt } from 'node:crypto';
import { CloudyError, ErrorTypes } from '../utils/errorHandler.js';

export const GIVEAWAY_CODE_TYPES = Object.freeze({
  none: { label: 'No code', description: 'Hosted outside the website: members choose their country' },
  standard: { label: 'Standard', description: 'CLOUDY-1893-1839' },
  kit: { label: 'Kit', description: 'CLOUDY-K678-3890' },
  credit: { label: 'Credit card', description: 'CLOUDY-€678-3890' },
  discount: { label: 'Discount', description: 'CLOUDY-REDUC10-1047-3048' },
});

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
  const type = giveawayCodeType(giveaway);
  return Boolean(type && type !== 'none');
}

export function validDiscount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 100 ? number : null;
}

export function giveawayCodeLabel(giveaway) {
  const type = giveawayCodeType(giveaway);
  if (!type) return 'Not set';
  if (type === 'discount') return `Discount -${validDiscount(giveaway.codeDiscount) || 10}%`;
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

export function giveawayCodeModal(customId, giveaway = {}) {
  const current = giveawayCodeType(giveaway) || 'none';
  const select = new StringSelectMenuBuilder()
    .setCustomId('codeType')
    .setPlaceholder('Choose the code type')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(Object.entries(GIVEAWAY_CODE_TYPES).map(([value, type]) => ({
      label: type.label, description: type.description, value, default: value === current,
    })));
  const discount = new TextInputBuilder()
    .setCustomId('codeDiscount')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('10')
    .setRequired(false)
    .setMaxLength(3);
  const savedDiscount = validDiscount(giveaway.codeDiscount);
  if (current === 'discount' && savedDiscount) discount.setValue(String(savedDiscount));
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Giveaway code')
    .addLabelComponents(
      new LabelBuilder().setLabel('Code type')
        .setDescription('Cloudy generates a new code for every winner')
        .setStringSelectMenuComponent(select),
      new LabelBuilder().setLabel('Discount %')
        .setDescription('Only for Discount, from 1 to 100')
        .setTextInputComponent(discount),
    );
}

function expectedError(message) {
  return new CloudyError(message, ErrorTypes.VALIDATION, message, { expected: true });
}

export function readGiveawayCodeModal(interaction) {
  const codeType = String(interaction.fields.getStringSelectValues('codeType')?.[0] || '');
  if (!Object.hasOwn(GIVEAWAY_CODE_TYPES, codeType)) throw expectedError('Choose a code type.');
  if (codeType !== 'discount') return { codeType, codeDiscount: null };
  const raw = String(interaction.fields.getTextInputValue('codeDiscount') || '').replace('%', '').trim();
  const codeDiscount = validDiscount(raw);
  if (!codeDiscount) throw expectedError('Enter a discount from 1 to 100 for a Discount code.');
  return { codeType, codeDiscount };
}

// Discord allows 25 options in one list.
export const GIVEAWAY_COUNTRIES = Object.freeze([
  'Austria', 'Belgium', 'Canada', 'Czech Republic', 'Denmark', 'Finland', 'France', 'Germany',
  'Greece', 'Ireland', 'Italy', 'Luxembourg', 'Morocco', 'Netherlands', 'Norway', 'Poland',
  'Portugal', 'Romania', 'Spain', 'Sweden', 'Switzerland', 'Turkey', 'United Kingdom',
  'United States', 'Other',
]);

export function giveawayCountryModal(messageId) {
  return new ModalBuilder()
    .setCustomId(`giveaway_country:${messageId}`)
    .setTitle('Enter giveaway')
    .addLabelComponents(
      new LabelBuilder().setLabel('Country')
        .setDescription('Choose the country you live in')
        .setStringSelectMenuComponent(new StringSelectMenuBuilder()
          .setCustomId('country')
          .setPlaceholder('Choose a country')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(GIVEAWAY_COUNTRIES.map(country => ({ label: country, value: country })))),
      new LabelBuilder().setLabel('Other country')
        .setDescription('Only when you chose Other')
        .setTextInputComponent(new TextInputBuilder()
          .setCustomId('otherCountry')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(60)),
    );
}

export function readGiveawayCountryModal(interaction) {
  const choice = String(interaction.fields.getStringSelectValues('country')?.[0] || '');
  if (!GIVEAWAY_COUNTRIES.includes(choice)) throw expectedError('Choose your country.');
  if (choice !== 'Other') return choice;
  const other = String(interaction.fields.getTextInputValue('otherCountry') || '')
    .replace(/[`*_~|<>@#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!other) throw expectedError('Type your country in Other country.');
  return other;
}
