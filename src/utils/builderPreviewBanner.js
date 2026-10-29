// Embed Builder preview only. After Post/Save a newly uploaded banner moves to
// Cloudy's permanent link, which Discord must fetch before it can show it.
// The private preview keeps showing the same picture from Discord's own upload
// link, so it appears at once. The posted message always uses the permanent link.
const DISCORD_UPLOAD = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/ephemeral-attachments\//i;

export function rememberPreviewBanner(state, permanentUrl, discordUrl) {
  if (!state) return;
  state.previewBanner = permanentUrl && DISCORD_UPLOAD.test(String(discordUrl || ''))
    ? { permanentUrl: String(permanentUrl), discordUrl: String(discordUrl) }
    : null;
}

export function previewBannerUrl(state) {
  const url = state?.mediaUrl || null;
  const banner = state?.previewBanner;
  return banner && url && String(url) === banner.permanentUrl ? banner.discordUrl : url;
}
