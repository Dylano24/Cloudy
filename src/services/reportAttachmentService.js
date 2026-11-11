// Photos and videos of a reported message. Discord removes an attachment's
// link once its message is deleted (and signed links expire), so at report
// time Cloudy keeps its own copy: pictures as a Cloudy media link, videos on
// Cloudy's video page. The report notices link to those copies, so the photo
// or video still opens after staff deleted the message.
import { prepareDeletedMessageMedia } from './deletedMessageMediaService.js';
import { storeEmbedMediaBuffer } from './embedMediaStorageService.js';
import { storeDeletedVideo } from './deletedMediaService.js';
import { logger } from '../utils/logger.js';

const MAX_ATTACHMENTS = 4;

/** [{ name, url }] for a reported message's attachments; never throws. */
export async function preserveReportAttachments(message, { fetchFile = fetch } = {}) {
  const attachments = [...(message?.attachments?.values?.() || [])].filter(item => item?.url).slice(0, MAX_ATTACHMENTS);
  if (!attachments.length) return [];
  return Promise.all(attachments.map(async item => {
    const name = String(item.name || 'attachment').replace(/[[\]\r\n]/g, '_').slice(0, 100);
    try {
      // One attachment at a time, so each copy belongs to its own original.
      const media = await prepareDeletedMessageMedia({ attachments: new Set([item]) }, fetchFile);
      const file = media.files[0];
      const video = media.videos[0];
      const stored = !file ? null
        : video ? await storeDeletedVideo(file.attachment, { name, contentType: video.type })
          : media.images.length ? await storeEmbedMediaBuffer(file.attachment) : null;
      if (stored) return { name, url: stored };
    } catch (error) {
      logger.warn(`Reported attachment ${name} could not be copied: ${error?.message || error}`);
    }
    // No copy possible (no media volume, not a photo or video): the original link.
    return { name, url: item.url };
  }));
}

/** The attachment lines shown under "Reported message". */
export function reportAttachmentLines(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter(item => /^https:\/\//.test(String(item?.url || '')))
    .map(item => `[${item.name || 'Attachment'}](${item.url})`);
}
