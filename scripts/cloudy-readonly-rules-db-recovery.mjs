
import pg from 'pg';

const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');

const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 1,
  statement_timeout: 20000,
});

const guildId = '1532882647838228723';
const oldRulesChannelId = '1533189582064062564';
const rulesEmojiId = '1324217883047362590';
const exactTemplateKey = `cloudy:embed-template:${guildId}:${oldRulesChannelId}`;

const client = await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  const exact = await client.query(
    `SELECT key, value, created_at
       FROM temp_data
      WHERE key = $1`,
    [exactTemplateKey],
  );

  const emojiMatches = await client.query(
    `SELECT key, value, created_at
       FROM temp_data
      WHERE value::text LIKE $1
      ORDER BY created_at ASC
      LIMIT 100`,
    [`%${rulesEmojiId}%`],
  );

  const rulesNamedTemplates = await client.query(
    `SELECT key, value, created_at
       FROM temp_data
      WHERE key LIKE $1
        AND (
          value::text ILIKE '%"title":"%rules%'
          OR value::text ILIKE '%"name":"%rules%'
          OR value::text ILIKE '%discord server rules%'
          OR value::text ILIKE '%server rules%'
        )
      ORDER BY created_at ASC
      LIMIT 100`,
    [`cloudy:embed-template:${guildId}:%`],
  );

  console.error('RULES_EXACT_TEMPLATE_ONLY ' + JSON.stringify(exact.rows));
  console.error('RULES_EMOJI_MATCHES_ONLY ' + JSON.stringify(emojiMatches.rows));
  console.error('RULES_NAMED_TEMPLATES_ONLY ' + JSON.stringify(rulesNamedTemplates.rows));

  await client.query('ROLLBACK');
} finally {
  client.release();
  await pool.end();
}
