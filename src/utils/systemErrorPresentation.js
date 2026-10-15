const LOGO_URL = 'https://cdn.jsdelivr.net/gh/Dylano24/Cloudy@f2fc2ba3873d420bcdda0e3ea260cf5d312e528a/assets/cloudy-c-logo-auf-auf.gif';
const FOOTER = '© Cloudy Inc. • Quality. Innovation. Performance.';

// These error identities must survive every outgoing template pass.
export function preserveSystemErrorPresentation(data) {
  const title = String(data?.title || '').trim().toLowerCase();
  if (!['something went wrong', 'permission denied'].includes(title)) return null;
  return {
    ...data,
    title: title === 'permission denied' ? 'Permission denied' : 'Something went wrong',
    thumbnail: { url: LOGO_URL },
    footer: { text: FOOTER },
  };
}
