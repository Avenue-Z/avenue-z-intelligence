import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Store} from '../../lib/server/store';
import type {QueryFilters} from '../../lib/analytics/contracts';

// Removing the migration must change these real Store query plans back to
// snapshot/date scans, even though the selected result values stay correct.
const filters:QueryFilters={from:'2026-10-11',to:'2026-10-11',compare:'previous',mode:'closed',view:'traffic',market:'',stream:'',source:'',device:'',page:''};

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const plans:{sql:string;details:string[]}[]=[];
  const prepare=(sql:string)=>{
    let values:any[]=[];
    const statement={
      bind(...input:any[]){values=input;return statement;},
      async first(){return sqlite.prepare(sql).get(...values)??null;},
      async all(){
        if(sql.startsWith('SELECT o.payload'))plans.push({sql,details:sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row=>String(row.detail))});
        return {results:sqlite.prepare(sql).all(...values)};
      },
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}
    };
    return statement;
  };
  sqlite.prepare('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?)').run('snapshot','org','client','source','2026-10-12T00:00:00Z',1,'ready','unused');
  const insert=sqlite.prepare('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)');
  for(const date of ['2026-09-15','2026-09-16',filters.to]){
    sqlite.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?)').run('org','client','source',date,'snapshot');
    const row=(dataset:string,value:number)=>JSON.stringify({date,dataset,metric:'sessions',value,dimensions:{},definition:'test',population:'test',currency:null,sourceId:'source',retrievedAt:'2026-10-12T00:00:00Z',coverageThrough:'2026-10-12T00:00:00Z',quality:'complete'});
    // These keys intentionally do not encode the dataset, including a misleading prefix.
    insert.run('snapshot',date,'legacy-row-with-no-dataset',row('overview',7));
    insert.run('snapshot',date,'["products","not-the-dataset"]',row('traffic',11));
    for(let i=0;i<500;i++)insert.run('snapshot',date,`unrelated-${i}`,row('products',1));
  }
  return {sqlite,plans,store:new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))})};
}

it.each([{datasets:['overview']},{datasets:['overview','traffic']}])('seeks selected datasets $datasets for both direct and grouped Store reads without assuming row-key prefixes',async({datasets})=>{
  const {sqlite,plans,store}=fixture();
  try{
    const rows=await store.observations('org','client',filters,false,undefined,{datasets});
    expect(rows.filter(row=>row.dataset==='overview')).toHaveLength(3);
    expect(rows.filter(row=>row.dataset==='traffic')).toHaveLength(datasets.includes('traffic')?1:0);
    expect(rows.some(row=>row.dataset==='products')).toBe(false);
    expect(plans.some(plan=>plan.sql.includes('FROM observations o'))).toBe(true);
    expect(plans.some(plan=>plan.sql.includes('FROM json_each(?) p JOIN observations'))).toBe(true);
    for(const plan of plans){
      expect(plan.details.join('\n')).toMatch(/SEARCH o USING INDEX idx_observations_snapshot_date_dataset_rowkey \(snapshotId=\? AND date=\? AND <expr>=\?/);
    }
  }finally{sqlite.close();}
});

it('continues a multi-dataset selection across row-key pages without omissions or duplicates',async()=>{
  const {sqlite,plans,store}=fixture();
  try{
    const insert=sqlite.prepare('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)');
    const payload=String(sqlite.prepare('SELECT payload FROM observations WHERE snapshotId=? AND date=? AND rowKey=?').get('snapshot',filters.to,'["products","not-the-dataset"]')!.payload);
    for(let i=0;i<2001;i++)insert.run('snapshot',filters.to,`opaque-page-${String(i).padStart(4,'0')}`,JSON.stringify({...JSON.parse(payload),dimensions:{page:`/test-${i}`}}));
    const rows=await store.observations('org','client',filters,false,undefined,{datasets:['overview','traffic']});
    expect(rows).toHaveLength(2005);
    expect(rows.filter(row=>row.dataset==='traffic')).toHaveLength(2002);
    expect(new Set(rows.filter(row=>row.dataset==='traffic').map(row=>row.dimensions.page??'original')).size).toBe(2002);
    expect(plans.some(plan=>plan.sql.includes('o.rowKey>?'))).toBe(true);
    for(const plan of plans)expect(plan.details.join('\n')).toContain('USING INDEX idx_observations_snapshot_date_dataset_rowkey');
  }finally{sqlite.close();}
});
