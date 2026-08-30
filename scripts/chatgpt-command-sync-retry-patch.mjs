import fs from 'node:fs/promises';

const file = 'scripts/register-cloudy-guild-commands.js';
let source = await fs.readFile(file, 'utf8');

if (!source.includes('const RATE_LIMIT_RETRIES = 4;')) {
  throw new Error('Expected validated RATE_LIMIT_RETRIES = 4 baseline not found');
}

source = source.replace(
  'const RATE_LIMIT_RETRIES = 4;',
  'const RATE_LIMIT_RETRIES = 10;',
);

await fs.writeFile(file, source);
