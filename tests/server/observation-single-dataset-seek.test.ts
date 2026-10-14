import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {Store} from '../../lib/server/store';
import type {QueryFilters} from '../../lib/analytics/contracts';

const filters:QueryFilters={from:'2026-10-14',to:'2026-10-14',compare:'previous',mode:'closed',view:'traffic',market:'',stream:'',source:'',device:'',page:''};
const selection={datasets:['overview','subscriptions','subscriptionEvents','traffic','creatives','funnels'],includePriorWeek:false,includeOperations:false,trendDatasets:[]};

async function fixture(dataset:string,qualifications:unknown[],count=4001,mixed=false){
  const sqlite=new DatabaseSync(':memory:');
  for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const plans:{sql:string;details:string[]}[]=[];
  const prepare=(sql:string)=>{
    let values:SQLInputValue[]=[];
    const statement={
      bind(...input:unknown[]){values=input as SQLInputValue[];return statement;},
      async first(){return sqlite.prepare(sql).get(...values)??null;},
      async all(){
        if(sql.startsWith('SELECT o.payload'))plans.push({sql,details:sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row=>String(row.detail))});
        return {results:sqlite.prepare(sql).all(...values)};
      },
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}
    };
    return statement;
  };
  const store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
  sqlite.prepare('INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,complete,status,objectKey) VALUES(?,?,?,?,?,?,?,?)').run('snapshot','org','client','source','2026-10-14T20:00:00Z',1,'ready','fixture');
  sqlite.prepare('INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES(?,?,?,?,?)').run('org','client','source',filters.to,'snapshot');
  for(const profiles of qualifications)await store.saveQualification('org','client','source',1,1,{profiles},'fixture');
  const insert=sqlite.prepare('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)');
  sqlite.exec('BEGIN');
  for(let index=0;index<count;index++)insert.run('snapshot',filters.to,`opaque-${String(index).padStart(5,'0')}`,JSON.stringify({date:filters.to,dataset:mixed&&index%2?'overview':dataset,metric:'sessions',value:index+1,definition:'test',population:'test',currency:null,dimensions:{page:`/page-${index}`},sourceId:'source',retrievedAt:'2026-10-14T20:00:00Z',coverageThrough:'2026-10-15T00:00:00Z',quality:'complete'}));
  sqlite.exec('COMMIT');
  return {sqlite,store,plans};
}

it.each(['traffic','creatives'])('seeks one qualified %s dataset without temporary sorting and preserves every raw observation across pages',async dataset=>{
  const qualified=await fixture(dataset,[[{dataset,metric:'sessions'},{dataset,metric:'other'}]]),legacy=await fixture(dataset,[]);
  try{
    const rows=await qualified.store.observations('org','client',filters,false,undefined,selection);
    const original=await legacy.store.observations('org','client',filters,false,undefined,selection);
    expect(rows).toEqual(original);
    expect(rows).toHaveLength(4001);
    expect(qualified.plans).toHaveLength(3);
    expect(qualified.plans.some(plan=>plan.sql.includes('o.rowKey>?'))).toBe(true);
    for(const plan of qualified.plans){
      expect(plan.details.join('\n')).toContain('USING INDEX idx_observations_snapshot_date_dataset_rowkey');
      expect(plan.details.join('\n')).not.toContain('TEMP B-TREE');
    }
    expect(legacy.plans.every(plan=>plan.details.some(detail=>detail.includes('TEMP B-TREE')))).toBe(true);
  }finally{qualified.sqlite.close();legacy.sqlite.close();}
});

it('narrows the registered/selected intersection only when it contains one dataset',async()=>{
  const {sqlite,store,plans}=await fixture('traffic',[[{dataset:'traffic',metric:'sessions'},{dataset:'products',metric:'orders'}]],3);
  try{
    expect(await store.observations('org','client',filters,false,undefined,selection)).toHaveLength(3);
    expect(plans).toHaveLength(1);
    expect(plans[0].details.join('\n')).not.toContain('TEMP B-TREE');
  }finally{sqlite.close();}
});

it.each([
  {name:'missing profiles',qualifications:[]},
  {name:'null profiles',qualifications:[null]},
  {name:'malformed profiles',qualifications:[[{dataset:'traffic'}]]},
  {name:'multiple selected datasets',qualifications:[[{dataset:'traffic',metric:'sessions'},{dataset:'overview',metric:'sessions'}]]},
  {name:'historical profile union',qualifications:[[{dataset:'traffic',metric:'sessions'}],[{dataset:'overview',metric:'sessions'}]]},
  {name:'incomplete historical profile',qualifications:[[{dataset:'traffic',metric:'sessions'}],null]}
])('keeps the original conservative query and mixed evidence for $name',async({qualifications})=>{
  const {sqlite,store,plans}=await fixture('traffic',qualifications,3,true);
  try{
    const rows=await store.observations('org','client',filters,false,undefined,selection);
    expect(rows).toHaveLength(3);
    expect(rows.some(row=>row.dataset==='overview')).toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0].details.join('\n')).toContain('TEMP B-TREE');
  }finally{sqlite.close();}
});

it('preserves market aliases and missing-dimension evidence with a single qualified dataset',async()=>{
  const qualified=await fixture('traffic',[[{dataset:'traffic',metric:'sessions'}]],4),legacy=await fixture('traffic',[],4);
  try{
    for(const {sqlite} of [qualified,legacy])for(const [index,market] of [[1,'FR'],[2,'France'],[3,'GB']] as const)sqlite.prepare("UPDATE observations SET payload=json_set(payload,'$.dimensions.market',?) WHERE rowKey=?").run(market,`opaque-${String(index).padStart(5,'0')}`);
    const selectedFilters={...filters,market:'FR'},selected={...selection,dimensions:true};
    const rows=await qualified.store.observations('org','client',selectedFilters,false,undefined,selected);
    expect(rows).toEqual(await legacy.store.observations('org','client',selectedFilters,false,undefined,selected));
    expect(rows.map(row=>row.dimensions.market).sort()).toEqual(['FR','France',undefined]);
    expect(qualified.plans[0].details.join('\n')).not.toContain('TEMP B-TREE');
  }finally{qualified.sqlite.close();legacy.sqlite.close();}
});
