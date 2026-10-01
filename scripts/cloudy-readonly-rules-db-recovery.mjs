
import pg from 'pg';
const {Pool}=pg;
const url=String(process.env.POSTGRES_URL||process.env.DATABASE_URL||'').trim();
if(!url) throw new Error('NO_POSTGRES_URL');
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:1,statement_timeout:30000});
const terms=[
 'Respect the staff',
 'Respect the team',
 'their moderation actions',
 'Discord rules',
 'No Racism or Hate Speech',
 'No Doxxing or Sharing Personal Information',
 'No NSFW or Disturbing Content'
];
const client=await pool.connect();
try{
 await client.query('BEGIN TRANSACTION READ ONLY');
 const out=[];
 for(const term of terms){
   const q=await client.query(
     `SELECT 'temp_data' source,key,value,created_at FROM temp_data WHERE value::text ILIKE $1
      UNION ALL
      SELECT 'cache_data' source,key,value,created_at FROM cache_data WHERE value::text ILIKE $1
      ORDER BY created_at ASC LIMIT 100`,
     ['%'+term+'%']
   );
   out.push({term,matches:q.rows});
 }
 console.error('RULES_VISIBLE_TEXT_MATCHES '+JSON.stringify(out));
 await client.query('ROLLBACK');
}finally{client.release();await pool.end();}
