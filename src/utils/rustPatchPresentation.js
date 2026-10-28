export function stripRustPatchLogo(data) {
  if (!/^https:\/\/rust\.facepunch\.com\/news\//i.test(data?.url || '')) return data;
  const next = { ...data };
  delete next.thumbnail;
  for (const key of ['author', 'footer']) {
    if (!next[key]) continue;
    next[key] = { ...next[key] };
    delete next[key].icon_url;
    delete next[key].iconURL;
    delete next[key].proxy_icon_url;
  }
  return next;
}
