
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
const registryKey = `cloudy:embed-registry:${guildId}`;
const globalTemplateKey = `cloudy:embed-template:${guildId}:__global__`;

const client = await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  const exact = await client.query(
    `SELECT 'temp_data' AS source, key, value, created_at
       FROM temp_data
      WHERE key = ANY($1::text[])
     UNION ALL
     SELECT 'cache_data' AS source, key, value, created_at
       FROM cache_data
      WHERE key = ANY($1::text[])
      ORDER BY source, key`,
    [[exactTemplateKey, registryKey, globalTemplateKey]],
  );

  const targeted = await client.query(
    `SELECT 'temp_data' AS source, key, value, created_at
       FROM temp_data
      WHERE key ILIKE '%embed%'
        AND (
          key ILIKE '%rules%'
          OR value::text ILIKE $1
          OR value::text ILIKE $2
          OR value::text ILIKE '%"rules"%'
          OR value::text ILIKE '%discord rules%'
        )
     UNION ALL
     SELECT 'cache_data' AS source, key, value, created_at
       FROM cache_data
      WHERE key ILIKE '%embed%'
        AND (
          key ILIKE '%rules%'
          OR value::text ILIKE $1
          OR value::text ILIKE $2
          OR value::text ILIKE '%"rules"%'
          OR value::text ILIKE '%discord rules%'
        )
      ORDER BY source, key
      LIMIT 200`,
    [`%${oldRulesChannelId}%`, `%${rulesEmojiId}%`],
  );

  const broad = await client.query(
    `SELECT 'temp_data' AS source, key, value, created_at
       FROM temp_data
      WHERE key ILIKE '%rules%'
         OR value::text ILIKE $1
         OR value::text ILIKE $2
     UNION ALL
     SELECT 'cache_data' AS source, key, value, created_at
       FROM cache_data
      WHERE key ILIKE '%rules%'
         OR value::text ILIKE $1
         OR value::text ILIKE $2
      ORDER BY source, key
      LIMIT 200`,
    [`%${oldRulesChannelId}%`, `%${rulesEmojiId}%`],
  );

  const guild = await client.query(
    `SELECT id, config, counters, created_at, updated_at
       FROM guilds
      WHERE id = $1`,
    [guildId],
  );

  console.error('RULES_DB_EXACT ' + JSON.stringify(exact.rows));
  console.error('RULES_DB_TARGETED ' + JSON.stringify(targeted.rows));
  console.error('RULES_DB_BROAD ' + JSON.stringify(broad.rows));
  console.error('RULES_DB_GUILD_MATCHES ' + JSON.stringify(
    guild.rows.map(row => ({
      id: row.id,
      configMatches: /rules|1533189582064062564|1324217883047362590/i.test(JSON.stringify(row.config || {})),
      config: /rules|1533189582064062564|1324217883047362590/i.test(JSON.stringify(row.config || {})) ? row.config : null,
      countersMatches: /rules|1533189582064062564|1324217883047362590/i.test(JSON.stringify(row.counters || [])),
      counters: /rules|1533189582064062564|1324217883047362590/i.test(JSON.stringify(row.counters || [])) ? row.counters : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }))
  ));

  await client.query('ROLLBACK');
} finally {
  client.release();
  await pool.end();
}
