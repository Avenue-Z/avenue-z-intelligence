import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import {it,expect} from 'vitest';
import { Store } from '../../lib/server/store';
import {buildAlertQueue} from '../../lib/analytics/alerts';
import {queryClient} from '../../lib/analytics/query';
import {workspaceReviewIndex} from '../../lib/reviews/index';
function database(){const sqlite=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')&&!f.startsWith('0008_')))sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const api={bind(...v:unknown[]){values=v;return api;},async all(){return {results:sqlite.prepare(sql).all(...values as any[])};},async first(){return sqlite.prepare(sql).get(...values as any[])??null;},async run(){const r=sqlite.prepare(sql).run(...values as any[]);return {meta:{changes:Number(r.changes)}};}};return api;};let queue=Promise.resolve();return {prepare,batch(stmts:any[]){const work=queue.then(async()=>{sqlite.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}});queue=work.catch(()=>{}) as Promise<void>;return work;}} as any;}
it('persists shared notes and rejects stale versions',async()=>{const store=new Store(database());await store.saveNote('a','client','hello','u',0);expect((await store.note('a','client')).body).toBe('hello');await expect(store.saveNote('a','client','lost','v',0)).rejects.toThrow('Changed');});
it('does not create two tasks when teammates track the same generated signal',async()=>{const s=new Store(database()),input={title:'Budget review',detail:'Review spend',severity:'act',status:'open',owner:'',evidence:['signal:efficiency:a:period']};await s.saveFinding('org','a',input,'u',0);await expect(s.saveFinding('org','a',input,'v',0)).rejects.toThrow('Changed');expect(await s.findings('org','a')).toHaveLength(1);await s.saveFinding('other','a',input,'v',0);expect(await s.findings('other','a')).toHaveLength(1);});
it('keeps one snapshot per content key and isolates clients',async()=>{const store=new Store(database());const batch={clientId:'a',timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:null,rows:[{date:'2026-10-07',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{},dataset:'overview'}]};await store.persistBatch('org','src',batch as any,'same','now');await store.persistBatch('org','src',batch as any,'same','now');expect((await store.observations('org','a')).length).toBe(1);expect(await store.observations('org','b')).toEqual([]);});
it('reads large snapshot sets in bounded pages without mixing a newer pointer during the read',async()=>{
 const db=database(),s=new Store(db),base={clientId:'a',timezone:'UTC',currency:'USD',channels:[],dimensions:['page'],grain:'daily',complete:true,coverageThrough:null,rows:Array.from({length:2101},(_,i)=>({date:'2026-10-07',metric:'sessions',value:1,definition:'human',population:'human',currency:null,dimensions:{page:`/p-${i}`},dataset:'funnels'}))} as any;
 await s.persistBatch('o','source',base,'first','2026-10-08T00:00:00Z');const original=db.prepare;let changed=false;
 db.prepare=(sql:string)=>{const statement=original(sql);if(!sql.startsWith('SELECT o.payload'))return statement;const bind=statement.bind.bind(statement);statement.bind=(...args:unknown[])=>{const bound=bind(...args),all=bound.all.bind(bound);bound.all=async()=>{if(!sql.includes('LIMIT'))throw Error('Unbounded source response');const result=await all();if(!changed){changed=true;await s.persistBatch('o','source',{...base,rows:base.rows.map((r:any)=>({...r,value:2}))},'next','2026-10-08T01:00:00Z');}return result;};return bound;};return statement;};
 const rows=await s.observations('o','a');expect(rows).toHaveLength(2101);expect(rows.reduce((n,r)=>n+(r.value??0),0)).toBe(2101);
});
it('keeps evidence order stable when parallel snapshot reads finish in a different order',async()=>{
 const db=database(),s=new Store(db),batch={clientId:'a',complete:true,coverageThrough:null,rows:[{date:'2026-10-07',dataset:'overview',metric:'revenue',value:1,definition:'web',currency:'USD',dimensions:{}}]} as any;
 await s.persistBatch('o','alpha',batch,'one','2026-10-08T00:00:00Z');await s.persistBatch('o','beta',batch,'two','2026-10-08T00:00:00Z');const prepare=db.prepare;let reverse=false;
 db.prepare=(sql:string)=>{const p=prepare(sql);if(!sql.startsWith('SELECT o.payload'))return p;const bind=p.bind.bind(p);p.bind=(...args:any[])=>{const bound=bind(...args),all=bound.all.bind(bound);bound.all=async()=>{if(String(args[0]).includes(reverse?'alpha':'beta'))await new Promise(resolve=>setTimeout(resolve,8));return all();};return bound;};return p;};
 const first=await s.observations('o','a');reverse=true;expect(await s.observations('o','a')).toEqual(first);
});
it('retains immutable review revisions and deduplicates reruns',async()=>{const store=new Store(database());await store.saveReview('o','a','2026-10-07','first',{revenue:10},'2026-10-08T00:00:00Z');await store.saveReview('o','a','2026-10-07','first',{revenue:10},'2026-10-08T00:00:00Z');await store.saveReview('o','a','2026-10-07','corrected',{revenue:12},'2026-10-08T01:00:00Z');const r=await store.reviews('o','a');expect(r).toHaveLength(2);expect(r.filter(x=>x.current)).toHaveLength(1);expect(r.find(x=>x.revision===1)?.payload.revenue).toBe(10);});
it('adds dated daily rechecks without overwriting a teammate’s owner, status or original evidence',async()=>{
 const s=new Store(database()),id=await s.saveFinding('o','a',{title:'Watch landing page',detail:'Original review evidence',status:'investigating',owner:'Sarah',severity:'investigate',evidence:['original']},'u',0);
 await s.saveReview('o','a','2026-10-12','check',{type:'ai',actions:[{existingFindingId:id,detail:'Conversion recovered today',nextStep:'Confirm the clean comparison tomorrow',severity:'watch',sourceIds:['selection:a']}]},'2026-10-12T13:00:00Z');
 const f=(await s.findings('o','a'))[0];expect(f).toMatchObject({detail:'Original review evidence',owner:'Sarah',status:'investigating',version:1,latestCheck:{storeDate:'2026-10-12',detail:'Conversion recovered today'}});expect((await s.findings('other','a'))).toEqual([]);
});
it('claims a job once and recovers an expired lease',async()=>{const store=new Store(database());await store.enqueue('o','a','src','bucket','2026-10-08T00:00:00Z');const a=await store.claim('2026-10-08T00:01:00Z','o');expect(a).not.toBeNull();expect(await store.claim('2026-10-08T00:01:30Z','o')).toBeNull();expect(await store.claim('2026-10-08T00:10:00Z','o')).not.toBeNull();});
it('prioritizes current refreshes over history and retains the lease for a large capture',async()=>{
 const s=new Store(database());await s.enqueue('o','a','src','hourly-history:2026-10-07','2026-10-08T00:00:00Z');await s.enqueue('o','a','src','current','2026-10-08T00:01:00Z');
 const job=await s.claim('2026-10-08T00:02:00Z','o',['a'],900000);expect(job.id).toBe('o:src:current');expect(job.leaseUntil).toBe('2026-10-08T00:17:00.000Z');
 const historic=await s.claim('2026-10-08T00:08:00Z','o',['a'],900000);expect(historic.id).toContain('hourly-history');expect(await s.claim('2026-10-08T00:09:00Z','o',['a'],900000)).toBeNull();
});
it('does not claim another organization’s jobs',async()=>{const store=new Store(database());await store.enqueue('outside','a','src','bucket','2026-10-08T00:00:00Z');expect(await store.claim('2026-10-08T00:01:00Z','inside')).toBeNull();});
it('keeps historical jobs pending when the independent current-feed runner claims work',async()=>{const store=new Store(database());await store.enqueue('o','a','src','hourly-history:2026-10-07','2026-10-08T00:00:00Z');expect(await store.claim('2026-10-08T00:01:00Z','o',['a'],900000,true)).toBeNull();expect((await store.jobs('o'))[0].status).toBe('pending');});
it('does not claim another permitted organization’s unassigned client',async()=>{const store=new Store(database());await store.enqueue('o','beam','src','bucket','2026-10-08T00:00:00Z');expect(await store.claim('2026-10-08T00:01:00Z','o',['kind'])).toBeNull();});
it('concurrent replay leaves the current review pointer intact',async()=>{const store=new Store(database());await Promise.all([store.saveReview('o','a','2026-10-07','same',{revenue:10},'now'),store.saveReview('o','a','2026-10-07','same',{revenue:10},'now')]);expect((await store.reviews('o','a')).filter(r=>r.current)).toHaveLength(1);});
it('retries transient jobs with backoff and then stops',async()=>{const store=new Store(database());await store.enqueue('o','a','src','bucket','2026-10-08T00:00:00Z');const j=await store.claim('2026-10-08T00:01:00Z','o');await store.retry(j.id,1,'429','2026-10-08T00:01:00Z');expect(await store.claim('2026-10-08T00:02:00Z','o')).toBeNull();expect(await store.claim('2026-10-08T00:03:01Z','o')).not.toBeNull();await store.retry(j.id,3,'429','2026-10-08T00:04:00Z');expect(await store.claim('2026-10-09T00:00:00Z','o')).toBeNull();});
it('publishes content reversions without letting an earlier replay overwrite them',async()=>{const s=new Store(database());const batch={clientId:'a',timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:null,rows:[{date:'2026-10-07',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{},dataset:'overview'}]} as any;await s.persistBatch('o','src',batch,'a','2026-10-08T00:00:00Z');await s.persistBatch('o','src',{...batch,rows:[{...batch.rows[0],value:50}]},'b','2026-10-08T01:00:00Z');await s.persistBatch('o','src',batch,'a','2026-10-08T02:00:00Z');expect((await s.observations('o','a'))[0].value).toBe(42);await s.persistBatch('o','src',{...batch,rows:[{...batch.rows[0],value:50}]},'b','2026-10-08T01:00:00Z');expect((await s.observations('o','a'))[0].value).toBe(42);});
it('preserves batch incompleteness despite a complete row claim',async()=>{const s=new Store(database());await s.persistBatch('o','src',{clientId:'a',complete:false,coverageThrough:null,rows:[{date:'2026-10-07',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{},dataset:'overview',quality:'complete'}]} as any,'a','2026-10-08T00:00:00Z');expect((await s.observations('o','a'))[0].quality).toBe('partial');});
it('republishes later review content reversions as revisions',async()=>{const s=new Store(database());await s.saveReview('o','a','2026-10-07','a',{revenue:10},'2026-10-08T00:00:00Z');await s.saveReview('o','a','2026-10-07','b',{revenue:20},'2026-10-08T01:00:00Z');await s.saveReview('o','a','2026-10-07','a',{revenue:10},'2026-10-08T02:00:00Z');const reviews=await s.reviews('o','a');expect(reviews).toHaveLength(3);expect(reviews.find(r=>r.current)?.payload.revenue).toBe(10);});
it('reads the exact review index without transferring report bodies or changing JSON value types',async()=>{
 const s=new Store(database()),payload={type:'ai',title:'Today',headlines:['Revenue improved'],summary:{verdict:'Hold'},actions:[{detail:'Review spend'}],presentationCorrection:false,sourceUrl:null,sections:[{body:'x'.repeat(100000)}],evidence:{private:'source facts'},unknown:'omit'};
 await s.saveReview('o','a','2026-10-07','first',payload,'2026-10-08T00:00:00Z');
 await s.saveReview('o','a','2026-10-07','second',{...payload,title:'Corrected'},'2026-10-08T01:00:00Z');
 await s.saveReview('other','a','2026-10-07','hidden',{title:'Other organization'},'2026-10-08T00:00:00Z');
 const full=await s.reviews('o','a'),index=await s.reviews('o','a',true);
 expect(index).toEqual(full.map(workspaceReviewIndex));expect(index).toHaveLength(2);
 expect(index[0].payload.presentationCorrection).toBe(false);expect(index[0].payload).toHaveProperty('sourceUrl',null);
 expect(index[0].payload).not.toHaveProperty('model');expect(index[0].payload).not.toHaveProperty('sections');expect(index[0].payload).not.toHaveProperty('unknown');
 expect(JSON.stringify(index).length).toBeLessThan(2000);expect(full[0].payload.sections).toEqual(payload.sections);
});

it('tracks a qualified conversion once and keeps it resolved after closing',async()=>{
 const s=new Store(database()),f={from:'2026-10-07',to:'2026-10-07',mode:'closed',compare:'previous',view:'overview',market:'',stream:'',source:'',device:'',page:''} as const;
 const client={id:'a',name:'A',timezone:'UTC',currency:'USD',config:{spendChannels:[],incidents:[],benchmarkMarket:'US',minSessions:100,minOpportunity:5,maxActions:6}} as any;
 const rows=['2026-10-06','2026-10-07'].flatMap(date=>['sessions','converting_sessions'].map(metric=>({date,metric,value:metric==='sessions'?1000:date.endsWith('07')?10:30,dataset:'funnels',definition:'human',population:'human',currency:null,dimensions:{page:'/lp'},sourceId:'s',quality:'complete',coverageThrough:'2026-10-08T00:00:00Z'}))) as any;
 const analytics=queryClient(client,rows,[],f),signal=buildAlertQueue([{...analytics,findings:[]} as any],f)[0];
 const input={title:signal.title,detail:signal.detail,severity:signal.severity,status:'open',owner:'Media',evidence:signal.evidence};
 await s.saveFinding('o','a',input,'u',0);
 let findings=await s.findings('o','a');
 expect(buildAlertQueue([{...analytics,findings} as any],f)).toHaveLength(1);
 expect(buildAlertQueue([{...analytics,findings} as any],f)[0].finding?.id).toBe(findings[0].id);
 await s.saveFinding('o','a',{...findings[0],status:'closed'},'u',findings[0].version);
 findings=await s.findings('o','a');
 expect(buildAlertQueue([{...analytics,findings} as any],f)).toEqual([]);
 await expect(s.saveFinding('o','a',input,'v',0)).rejects.toThrow('Changed');
 expect(await s.findings('o','a')).toHaveLength(1);
});

it('clears a corrected empty source day without deleting another day',async()=>{const s=new Store(database()),r={metric:'revenue',value:42,definition:'web',population:'web',currency:'USD',dimensions:{},dataset:'overview'};const batch={clientId:'a',timezone:'UTC',currency:'USD',channels:[],dimensions:[],grain:'daily',complete:true,coverageThrough:null,rows:[{...r,date:'2026-10-06'},{...r,date:'2026-10-07'}]} as any;await s.persistBatch('o','src',batch,'original','2026-10-08T00:00:00Z');await s.persistBatch('o','src',{...batch,rows:[]},'empty','2026-10-08T01:00:00Z',{from:'2026-10-07',to:'2026-10-07'});expect((await s.observations('o','a')).map(r=>r.date)).toEqual(['2026-10-06']);});
it('atomically links a scheduled report and rejects a stale job lease',async()=>{
 const s=new Store(database());await s.run("INSERT INTO scheduled_reviews(id,organizationId,clientId,storeDate,mode,status,dueAt,leaseToken) VALUES('job','o','a','2026-10-11','closed','running','now','token')");
 const job={id:'job',leaseToken:'token'};
 const id=await s.saveReview('o','a','2026-10-11','report',{type:'ai',scheduleJobId:'job'},'2026-10-12T13:00:00Z',job);
 expect(await s.first('SELECT * FROM scheduled_reviews')).toMatchObject({status:'complete',reviewId:id,leaseToken:null});
 await expect(s.saveReview('o','a','2026-10-11','stale',{type:'ai'},'2026-10-12T14:00:00Z',job)).rejects.toThrow('lease');
 expect(await s.reviews('o','a')).toHaveLength(1);
});
