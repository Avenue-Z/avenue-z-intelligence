import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {readTrendObservations} from '../../lib/server/trend-observations';
import {writeSnapshotDayProjection} from '../../lib/server/snapshot-day-projections';
import {observationCodec} from '../../lib/server/observation-codec';
import type {Observation,QueryFilters} from '../../lib/analytics/contracts';

const scope={organizationId:'agency',clientId:'kind-patches'},date='2026-10-10',snapshotId='history',sourceId='traffic';
const filters:QueryFilters={from:'2026-10-12',to:'2026-10-12',view:'traffic',compare:'previous',mode:'closed',market:'',stream:'',source:'',device:'',page:''};
const selection={datasets:['traffic'],trendDatasets:['traffic'],includePriorWeek:false,includeOperations:false};
afterEach(()=>{vi.restoreAllMocks();});
function database(){
 const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const reads:string[]=[],state:{afterRead:(sql:string)=>void}={afterRead:()=>{}};
 const prepare=(sql:string)=>{let values:SQLInputValue[]=[];const statement={bind(...input:unknown[]){values=input as SQLInputValue[];return statement;},async first(){reads.push(sql);const result=sqlite.prepare(sql).get(...values)??null;state.afterRead(sql);return result;},async all(){reads.push(sql);const results=sqlite.prepare(sql).all(...values);state.afterRead(sql);return {results};},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};}};return statement;};
 const store=new Store({prepare,batch:async statements=>Promise.all(statements.map(statement=>statement.run()))});
 sqlite.exec("INSERT INTO clients(id,organizationId,name,slug,timezone,currency,color,config) VALUES('kind-patches','agency','KP','kp','UTC','USD','blue','{}');INSERT INTO snapshots(id,organizationId,clientId,sourceId,retrievedAt,coverageThrough,complete,status,objectKey) VALUES('history','agency','kind-patches','traffic','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z',1,'ready','fixture');INSERT INTO current_snapshots(organizationId,clientId,sourceId,date,snapshotId) VALUES('agency','kind-patches','traffic','2026-10-10','history')");
 const insert=sqlite.prepare('INSERT INTO observations(snapshotId,date,rowKey,payload) VALUES(?,?,?,?)'),rows:Observation[]=[];
 for(let index=0;index<4101;index++){const row:Observation={date,dataset:'traffic',metric:'sessions',value:1,currency:null,definition:'captured',population:'human',dimensions:{page:'/a',utm_campaign:`campaign-${index}`},sourceId,retrievedAt:'2026-10-11T00:00:00Z',coverageThrough:'2026-10-11T00:00:00Z',quality:'complete',start:`${date}T00:00:00Z`,end:`${date}T01:00:00Z`};insert.run(snapshotId,date,String(index).padStart(6,'0'),JSON.stringify(row));rows.push(row);}
 return {sqlite,store,reads,state,rows};
}
it.each(['manifest','projection-chunks','legacy-page'])('stops bounded Store trend warming when its %s read consumes the remaining budget',async phase=>{
 const {sqlite,store,reads,state,rows}=database();try{
  if(phase==='projection-chunks')expect(await writeSnapshotDayProjection(store.db,scope.organizationId,scope.clientId,{snapshotId,sourceId,date},observationCodec.encode(rows))).toBe(true);
  reads.length=0;
  const started=Date.parse('2026-10-14T12:00:00Z'),deadline=started+1000;let clock=started,expired=false;vi.spyOn(Date,'now').mockImplementation(()=>clock);
  state.afterRead=sql=>{if(!expired&&(phase==='manifest'?sql.includes('JOIN snapshot_day_projection_entries'):phase==='projection-chunks'?sql.includes('FROM snapshot_day_projection_chunks'):sql.startsWith('WITH page AS MATERIALIZED'))){expired=true;clock=deadline;}};
  await expect(store.observations(scope.organizationId,scope.clientId,filters,false,{deadline},selection)).rejects.toThrow('Observation cache warm budget elapsed');
  expect(expired).toBe(true);expect(reads.filter(sql=>sql.startsWith('WITH page AS MATERIALIZED'))).toHaveLength(phase==='legacy-page'?1:0);expect(sqlite.prepare('SELECT COUNT(*) n FROM observation_cache_entries').get()?.n).toBe(0);
  if(phase==='projection-chunks'){expect(reads.filter(sql=>sql.includes('FROM snapshot_day_projection_chunks')).length).toBeLessThanOrEqual(4);expect(sqlite.prepare('SELECT status FROM snapshot_day_projection_entries').get()?.status).toBe('ready');}
  expect(sqlite.prepare('SELECT COUNT(*) n FROM observations').get()?.n).toBe(4101);expect(sqlite.prepare("SELECT status FROM snapshots WHERE id='history'").get()?.status).toBe('ready');
 }finally{sqlite.close();}
});
it('stops an expired trend-cache hit without a canonical fallback or republishing its ready generation',async()=>{
 const {sqlite,store,reads,state}=database();try{
  const pointers=[{snapshotId,sourceId,date}];expect((await readTrendObservations(store,pointers,['traffic'],filters,scope))[0].value).toBe(4101);const manifest=sqlite.prepare('SELECT generation,status,createdAt FROM observation_cache_entries').get();reads.length=0;
  const started=Date.parse('2026-10-14T12:00:00Z'),deadline=started+1000;let clock=started;vi.spyOn(Date,'now').mockImplementation(()=>clock);state.afterRead=sql=>{if(sql.includes('FROM observation_cache_chunks'))clock=deadline;};
  await expect(readTrendObservations(store,pointers,['traffic'],filters,scope,undefined,deadline)).rejects.toThrow('Observation cache warm budget elapsed');expect(reads.some(sql=>sql.startsWith('WITH page AS MATERIALIZED')||sql.includes('JOIN snapshot_day_projection_entries'))).toBe(false);expect(sqlite.prepare('SELECT generation,status,createdAt FROM observation_cache_entries').get()).toEqual(manifest);
 }finally{sqlite.close();}
});
it('rejects an already expired direct trend deadline before any cache or source read',async()=>{
 const {sqlite,store,reads}=database();try{
  const deadline=Date.parse('2026-10-14T12:00:00Z');vi.spyOn(Date,'now').mockReturnValue(deadline);
  await expect(readTrendObservations(store,[{snapshotId,sourceId,date}],['traffic'],filters,scope,undefined,deadline)).rejects.toThrow('Observation cache warm budget elapsed');expect(reads).toEqual([]);
 }finally{sqlite.close();}
});
