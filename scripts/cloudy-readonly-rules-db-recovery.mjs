
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:20000 });

const needles = [
  'No Racism or Hate Speech',
  'Racist or hateful behavior is strictly prohibited',
  'Respect and kindness toward others are mandatory',
  'No Doxxing or Sharing Personal Information',
  'Sharing private information (names, addresses, phone numbers) is forbidden',
  'Violations will result in immediate action',
  'No NSFW or Disturbing Content',
  'Explicit or inappropriate content is not allowed',
  'Keep the environment safe and respectful',
  'Discord Rules'
];

const client=await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const patterns = needles.map(x => '%' + x.toLowerCase() + '%');
  const q = await client.query(
    `SELECT 'temp_data' source,key,value,created_at FROM temp_data
       WHERE EXISTS (
         SELECT 1 FROM unnest($1::text[]) p
         WHERE lower(value::text) LIKE p
       )
     UNION ALL
     SELECT 'cache_data' source,key,value,created_at FROM cache_data
       WHERE EXISTS (
         SELECT 1 FROM unnest($1::text[]) p
         WHERE lower(value::text) LIKE p
       )
     ORDER BY created_at ASC
     LIMIT 200`,
    [patterns]
  );
  console.error('RULES_PHRASE_MATCHES '+JSON.stringify(q.rows));
  await client.query('ROLLBACK');
} finally {
  client.release();
  await pool.end();
}
