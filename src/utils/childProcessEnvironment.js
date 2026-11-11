// Media tools (ffmpeg, ffprobe, yt-dlp, gallery-dl) read files and web pages
// that come from outside Cloudy. They never need Cloudy's own credentials, so
// those are not handed to them: a fault in such a tool must not be able to
// read the bot token, the database address or an API key from its environment.
//
// Variables are dropped by name. Everything a tool does need (PATH, HOME,
// language, certificate and Python settings) has no such name and is kept.
const CREDENTIAL_NAME = new RegExp([
  'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL', 'PRIVATE', 'ENCRYPTION', 'WEBHOOK', 'COOKIE', 'AUTH',
  'API_?KEY', '_KEY$', '^KEY_',
  'DATABASE', 'POSTGRES', '^PG[A-Z]', 'REDIS', 'MONGO',
  '_URL$', '_URI$', '_DSN$',
].join('|'), 'i');

export function isCredentialVariable(name) {
  return CREDENTIAL_NAME.test(String(name || ''));
}

/** The environment for a media tool: the given one without credentials. */
export function withoutCredentials(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !isCredentialVariable(name)));
}
