
import pg from 'pg';
const { Pool } = pg;
const url = String(process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('NO_POSTGRES_URL');

const guild='1532882647838228723';
const oldRules='1533189582064062564';
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:1,statement_timeout:20000});
const client=await pool.connect();

try {
  await client.query('BEGIN TRANSACTION READ ONLY');

  const keyed = await client.query(
    `SELECT 'temp_data' source,key,value,created_at
       FROM temp_data
      WHERE key LIKE $1
         OR key LIKE $2
     UNION ALL
     SELECT 'cache_data' source,key,value,created_at
       FROM cache_data
      WHERE key LIKE $1
         OR key LIKE $2
      ORDER BY created_at ASC`,
    [
      `%cloudy:embed-template:${guild}:${oldRules}`,
      `%cloudy:embed-registry:${guild}`
    ]
  );

  const extracted=[];
  for (const row of keyed.rows) {
    const value=row.value;
    if (Array.isArray(value)) {
      for (const record of value) {
        const raw=JSON.stringify(record);
        if (
          String(record?.channelId||'')===oldRules ||
          String(record?.backingChannelId||'')===oldRules ||
          /discord rules|(^|\s)rules($|\s)/i.test(String(record?.name||'')) ||
          /discord rules|(^|\s)rules($|\s)/i.test(String(record?.title||'')) ||
          raw.includes(oldRules)
        ) {
          extracted.push({source:row.source,key:row.key,created_at:row.created_at,record});
        }
      }
    } else if (value && typeof value==='object') {
      const raw=JSON.stringify(value);
      if (row.key.includes(oldRules) || raw.includes(oldRules) || /discord rules/i.test(raw)) {
        extracted.push({source:row.source,key:row.key,created_at:row.created_at,value});
      }
    }
  }

  const oldKeyRows=keyed.rows.filter(row=>row.key.includes(oldRules));
  console.error('RULES_BACKUP_KEY_ROWS '+JSON.stringify(oldKeyRows));
  console.error('RULES_BACKUP_EXTRACTED '+JSON.stringify(extracted));

  await client.query('ROLLBACK');
} finally {
  client.release();
  await pool.end();
}
