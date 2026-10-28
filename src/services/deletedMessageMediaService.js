const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 24 * 1024 * 1024;
const MEDIA_TYPE = /^(image|video)\//i;
const DISCORD_MEDIA_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

function baseType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function discordUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && DISCORD_MEDIA_HOSTS.includes(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

// The downloaded body must be the file Discord described. A CDN error page
// (text/html) is never re-uploaded as if it were the deleted attachment.
function acceptedType(declared, received) {
  const expected = baseType(declared);
  const actual = baseType(received);
  if (MEDIA_TYPE.test(expected)) return MEDIA_TYPE.test(actual) ? null : 'not a photo or video';
  if (actual === 'text/html' && expected !== 'text/html') return 'no longer available';
  if (expected && actual && expected !== actual) return 'file type changed';
  return null;
}

async function download(url, limit, declaredType, fetchFile) {
  const response = await fetchFile(url.href, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error('no longer available');
  const type = response.headers.get('content-type') || declaredType || '';
  const rejected = acceptedType(declaredType || type, type);
  if (rejected) throw new Error(rejected);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('too large for the log upload');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel?.().catch(() => {}); throw new Error('too large for the log upload'); }
    chunks.push(Buffer.from(chunk));
  }
  if (!size) throw new Error('empty file');
  return { buffer: Buffer.concat(chunks), size };
}

/**
 * Copies a deleted message's attachments (photos, videos and other files)
 * into the log upload. Works for live attachments and for the attachment
 * list of a stored message snapshot. Files Discord no longer serves, or that
 * exceed the upload limit, are listed as links instead.
 */
export async function prepareDeletedMessageMedia(message, fetchFile = fetch) {
  const files = [], links = [];
  let remaining = MAX_TOTAL_MEDIA_BYTES;
  for (const attachment of message?.attachments?.values?.() || []) {
    if (!attachment?.url) continue;
    let name = String(attachment.name || 'media').replace(/[\\/\r\n]/g, '_');
    try {
      const primary = discordUrl(attachment.url);
      if (!attachment.name) name = String(new URL(attachment.url).pathname.split('/').at(-1) || name).replace(/[\\/\r\n]/g, '_');
      const fallback = discordUrl(attachment.proxyURL);
      if (!primary && !fallback) throw new Error('unavailable');
      const limit = Math.min(MAX_MEDIA_BYTES, remaining);
      if (attachment.size > limit) throw new Error('too large for the log upload');
      let copied = null;
      let lastError = null;
      for (const url of [primary, fallback].filter(Boolean)) {
        try {
          copied = await download(url, limit, attachment.contentType, fetchFile);
          break;
        } catch (error) {
          lastError = error;
          // Size and type answers are final; only availability may differ.
          if (error.message !== 'no longer available') break;
        }
      }
      if (!copied) throw lastError || new Error('no longer available');
      files.push({ attachment: copied.buffer, name, description: attachment.description || undefined });
      remaining -= copied.size;
    } catch (error) {
      links.push(`${name}: ${attachment.url} (${error.message})`);
    }
  }
  return { files, links };
}
