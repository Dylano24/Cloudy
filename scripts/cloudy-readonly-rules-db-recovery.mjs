
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:20000 });
const needles = [
  'Discord Rules',
  'No Racism or Hate Speech',
  'Racist or hateful behavior is strictly prohibited',
  'No Doxxing or Sharing Personal Information',
  'Sharing private information',
  'No NSFW or Disturbing Content',
  'Keep the environment safe and respectful'
];
const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  for (const needle of needles) {
    const pattern = '%' + needle + '%';
    const q = await client.query(
      `SELECT 'temp_data' AS source,key,value,created_at FROM temp_data WHERE value::text ILIKE $1
       UNION ALL
       SELECT 'cache_data' AS source,key,value,created_at FROM cache_data WHERE value::text ILIKE $1
       ORDER BY source,key
       LIMIT 200`,
      [pattern]
    );
    console.error('RULES_PHRASE_MATCH ' + JSON.stringify({needle,rows:q.rows}));
  }
  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
