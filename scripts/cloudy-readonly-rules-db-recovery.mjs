
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');
const pool = new Pool({ connectionString:url, ssl:{rejectUnauthorized:false}, max:1, statement_timeout:20000 });
const client = await pool.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const terms = [
    'Racist or hateful behavior is strictly prohibited',
    'No Doxxing or Sharing Personal Information',
    'No NSFW or Disturbing Content',
    'Respect and kindness toward others are mandatory',
    'Violations will result in immediate action',
    'Keep the environment safe and respectful'
  ];
  const rows = [];
  for (const term of terms) {
    const q = await client.query(
      `SELECT 'temp_data' source,key,value,created_at FROM temp_data WHERE value::text ILIKE $1
       UNION ALL
       SELECT 'cache_data' source,key,value,created_at FROM cache_data WHERE value::text ILIKE $1
       ORDER BY source,key LIMIT 100`,
      [`%${term}%`]
    );
    rows.push({term, matches:q.rows});
  }
  const guild = await client.query(
    `SELECT id, config, counters, created_at, updated_at
       FROM guilds
      WHERE id='1532882647838228723'`
  );
  const guildText = guild.rows.map(row=>({id:row.id,
    configMatches:terms.filter(t=>JSON.stringify(row.config||{}).toLowerCase().includes(t.toLowerCase())),
    countersMatches:terms.filter(t=>JSON.stringify(row.counters||[]).toLowerCase().includes(t.toLowerCase()))
  }));
  console.error('RULES_PHRASE_RECOVERY '+JSON.stringify(rows));
  console.error('RULES_PHRASE_GUILD '+JSON.stringify(guildText));
  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
