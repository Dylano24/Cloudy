import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { decorateEmbedWithSavedTemplate } from './embedTemplateService.js';

export function fillIncomingPaymentTemplate(data, { senderName, amount, newCash }) {
  const format = value => '$' + value.toLocaleString('en-US');
  const sender = escapeMarkdown(String(senderName || 'A member'));
  const payment = format(amount);
  const balance = format(newCash);
  const originalDescription = `${sender} paid you **${payment}**.`;
  const next = { ...data };
  const savedDescription = String(data.description || '');
  let index = 0;
  const rendered = savedDescription.replace(/\{dynamic\}/gi, () => [sender, payment][index++] ?? '');
  // Never expose raw placeholders or silently drop the payment details.
  next.description = index === 2 && rendered.includes(sender) && rendered.includes(payment)
    ? rendered : originalDescription;
  const fields = Array.isArray(data.fields) ? data.fields : [];
  next.fields = fields.length ? fields.map((field, position) => ({
    ...field,
    value: position === 0
      ? String(field.value || '').replace(/\{dynamic\}/gi, balance) : field.value,
  })) : [{ name: 'Your new cash', value: balance, inline: true }];
  // A static or malformed saved field must never show an old balance.
  next.fields[0].value = next.fields[0].value.includes(balance)
    && !/\{dynamic\}/i.test(next.fields[0].value)
    ? next.fields[0].value : balance;
  return next;
}

export async function buildIncomingPaymentDm({
  guildId, channelId, senderName, amount, newCash,
}) {
  // Use the same source identity as the system Embed Builder template.
  // Dynamic tokens are filled *after* saved styling is applied so that
  // sender, payment amount and balance cannot become stale snapshots.
  const base = createEmbed({
    title: 'Incoming payment',
    description: '{dynamic} paid you **{dynamic}**.',
    fields: [{ name: 'Your new cash', value: '{dynamic}', inline: true }],
  });
  const saved = await decorateEmbedWithSavedTemplate(guildId, channelId, base);
  return new EmbedBuilder(fillIncomingPaymentTemplate(saved.embed.toJSON(), { senderName, amount, newCash }));
}
