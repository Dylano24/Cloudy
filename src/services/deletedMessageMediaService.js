const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 24 * 1024 * 1024;
const MEDIA_TYPE = /^(image|video)\//i;

export async function prepareDeletedMessageMedia(message, fetchFile = fetch) {
  const files = [], links = [];
  let remaining = MAX_TOTAL_MEDIA_BYTES;
  for (const attachment of message.attachments?.values?.() || []) {
    if (!attachment.url) continue;
    let name = String(attachment.name || 'media').replace(/[\\/\r\n]/g, '_');
    try {
      const url = new URL(attachment.url);
      if (!attachment.name) name = url.pathname.split('/').at(-1) || name;
      if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) throw new Error('unavailable');
      if (attachment.contentType && !MEDIA_TYPE.test(attachment.contentType)) throw new Error('not a photo or video');
      const limit = Math.min(MAX_MEDIA_BYTES, remaining);
      if (attachment.size > limit) throw new Error('too large for the log upload');
      const response = await fetchFile(url.href, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!response.ok) throw new Error('no longer available');
      const type = response.headers.get('content-type') || attachment.contentType || '';
      if (!MEDIA_TYPE.test(type)) throw new Error('not a photo or video');
      if (Number(response.headers.get('content-length')) > limit) throw new Error('too large for the log upload');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) { await response.body.cancel().catch(() => {}); throw new Error('too large for the log upload'); }
        chunks.push(Buffer.from(chunk));
      }
      if (!size) throw new Error('empty file');
      files.push({ attachment: Buffer.concat(chunks), name, description: attachment.description || undefined });
      remaining -= size;
    } catch (error) {
      links.push(`${name}: ${attachment.url} (${error.message})`);
    }
  }
  return { files, links };
}
