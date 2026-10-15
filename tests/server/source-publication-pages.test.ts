import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import type {SourceBatch} from '../../lib/analytics/contracts';
import {fingerprint} from '../../lib/reviews/build';
import {observationCodec} from '../../lib/server/observation-codec';

type Statement={sql:string;values:unknown[];bind:(...values:unknown[])=>Statement;all:()=>Promise<{results:unknown[]}>;first:()=>Promise<unknown>;run:()=>Promise<{meta:{changes:number}}>};
function database(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync('drizzle').filter(file=>file.endsWith('.sql')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string):Statement=>{const statement:Statement={sql,values:[],bind(...values){statement.values=values;return statement;},async all(){return {results:sqlite.prepare(sql).all(...statement.values as (string|number|null)[])};},async first(){return sqlite.prepare(sql).get(...statement.values as (string|number|null)[])??null;},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...statement.values as (string|number|null)[]).changes)}};}};return statement;};
 const db={prepare,async batch(statements:Statement[]){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
 return {sqlite,db,store:new Store(db)};
}
const batch=():SourceBatch=>({clientId:'kind-patches',timezone:'UTC',currency:'USD',channels:[],dimensions:['page'],grain:'daily',complete:true,coverageThrough:'2026-10-13T17:00:00Z',rows:Array.from({length:4001},(_,index)=>({date:'2026-10-13',dataset:'traffic',metric:'sessions',value:index+1,definition:'human',population:'human',currency:null,dimensions:{page:`/page-${String(index).padStart(4,'0')}`},sourceId:'',retrievedAt:'',coverageThrough:null,quality:'complete'}))});
const timeout=()=>new DOMException('Database request timed out','TimeoutError');
afterEach(()=>vi.restoreAllMocks());

it('writes dense pages in primary-key order while retaining exact facts and duplicate first-wins values',async()=>{
 const dense=database(),legacy=database(),input=batch(),first=input.rows[0];
 input.rows=[...input.rows].reverse();input.rows.splice(100,0,{...first,value:999});input.rows.push({...first,value:888});
 input.rows.push(...input.rows.slice(0,20).map(row=>({...row,date:'2026-10-12'})));
 const original=dense.db.batch,keys:string[]=[];
 dense.db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations'))for(const value of JSON.parse(String(statements[0].values[1])))keys.push(JSON.stringify([value.date,value.rowKey]));return original(statements);};
 const stamp='2026-10-13T17:05:00Z',id=await dense.store.persistBatch('o','source',input,'same',stamp,undefined,{factPageSize:500,publicationDeadline:Date.now()+120000});
 await legacy.store.persistBatch('o','source',input,'same',stamp);
 expect(keys).toEqual([...keys].sort());
 expect(dense.sqlite.prepare('SELECT * FROM observations ORDER BY snapshotId,date,rowKey').all()).toEqual(legacy.sqlite.prepare('SELECT * FROM observations ORDER BY snapshotId,date,rowKey').all());
 expect(dense.sqlite.prepare('SELECT * FROM current_snapshots ORDER BY date').all()).toEqual(legacy.sqlite.prepare('SELECT * FROM current_snapshots ORDER BY date').all());
 const rowKey=JSON.stringify([first.dataset,first.metric,first.start,first.end,Object.entries(first.dimensions).sort()]);
 expect(JSON.parse(String(dense.sqlite.prepare('SELECT payload FROM observations WHERE snapshotId=? AND date=? AND rowKey=?').get(id,first.date,rowKey)?.payload)).value).toBe(999);
 for(const date of ['2026-10-12','2026-10-13']){
  const payload=(db:DatabaseSync)=>db.prepare('SELECT payload FROM snapshot_day_projection_chunks WHERE snapshotId=? AND date=? ORDER BY chunkIndex').all(id,date).map(row=>row.payload).join('');
  expect(observationCodec.decode(payload(dense.sqlite))).toEqual(observationCodec.decode(payload(legacy.sqlite)));
 }
});

it('bounds explicitly dense fact transactions to 500 rows while publishing every fact before its pointer',async()=>{
 const {store,db,sqlite}=database(),original=db.batch,pages:number[]=[];
 db.batch=async statements=>{const facts=statements[0]?.sql.startsWith('INSERT INTO observations');if(facts){pages.push(statements.reduce((n,statement)=>n+JSON.parse(String(statement.values[1])).length,0));expect(statements).toHaveLength(1);const result=await original(statements);expect(sqlite.prepare('SELECT count(*) n FROM current_snapshots').get()?.n).toBe(0);expect(sqlite.prepare('SELECT status FROM snapshots').get()?.status).toBe('writing');return result;}return original(statements);};
 const id=await store.persistBatch('o','dense-source',batch(),'capture','2026-10-13T17:05:00Z',undefined,{factPageSize:500,publicationDeadline:Date.now()+120000});
 expect(pages).toEqual([500,500,500,500,500,500,500,500,1]);expect(sqlite.prepare('SELECT count(*) n FROM observations WHERE snapshotId=?').get(id)?.n).toBe(4001);expect(sqlite.prepare('SELECT snapshotId FROM current_snapshots').get()?.snapshotId).toBe(id);expect(sqlite.prepare('SELECT status FROM snapshots WHERE id=?').get(id)?.status).toBe('ready');
});
it('keeps the 2000-row transaction default for other publications',async()=>{
 const {store,db}=database(),original=db.batch,pages:number[]=[];
 db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations'))pages.push(statements.reduce((n,statement)=>n+JSON.parse(String(statement.values[1])).length,0));return original(statements);};
 await store.persistBatch('o','source',batch(),'capture','2026-10-13T17:05:00Z');expect(pages).toEqual([2000,2000,1]);
});
it('replays only a committed 500-row page after a lost acknowledgment without moving the prior pointer early',async()=>{
 const {store,db,sqlite}=database(),old={...batch(),rows:[batch().rows[0]]};await store.persistBatch('o','dense-source',old,'prior','2026-10-13T16:05:00Z');
 const original=db.batch,pages:number[]=[];let failed=false;
 db.batch=async statements=>{const facts=statements[0]?.sql.startsWith('INSERT INTO observations');if(facts)pages.push(JSON.parse(String(statements[0].values[1]))[0].payload?JSON.parse(JSON.parse(String(statements[0].values[1]))[0].payload).value:0);const result=await original(statements);if(facts){expect(sqlite.prepare('SELECT snapshotId FROM current_snapshots').get()?.snapshotId).toBe('o:kind-patches:dense-source:prior');expect(sqlite.prepare("SELECT status FROM snapshots WHERE id='o:kind-patches:dense-source:next'").get()?.status).toBe('writing');if(pages.at(-1)===1001&&!failed){failed=true;throw timeout();}}return result;};
 const id=await store.persistBatch('o','dense-source',batch(),'next','2026-10-13T17:05:00Z',undefined,{factPageSize:500,publicationDeadline:Date.now()+120000});
 expect(pages).toEqual([1,501,1001,1001,1501,2001,2501,3001,3501,4001]);expect(sqlite.prepare('SELECT count(*) n FROM observations WHERE snapshotId=?').get(id)?.n).toBe(4001);expect(sqlite.prepare("SELECT count(*) n FROM observations WHERE snapshotId=? AND json_extract(payload,'$.retrievedAt')<>?").get(id,'2026-10-13T17:05:00Z')?.n).toBe(0);expect(sqlite.prepare('SELECT snapshotId FROM current_snapshots').get()?.snapshotId).toBe(id);
});
it('leaves later failed dense pages writing with the prior pointer and confirmed earlier facts intact',async()=>{
 const {store,db,sqlite}=database(),old={...batch(),rows:[batch().rows[0]]};await store.persistBatch('o','dense-source',old,'prior','2026-10-13T16:05:00Z');
 const original=db.batch,pages:number[]=[];
 db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations')){const first=JSON.parse(JSON.parse(String(statements[0].values[1]))[0].payload).value;pages.push(first);if(first===1501)throw Error('Fact page rejected');}return original(statements);};
 await expect(store.persistBatch('o','dense-source',batch(),'next','2026-10-13T17:05:00Z',undefined,{factPageSize:500,publicationDeadline:Date.now()+120000})).rejects.toThrow('Fact page rejected');
 expect(pages).toEqual([1,501,1001,1501]);expect(sqlite.prepare('SELECT snapshotId FROM current_snapshots').get()?.snapshotId).toBe('o:kind-patches:dense-source:prior');expect(sqlite.prepare("SELECT status,retrievedAt FROM snapshots WHERE id='o:kind-patches:dense-source:next'").get()).toEqual({status:'writing',retrievedAt:'2026-10-13T17:05:00Z'});expect(sqlite.prepare("SELECT count(*) n FROM observations WHERE snapshotId='o:kind-patches:dense-source:next'").get()?.n).toBe(1500);
});

it('retries only the failed fact page after an ambiguous committed timeout and publishes all facts once',async()=>{
 const {store,db,sqlite}=database(),original=db.batch;let failed=false;const pages:number[]=[];
 db.batch=async statements=>{
  const facts=statements[0]?.sql.startsWith('INSERT INTO observations');
  if(facts){const values=JSON.parse(String(statements[0].values[1]));pages.push(values[0].payload?JSON.parse(values[0].payload).value:0);}
  const result=await original(statements);
  if(facts&&pages.at(-1)===2001&&!failed){failed=true;expect(sqlite.prepare('SELECT count(*) AS count FROM current_snapshots').get()?.count).toBe(0);throw timeout();}
  return result;
 };
 const id=await store.persistBatch('o','source',batch(),'capture','2026-10-13T17:05:00Z',undefined,{publicationDeadline:Date.now()+120000});
 expect(pages).toEqual([1,2001,2001,4001]);
 expect(sqlite.prepare('SELECT count(*) AS count FROM observations WHERE snapshotId=?').get(id)?.count).toBe(4001);
 expect(sqlite.prepare('SELECT snapshotId FROM current_snapshots').get()?.snapshotId).toBe(id);
 expect(sqlite.prepare('SELECT status,retrievedAt FROM snapshots WHERE id=?').get(id)).toEqual({status:'ready',retrievedAt:'2026-10-13T17:05:00Z'});
});

it('stops retrying a failed page when the original job has insufficient RPC budget and retains the prior ready pointer',async()=>{
 const {store,db,sqlite}=database(),old={...batch(),rows:[batch().rows[0]]};
 await store.persistBatch('o','source',old,'prior','2026-10-13T16:05:00Z');
 const started=Date.now();let clock=started,failedPages=0;vi.spyOn(Date,'now').mockImplementation(()=>clock);const original=db.batch;
 db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations')&&JSON.parse(String(statements[0].values[1]))[0].rowKey.includes('/page-2000')){failedPages++;clock=started+90000;throw timeout();}return original(statements);};
 await expect(store.persistBatch('o','source',batch(),'next','2026-10-13T17:05:00Z',undefined,{publicationDeadline:started+120000})).rejects.toThrow('Database request timed out');
 expect(failedPages).toBe(1);
 expect(sqlite.prepare('SELECT snapshotId FROM current_snapshots').get()?.snapshotId).toBe('o:kind-patches:source:prior');
 expect(sqlite.prepare("SELECT status FROM snapshots WHERE id='o:kind-patches:source:next'").get()?.status).toBe('writing');
 expect(sqlite.prepare("SELECT count(*) AS count FROM observations WHERE snapshotId='o:kind-patches:source:next'").get()?.count).toBe(2000);
});

it('retries an ambiguous pointer transaction without replaying completed fact pages',async()=>{
 const {store,db,sqlite}=database(),original=db.batch;let failed=false,factPages=0,pointerAttempts=0;
 db.batch=async statements=>{const facts=statements[0]?.sql.startsWith('INSERT INTO observations'),pointers=statements[0]?.sql.startsWith('INSERT INTO current_snapshots');if(facts)factPages++;if(pointers)pointerAttempts++;const result=await original(statements);if(pointers&&!failed){failed=true;throw timeout();}return result;};
 const id=await store.persistBatch('o','source',batch(),'capture','2026-10-13T17:05:00Z',undefined,{publicationDeadline:Date.now()+120000});
 expect(factPages).toBe(3);expect(pointerAttempts).toBe(2);
 expect(sqlite.prepare('SELECT count(*) AS count FROM observations').get()?.count).toBe(4001);
 expect(sqlite.prepare('SELECT snapshotId FROM current_snapshots').get()?.snapshotId).toBe(id);
});

it('does not retry permanent fact storage failures',async()=>{
 const {store,db,sqlite}=database();let attempts=0;const original=db.batch;
 db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations')){attempts++;throw Error('Storage capacity exceeded');}return original(statements);};
 await expect(store.persistBatch('o','source',batch(),'capture','2026-10-13T17:05:00Z',undefined,{publicationDeadline:Date.now()+120000})).rejects.toThrow('Storage capacity exceeded');
 expect(attempts).toBe(1);expect(sqlite.prepare('SELECT count(*) AS count FROM current_snapshots').get()?.count).toBe(0);
});

it('does not start another fact page when a completed page consumes the remaining native budget',async()=>{
 const {store,db,sqlite}=database(),started=Date.now(),original=db.batch;let clock=started,pages=0;vi.spyOn(Date,'now').mockImplementation(()=>clock);
 db.batch=async statements=>{const result=await original(statements);if(statements[0]?.sql.startsWith('INSERT INTO observations')){pages++;clock=started+120000;}return result;};
 await expect(store.persistBatch('o','source',batch(),'capture','2026-10-13T17:05:00Z',undefined,{publicationDeadline:started+120000})).rejects.toThrow('Source publication budget elapsed');
 expect(pages).toBe(1);expect(sqlite.prepare('SELECT count(*) AS count FROM observations').get()?.count).toBe(2000);expect(sqlite.prepare('SELECT count(*) AS count FROM current_snapshots').get()?.count).toBe(0);
});

it('leaves an authoritative publication ready without starting optional projections after its budget expires',async()=>{
 const {store,db,sqlite}=database(),started=Date.now(),original=db.batch;let clock=started;vi.spyOn(Date,'now').mockImplementation(()=>clock);
 db.batch=async statements=>{const result=await original(statements);if(statements[0]?.sql.startsWith('INSERT INTO current_snapshots'))clock=started+120000;return result;};
 const id=await store.persistBatch('o','source',batch(),'capture','2026-10-13T17:05:00Z',undefined,{publicationDeadline:started+120000});
 expect(sqlite.prepare('SELECT status FROM snapshots WHERE id=?').get(id)?.status).toBe('ready');
 expect(sqlite.prepare('SELECT count(*) AS count FROM snapshot_day_projection_entries').get()?.count).toBe(0);
});

it.each(['budget','lost-ack','before-pointer'])('resumes exact committed keys after %s exhaustion and builds projections with original provenance',async failure=>{
 const {store,db,sqlite}=database(),input=batch(),key=await fingerprint(input),original=db.batch,started=Date.parse('2026-10-13T17:05:00Z');let clock=started,pages=0;
 vi.spyOn(Date,'now').mockImplementation(()=>clock);db.batch=async statements=>{const result=await original(statements);if(statements[0]?.sql.startsWith('INSERT INTO observations')&&++pages===(failure==='before-pointer'?9:2)){clock=started+120000;if(failure==='lost-ack')throw timeout();}return result;};
 await expect(store.persistBatch('o','source',input,key,'2026-10-13T17:05:00Z',undefined,{factPageSize:500,publicationDeadline:started+120000})).rejects.toThrow(failure==='lost-ack'?'Database request timed out':'Source publication budget elapsed');
 const id=`o:kind-patches:source:${key}`;expect(sqlite.prepare('SELECT COUNT(*) n FROM observations WHERE snapshotId=?').get(id)?.n).toBe(failure==='before-pointer'?4001:1000);expect(sqlite.prepare('SELECT COUNT(*) n FROM current_snapshots').get()?.n).toBe(0);
 clock=started+180000;const sizes:number[]=[];let resumeReads=0;const all=store.all.bind(store);
 vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT date,rowKey FROM observations')){resumeReads++;expect(sql).toContain('LIMIT 2000');expect(sql).not.toContain('OFFSET');}return all(sql,...args);});
 db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations')){sizes.push(JSON.parse(String(statements[0].values[1])).length);expect(sqlite.prepare('SELECT status FROM snapshots WHERE id=?').get(id)?.status).toBe('writing');expect(sqlite.prepare('SELECT COUNT(*) n FROM current_snapshots').get()?.n).toBe(0);}if(statements[0]?.sql.startsWith('INSERT INTO current_snapshots'))expect(sqlite.prepare('SELECT COUNT(*) n FROM observations WHERE snapshotId=?').get(id)?.n).toBe(4001);return original(statements);};
 await store.persistBatch('o','source',input,key,'2026-10-13T17:08:00Z',undefined,{factPageSize:500,publicationDeadline:started+600000});
 expect(resumeReads).toBe(failure==='before-pointer'?3:1);expect(sizes).toEqual(failure==='before-pointer'?[]:[500,500,500,500,500,500,1]);expect(sqlite.prepare('SELECT COUNT(*) n FROM observations WHERE snapshotId=? AND json_extract(payload,\'$.retrievedAt\')<>?').get(id,'2026-10-13T17:05:00Z')?.n).toBe(0);expect(sqlite.prepare('SELECT status,retrievedAt FROM snapshots WHERE id=?').get(id)).toEqual({status:'ready',retrievedAt:'2026-10-13T17:05:00Z'});expect(sqlite.prepare('SELECT status FROM snapshot_day_projection_entries WHERE snapshotId=?').get(id)?.status).toBe('ready');
 const projection=observationCodec.decode(sqlite.prepare('SELECT payload FROM snapshot_day_projection_chunks WHERE snapshotId=? ORDER BY chunkIndex').all(id).map(row=>row.payload).join(''));expect(projection).toHaveLength(4001);expect(projection.every(row=>row.retrievedAt==='2026-10-13T17:05:00Z'&&row.coverageThrough===input.coverageThrough&&row.sourceId==='source')).toBe(true);
});
it('fills holes across multiple dates sharing row keys using bounded composite-key seeks',async()=>{
 const {store,db,sqlite}=database(),first=batch(),input={...first,rows:[...first.rows,...first.rows.map(row=>({...row,date:'2026-10-12'}))]},key=await fingerprint(input),id=`o:kind-patches:source:${key}`,capturedAt='2026-10-13T17:05:00Z',started=Date.parse(capturedAt);vi.spyOn(Date,'now').mockReturnValue(started);
 await store.run('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)',id,'o',input.clientId,'source',capturedAt,input.coverageThrough,1,'writing',`snapshots/${id}.json`);
 const committed=input.rows.filter((_,index)=>index%3===0);for(const row of committed)await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,row.date,JSON.stringify([row.dataset,row.metric,row.start,row.end,Object.entries(row.dimensions).sort()]),JSON.stringify({...row,channels:input.channels,sourceId:'source',retrievedAt:capturedAt,coverageThrough:input.coverageThrough}));
 const all=store.all.bind(store),write=db.batch;let reads=0,written=0;vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT date,rowKey FROM observations')){reads++;if(reads>1)expect(sql).toContain('(date,rowKey)>(?,?)');}return all(sql,...args);});db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations'))written+=JSON.parse(String(statements[0].values[1])).length;return write(statements);};
 await store.persistBatch('o','source',input,key,'2026-10-13T17:08:00Z',undefined,{factPageSize:500,publicationDeadline:started+600000});expect(reads).toBe(2);expect(written).toBe(input.rows.length-committed.length);expect(sqlite.prepare('SELECT COUNT(*) n FROM observations WHERE snapshotId=?').get(id)?.n).toBe(8002);expect(sqlite.prepare('SELECT COUNT(*) n FROM snapshot_day_projection_entries WHERE snapshotId=? AND status=\'ready\'').get(id)?.n).toBe(2);
});
it.each(['just-inside','equal-boundary','stale','invalid-time','unbounded','archive','restore','different-value','different-channels'])('uses exact keys only within proven writing eligibility: %s',async condition=>{
 const {store,db,sqlite}=database(),input=batch(),key=await fingerprint(input),started=Date.parse('2026-10-13T17:05:00Z'),deadline=started+600000,id=`o:kind-patches:source:${key}`,capturedAt=condition==='just-inside'?new Date(deadline-7200000+1).toISOString():condition==='equal-boundary'?new Date(deadline-7200000).toISOString():condition==='stale'?new Date(deadline-7200001).toISOString():condition==='invalid-time'?'invalid':'2026-10-13T17:05:00Z';vi.spyOn(Date,'now').mockReturnValue(started);
 await store.run('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)',id,'o',input.clientId,'source',capturedAt,input.coverageThrough,1,'writing',`snapshots/${id}.json`);const row=input.rows[0];await store.run('INSERT INTO observations VALUES(?,?,?,?)',id,row.date,JSON.stringify([row.dataset,row.metric,row.start,row.end,Object.entries(row.dimensions).sort()]),JSON.stringify({...row,channels:input.channels,sourceId:'source',retrievedAt:capturedAt,coverageThrough:input.coverageThrough}));
 if(condition==='archive')await store.run('INSERT INTO audit VALUES(?,?,?,?,?,?,?)',`archive-materialization:${id}`,'o',input.clientId,'actor','snapshot.materialization.archive_verified','{}','2026-10-13T17:05:00Z');
 const retry=condition==='different-value'?{...input,rows:input.rows.map(value=>({...value,value:99}))}:condition==='different-channels'?{...input,channels:['changed']}:input,all=store.all.bind(store),write=db.batch;let reads=0,written=0;vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT date,rowKey FROM observations'))reads++;return all(sql,...args);});db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations'))written+=JSON.parse(String(statements[0].values[1])).length;return write(statements);};
 await store.persistBatch('o','source',retry,key,'2026-10-13T17:08:00Z',undefined,{factPageSize:500,...condition==='unbounded'?{}:{publicationDeadline:deadline},...condition==='restore'?{restoreMaterialization:true}:{}});expect(reads).toBe(condition==='just-inside'?1:0);expect(written).toBe(condition==='just-inside'?4000:4001);
 if(condition==='different-value'||condition==='different-channels'){const saved=sqlite.prepare('SELECT payload FROM observations WHERE snapshotId=? AND date=? AND rowKey=?').get(id,row.date,JSON.stringify([row.dataset,row.metric,row.start,row.end,Object.entries(row.dimensions).sort()]));expect(JSON.parse(String(saved?.payload))).toMatchObject({value:1,channels:[]});expect(sqlite.prepare('SELECT COUNT(*) n FROM snapshot_day_projection_entries WHERE snapshotId=?').get(id)?.n).toBe(0);}
});
it('stops after a bounded resume read consumes its deadline without starting another read or any fact write',async()=>{
 const {store,db,sqlite}=database(),input=batch(),key=await fingerprint(input),id=`o:kind-patches:source:${key}`,started=Date.parse('2026-10-13T17:05:00Z'),original=db.batch;let clock=started;vi.spyOn(Date,'now').mockImplementation(()=>clock);
 db.batch=async statements=>{const result=await original(statements);if(statements[0]?.sql.startsWith('INSERT INTO observations'))clock=started+120000;return result;};await expect(store.persistBatch('o','source',input,key,'2026-10-13T17:05:00Z',undefined,{publicationDeadline:started+120000})).rejects.toThrow('budget elapsed');
 clock=started+180000;const deadline=started+600000,all=store.all.bind(store);let resumeReads=0,factWrites=0;vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{const result=await all(sql,...args);if(sql.startsWith('SELECT date,rowKey FROM observations')){resumeReads++;clock=deadline;}return result;});db.batch=async statements=>{if(statements[0]?.sql.startsWith('INSERT INTO observations'))factWrites++;return original(statements);};await expect(store.persistBatch('o','source',input,key,'2026-10-13T17:08:00Z',undefined,{publicationDeadline:deadline})).rejects.toThrow('budget elapsed');expect(resumeReads).toBe(1);expect(factWrites).toBe(0);expect(sqlite.prepare('SELECT COUNT(*) n FROM observations WHERE snapshotId=?').get(id)?.n).toBe(2000);expect(sqlite.prepare('SELECT status FROM snapshots WHERE id=?').get(id)?.status).toBe('writing');expect(sqlite.prepare('SELECT COUNT(*) n FROM current_snapshots').get()?.n).toBe(0);
});
it('does not read resume keys for a newly created capture',async()=>{
 const {store}=database(),all=store.all.bind(store),read=vi.spyOn(store,'all').mockImplementation(async(sql,...args)=>{if(sql.startsWith('SELECT date,rowKey FROM observations'))throw Error('Fresh capture must not resume');return all(sql,...args);});const input=batch();await store.persistBatch('o','source',input,await fingerprint(input),'2026-10-13T17:05:00Z',undefined,{publicationDeadline:Date.now()+120000,factPageSize:500});expect(read).toHaveBeenCalled();
});
