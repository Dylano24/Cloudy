
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:30000 });

const messageId='1543364112019488909';
const oldRules='1533189582064062564';
const titleNeedle='Discord rules';

const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  const matches = await client.query(
    `
    SELECT source,key,created_at,
           jsonb_typeof(value) AS value_type,
           value
    FROM (
      SELECT 'temp_data'::text AS source,key,created_at,value FROM temp_data
      UNION ALL
      SELECT 'cache_data'::text AS source,key,created_at,value FROM cache_data
    ) x
    WHERE value::text ILIKE $1
       OR value::text ILIKE $2
       OR (
          key LIKE 'cloudy:recovery-backup:%'
          AND value::text ILIKE $3
       )
    ORDER BY source,key
    LIMIT 200
    `,
    ['%'+messageId+'%','%'+oldRules+'%','%'+titleNeedle+'%']
  );

  const compact = matches.rows.map(r => ({
    source:r.source,
    key:r.key,
    created_at:r.created_at,
    value_type:r.value_type,
    value: r.value
  }));
  console.error('RULES_MESSAGE_ID_MATCHES ' + JSON.stringify(compact));

  const keys = await client.query(
    `
    SELECT 'temp_data' source,key,created_at FROM temp_data
     WHERE key ILIKE '%rule%' OR key ILIKE '%embed%' AND value::text ILIKE '%Discord rules%'
    UNION ALL
    SELECT 'cache_data' source,key,created_at FROM cache_data
     WHERE key ILIKE '%rule%' OR key ILIKE '%embed%' AND value::text ILIKE '%Discord rules%'
    ORDER BY source,key
    LIMIT 300
    `
  );
  console.error('RULES_RELATED_KEYS ' + JSON.stringify(keys.rows));

  await client.query('ROLLBACK');
} finally {
  client.release();
  await pool.end();
}
