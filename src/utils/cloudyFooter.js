import { REST } from '@discordjs/rest';

export const CLOUDY_STANDARD_FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';
const MARKER = Symbol.for('cloudy.standard-footer-output');

export function withCloudyFooter(payload, { plainText = true } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Array.isArray(payload.embeds) && payload.embeds.length) {
    return { ...payload, embeds: payload.embeds.map(embed => {
      const data = { ...(embed.toJSON?.() || embed) };
      const previous = data.footer?.text;
      if (previous && /\b(close|closes|closed|expire|expires|available in|page\s+\d+|dashboard closes|ticket id)\b/i.test(previous)) {
        const fields = data.fields || [];
        if (fields.length < 25) data.fields = [...fields, { name: 'Information', value: previous.slice(0, 1024), inline: false }];
        else if ((data.description || '').length + previous.length + 2 <= 4096) data.description = `${data.description || ''}\n\n${previous}`;
      }
      return { ...data, footer: { text: CLOUDY_STANDARD_FOOTER } };
    }) };
  }
  if (!plainText || !payload.content?.trim?.() || payload.content.includes(CLOUDY_STANDARD_FOOTER) || (Number(payload.flags) & 32768)) return payload;
  const content = `${payload.content}\n\n${CLOUDY_STANDARD_FOOTER}`;
  return content.length <= 2000 ? { ...payload, content } : { ...payload, embeds: [{ description: '\u200b', footer: { text: CLOUDY_STANDARD_FOOTER } }] };
}

export function installCloudyFooterOutput() {
  const prototype = REST.prototype;
  if (prototype[MARKER]) return;
  const original = prototype.request;
  prototype.request = function requestWithCloudyFooter(options) {
    const route = String(options.fullRoute || '');
    const isMessage = /^\/(?:channels\/\d+\/messages(?:\/\d+)?|webhooks\/\d+\/[^/]+(?:\/messages\/[^/]+)?)$/.test(route);
    const isCallback = /^\/interactions\/\d+\/[^/]+\/callback$/.test(route);
    if (isMessage && ['POST', 'PATCH'].includes(options.method)) options = { ...options, body: withCloudyFooter(options.body, { plainText: options.method === 'POST' }) };
    else if (isCallback && [4, 7].includes(options.body?.type)) options = { ...options, body: { ...options.body, data: withCloudyFooter(options.body.data) } };
    return original.call(this, options);
  };
  Object.defineProperty(prototype, MARKER, { value: true });
}
