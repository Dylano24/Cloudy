
import pg from 'pg';
const { Pool } = pg;
const url=String(process.env.POSTGRES_URL||process.env.DATABASE_URL||'').trim();
if(!url) throw new Error('NO_POSTGRES_URL');

const emoji='1543287452410716160';
const messageId='1543364112019488909';
const oldRulesChannel='1533189582064062564';
const pool=new Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:1,statement_timeout:20000});
const client=await pool.connect();

function walk(value,path='$',out=[]){
  if(value==null) return out;
  if(Array.isArray(value)){
    value.forEach((v,i)=>walk(v, path+'['+i+']', out));
    return out;
  }
  if(typeof value!=='object') return out;

  const raw=JSON.stringify(value);
  const title=String(value.title||'');
  const name=String(value.name||'');
  if(
    raw.includes(emoji) ||
    raw.includes(messageId) ||
    raw.includes(oldRulesChannel) ||
    /discord\s*rules/i.test(title) ||
    /discord\s*rules/i.test(name)
  ){
    out.push({path,value});
  }
  for(const [k,v] of Object.entries(value)){
    if(v && typeof v==='object') walk(v,path+'.'+k,out);
  }
  return out;
}

try{
  await client.query('BEGIN TRANSACTION READ ONLY');
  const q=await client.query(
    `SELECT 'temp_data' source,key,value,created_at FROM temp_data
      WHERE value::text ILIKE $1
         OR value::text ILIKE $2
         OR value::text ILIKE $3
         OR value::text ILIKE '%discord rules%'
     UNION ALL
     SELECT 'cache_data' source,key,value,created_at FROM cache_data
      WHERE value::text ILIKE $1
         OR value::text ILIKE $2
         OR value::text ILIKE $3
         OR value::text ILIKE '%discord rules%'
     ORDER BY created_at ASC`,
    ['%'+emoji+'%','%'+messageId+'%','%'+oldRulesChannel+'%']
  );

  const matches=[];
  for(const row of q.rows){
    for(const hit of walk(row.value)){
      const v=hit.value;
      const raw=JSON.stringify(v);
      if(
        raw.includes(emoji) ||
        raw.includes(messageId) ||
        /discord\s*rules/i.test(String(v.title||'')) ||
        /discord\s*rules/i.test(String(v.name||'')) ||
        (
          String(v.channelId||'')===oldRulesChannel &&
          String(v.messageId||'')===messageId
        )
      ){
        matches.push({
          source:row.source,
          key:row.key,
          created_at:row.created_at,
          path:hit.path,
          value:v
        });
      }
    }
  }
  console.error('EXACT_CLOUDY_RULES_RECOVERY '+JSON.stringify(matches));
  await client.query('ROLLBACK');
}finally{
  client.release();
  await pool.end();
}
