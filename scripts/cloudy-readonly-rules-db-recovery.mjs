
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:20000 });
const old='1533189582064062564';
const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const q = await client.query(
    `SELECT 'temp_data' source,key,value,created_at FROM temp_data
      WHERE value::text LIKE $1
         OR value::text LIKE $2
         OR value::text LIKE $3
     UNION ALL
     SELECT 'cache_data' source,key,value,created_at FROM cache_data
      WHERE value::text LIKE $1
         OR value::text LIKE $2
         OR value::text LIKE $3
     ORDER BY source,key
     LIMIT 200`,
    [
      `%"channelId":"${old}"%`,
      `%"channel_id":"${old}"%`,
      `%"backingChannelId":"${old}"%`
    ]
  );
  console.error('RULES_OLD_CHANNEL_OBJECT_MATCHES '+JSON.stringify(q.rows));
  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
