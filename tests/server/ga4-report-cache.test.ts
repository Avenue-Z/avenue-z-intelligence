import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {afterEach,expect,it,vi} from 'vitest';
import {saveGa4Report,saveGa4DayReports,loadGa4Reports,ga4CachedDays,pruneGa4Reports,type Ga4CachedReport,type Ga4ReportKind} from '../../lib/server/ga4-report-cache';
import type {Store} from '../../lib/server/store';
import type {Ga4Report} from '../../lib/sources/ga4-data';

const propertyId='292550743',org='organization-a',capturedAt='2026-10-16T14:00:00.000Z',storeDate='2026-10-15';
const databases:DatabaseSync[]=[];
function report():Ga4Report{return {rows:[{dimensions:{date:'20261015'},metrics:{sessions:12,purchaseRevenue:45.25}}],rowCount:1,dimensionHeaders:[{name:'date'}],metricHeaders:[{name:'sessions',type:'TYPE_INTEGER'},{name:'purchaseRevenue',type:'TYPE_CURRENCY'}],metadata:{timeZone:'America/New_York',currencyCode:'USD',subjectToThresholding:false,samplingMetadatas:[{samplesReadCount:'100',samplingSpaceSize:'1000'}]}};}
function item(kind:Ga4ReportKind='total'):Ga4CachedReport{return {storeDate,kind,capturedAt,report:report()};}
function fixture(migration=false){
 const db=new DatabaseSync(':memory:');databases.push(db);
 db.exec(migration?readFileSync('drizzle/0011_ga4_report_cache.sql','utf8'):'CREATE TABLE ga4_report_cache (organizationId TEXT NOT NULL,clientId TEXT NOT NULL,propertyId TEXT NOT NULL,storeDate TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,capturedAt TEXT NOT NULL,PRIMARY KEY(organizationId,clientId,propertyId,storeDate,kind))');
 db.exec('CREATE TABLE runner_leases (id TEXT PRIMARY KEY,token TEXT NOT NULL,leaseUntil TEXT NOT NULL)');
 const statements:string[]=[];const store:Pick<Store,'all'|'run'>={async all<T>(sql:string,...values:unknown[]):Promise<T[]>{statements.push(sql);return db.prepare(sql).all(...values as string[]) as T[];},async run(sql,...values){statements.push(sql);return {meta:{changes:Number(db.prepare(sql).run(...values as string[]).changes)}};}};
 const insert=(organizationId=org,clientId='beam',property=propertyId,date=storeDate,kind='total',payload=gzipSync(JSON.stringify(report())).toString('base64'))=>db.prepare('INSERT INTO ga4_report_cache VALUES(?,?,?,?,?,?,?)').run(organizationId,clientId,property,date,kind,payload,capturedAt);
 return {db,store,insert,statements};
}
afterEach(()=>{for(const db of databases)db.close();databases.length=0;vi.restoreAllMocks();});

it('round trips the complete raw report through compressed persisted base64',async()=>{
 const {db,store}=fixture(),input=item();input.report.metadata.dataTruncationReasons=[{reason:'provider evidence'}];
 await saveGa4Report(store,org,propertyId,input);const persisted=db.prepare('SELECT * FROM ga4_report_cache').get()!;
 expect(persisted.organizationId).toBe(org);expect(persisted.clientId).toBe('beam');expect(persisted.propertyId).toBe(propertyId);expect(persisted.payload).not.toContain('America/New_York');
 expect(JSON.parse(gunzipSync(Buffer.from(persisted.payload as string,'base64')).toString('utf8'))).toEqual(input.report);
 expect(await loadGa4Reports(store,org,propertyId,storeDate,storeDate)).toEqual([input]);
});

it('upserts only the same organization, client, property, date and report kind',async()=>{
 const {db,store}=fixture();await saveGa4Report(store,org,propertyId,item());await saveGa4Report(store,org,propertyId,item('hourly'));await saveGa4Report(store,'other-org',propertyId,item());
 const replacement=item();replacement.report.rows[0].metrics.sessions=99;await saveGa4Report(store,org,propertyId,replacement);
 expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:3});expect((await loadGa4Reports(store,org,propertyId,storeDate,storeDate)).map(value=>[value.kind,value.report.rows[0].metrics.sessions])).toEqual([['hourly',12],['total',99]]);
});

it('isolates direct SQL rows belonging to other organizations, clients, properties or dates',async()=>{
 const {store,insert}=fixture();insert();insert('other-org');insert(org,'other-client');insert(org,'beam','other-property');insert(org,'beam',propertyId,'2026-10-14');
 expect(await loadGa4Reports(store,org,propertyId,storeDate,storeDate)).toEqual([item()]);expect(await loadGa4Reports(store,'missing-org',propertyId,storeDate,storeDate)).toEqual([]);
});

it('returns only recorded days in date and kind order without synthesizing missing days',async()=>{
 const {store}=fixture();await saveGa4Report(store,org,propertyId,item());await saveGa4Report(store,org,propertyId,{...item('detail'),storeDate:'2026-10-13'});await saveGa4Report(store,org,propertyId,item('detail'));
 expect((await loadGa4Reports(store,org,propertyId,'2026-10-13',storeDate)).map(value=>[value.storeDate,value.kind])).toEqual([['2026-10-13','detail'],['2026-10-15','detail'],['2026-10-15','total']]);
});

it('reads day metadata without selecting or decompressing payloads',async()=>{
 const {db,store,statements}=fixture();await saveGa4Report(store,org,propertyId,item());db.prepare("UPDATE ga4_report_cache SET payload='corrupt'").run();statements.length=0;
 expect(await ga4CachedDays(store,org,propertyId,storeDate,storeDate)).toEqual([{storeDate,kind:'total',capturedAt}]);expect(statements).toHaveLength(1);expect(statements[0].split(/FROM/i)[0]).not.toMatch(/payload|\*/i);
});

it('filters kinds in SQL so an unrequested malformed detail report is never loaded',async()=>{
 const {store,insert}=fixture();insert();insert(org,'beam',propertyId,storeDate,'hourly');insert(org,'beam',propertyId,storeDate,'detail','bad');
 expect((await loadGa4Reports(store,org,propertyId,storeDate,storeDate,{kinds:['total','hourly']})).map(value=>value.kind)).toEqual(['hourly','total']);
 await expect(loadGa4Reports(store,org,propertyId,storeDate,storeDate)).rejects.toThrow();
});

it('publishes exactly three coherent day reports with one SQL statement',async()=>{
 const {store,statements}=fixture();const reports=[item('total'),item('hourly'),item('detail')];await saveGa4DayReports(store,org,propertyId,reports);
 expect(statements).toHaveLength(1);expect(await loadGa4Reports(store,org,propertyId,storeDate,storeDate)).toEqual([reports[2],reports[1],reports[0]]);
});

it('rolls back the entire day if a later kind cannot replace its previous capture',async()=>{
 const {db,store}=fixture();const reports=[item('total'),item('hourly'),item('detail')];await saveGa4DayReports(store,org,propertyId,reports);
 db.exec("CREATE TRIGGER fail_detail BEFORE UPDATE ON ga4_report_cache WHEN NEW.kind='detail' BEGIN SELECT RAISE(ABORT,'private provider token'); END");
 const failure=await saveGa4DayReports(store,org,propertyId,reports.map(value=>({...value,capturedAt:'2026-10-16T15:00:00.000Z'}))).then(()=>null,error=>error);
 expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private provider token');expect((await ga4CachedDays(store,org,propertyId,storeDate,storeDate)).map(value=>value.capturedAt)).toEqual([capturedAt,capturedAt,capturedAt]);
});

it('fences every day report against a replaced lease owner and lets only the current token publish',async()=>{
 const {db,store,statements}=fixture(),id=`${org}:beam:ga4-sync`,reports=[item('total'),item('hourly'),item('detail')];
 await saveGa4DayReports(store,org,propertyId,reports);
 db.prepare('INSERT INTO runner_leases VALUES(?,?,?)').run(id,'new-owner','2026-10-16T16:00:00Z');
 const replacement=reports.map(value=>({...value,capturedAt:'2026-10-16T15:00:00.000Z'}));statements.length=0;
 await expect(saveGa4DayReports(store,org,propertyId,replacement,{lease:{id,token:'old-owner'}})).rejects.toThrow('GA4 report cache day could not be saved');
 expect(statements).toHaveLength(1);expect((await ga4CachedDays(store,org,propertyId,storeDate,storeDate)).map(value=>value.capturedAt)).toEqual([capturedAt,capturedAt,capturedAt]);
 await saveGa4DayReports(store,org,propertyId,replacement,{lease:{id,token:'new-owner'}});
 expect((await ga4CachedDays(store,org,propertyId,storeDate,storeDate)).map(value=>value.capturedAt)).toEqual(Array(3).fill('2026-10-16T15:00:00.000Z'));
});

it('rejects a fenced publication when its lease is absent without inserting any reports',async()=>{
 const {db,store}=fixture();await expect(saveGa4DayReports(store,org,propertyId,[item(),item('hourly'),item('detail')],{lease:{id:`${org}:beam:ga4-sync`,token:'missing-owner'}})).rejects.toThrow();
 expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:0});
});

it.each([{id:'other-tenant:beam:ga4-sync',token:'owner'},{id:`${org}:beam:ga4-sync`,token:''},{id:`${org}:beam:ga4-sync`,token:'bad\ntoken'}])('rejects invalid lease guard case %# before a database write',async lease=>{
 const run=vi.fn();await expect(saveGa4DayReports({run},org,propertyId,[item(),item('hourly'),item('detail')],{lease})).rejects.toThrow();expect(run).not.toHaveBeenCalled();
});

it.each([
 [item('total'),item('hourly')],
 [item('total'),item('hourly'),item('hourly')],
 [item('total'),item('hourly'),{...item('detail'),storeDate:'2026-10-14'}],
 [item('total'),item('hourly'),{...item('detail'),capturedAt:'2026-10-16T15:00:00.000Z'}],
].map(reports=>({reports})))('rejects incoherent atomic day publication case %# before a write',async({reports})=>{
 const {db,store}=fixture();await expect(saveGa4DayReports(store,org,propertyId,reports as Ga4CachedReport[])).rejects.toThrow();expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:0});
});

it('prunes only older rows in the exact tenant and Beam property scope',async()=>{
 const {store,insert,db}=fixture();insert();insert(org,'beam',propertyId,'2026-10-14');insert('other-org','beam',propertyId,'2026-10-14');insert(org,'other-client',propertyId,'2026-10-14');insert(org,'beam','other-property','2026-10-14');
 await pruneGa4Reports(store,org,propertyId,storeDate);expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:4});expect(await loadGa4Reports(store,org,propertyId,'2026-10-14',storeDate)).toEqual([item()]);
});

it('accepts a 32-day inclusive range and rejects a 33-day range before reading',async()=>{
 const {store}=fixture();expect(await loadGa4Reports(store,org,propertyId,'2026-09-15','2026-10-16')).toEqual([]);expect(await ga4CachedDays(store,org,propertyId,'2026-09-15','2026-10-16')).toEqual([]);
 const all=vi.fn();await expect(loadGa4Reports({all},org,propertyId,'2026-09-14','2026-10-16')).rejects.toThrow();await expect(ga4CachedDays({all},org,propertyId,'2026-09-14','2026-10-16')).rejects.toThrow();expect(all).not.toHaveBeenCalled();
});

it.each(['2026-02-30','today','2026-10-16\n','2026-13-01'])('rejects invalid date %j for writes, reads, metadata or pruning',async date=>{
 const all=vi.fn(),run=vi.fn();await expect(saveGa4Report({run},org,propertyId,{...item(),storeDate:date})).rejects.toThrow();await expect(loadGa4Reports({all},org,propertyId,date,storeDate)).rejects.toThrow();await expect(ga4CachedDays({all},org,propertyId,storeDate,date)).rejects.toThrow();await expect(pruneGa4Reports({run},org,propertyId,date)).rejects.toThrow();expect(all).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});

it.each(['other-property','properties/292550743','292550743\n'])('rejects property outside Beam boundary %j without database access',async property=>{
 const all=vi.fn(),run=vi.fn();await expect(saveGa4Report({run},org,property,item())).rejects.toThrow();await expect(saveGa4DayReports({run},org,property,[item(),item('hourly'),item('detail')])).rejects.toThrow();await expect(loadGa4Reports({all},org,property,storeDate,storeDate)).rejects.toThrow();await expect(ga4CachedDays({all},org,property,storeDate,storeDate)).rejects.toThrow();await expect(pruneGa4Reports({run},org,property,storeDate)).rejects.toThrow();expect(all).not.toHaveBeenCalled();expect(run).not.toHaveBeenCalled();
});

it.each([[],['total','total'],['unknown'],['total','detail','hourly','total'],null])('rejects malformed kind selection case %# before a query',async kinds=>{
 const all=vi.fn();await expect(loadGa4Reports({all},org,propertyId,storeDate,storeDate,{kinds:kinds as Ga4ReportKind[]})).rejects.toThrow();expect(all).not.toHaveBeenCalled();
});

it.each([
 (value:Ga4CachedReport)=>{value.kind='unknown' as Ga4ReportKind;},
 (value:Ga4CachedReport)=>{value.capturedAt='not-an-ISO-time';},
 (value:Ga4CachedReport)=>{value.report.metadata.timeZone='UTC';},
 (value:Ga4CachedReport)=>{value.report.metadata.currencyCode='EUR';},
 (value:Ga4CachedReport)=>{delete value.report.metadata.currencyCode;},
 (value:Ga4CachedReport)=>{value.report.rowCount=2;},
 (value:Ga4CachedReport)=>{value.report.rows[0].metrics.sessions=NaN;},
 (value:Ga4CachedReport)=>{value.report.rows[0].dimensions.date=1 as unknown as string;},
 (value:Ga4CachedReport)=>{delete value.report.rows[0].metrics.purchaseRevenue;},
 (value:Ga4CachedReport)=>{value.report.metricHeaders.push({...value.report.metricHeaders[0]});},
 (value:Ga4CachedReport)=>{value.report.metadata.accessToken='private-test-access-token';},
])('rejects malformed or credential-bearing cache input case %# without persisting it',async mutate=>{
 const {store,db}=fixture(),value=item();mutate(value);const failure=await saveGa4Report(store,org,propertyId,value).then(()=>null,error=>error);expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private-test-access-token');expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:0});
});

it.each(['not-base64','e30=','H4sIAAAAAAAA==',''])('rejects malformed compressed payload %j',async payload=>{
 const {store,insert}=fixture();insert(org,'beam',propertyId,storeDate,'total',payload);await expect(loadGa4Reports(store,org,propertyId,storeDate,storeDate)).rejects.toThrow();
});

it('rejects CRC tampering, noncanonical base64, and structurally invalid decompressed reports',async()=>{
 for(const transform of [(value:Buffer)=>{value[value.length-1]^=1;return value.toString('base64');},(value:Buffer)=>value.toString('base64')+'\n',()=>gzipSync(JSON.stringify({...report(),rows:[{dimensions:{date:'20261015'},metrics:{sessions:'bad',purchaseRevenue:1}}]})).toString('base64')]){
  const {store,insert}=fixture();insert(org,'beam',propertyId,storeDate,'total',transform(gzipSync(JSON.stringify(report()))));await expect(loadGa4Reports(store,org,propertyId,storeDate,storeDate)).rejects.toThrow();
 }
});

it('bounds decompression expansion to 16 MiB for an otherwise valid report',async()=>{
 const {store,insert}=fixture(),value=report();value.metadata.padding='a'.repeat(16*1024*1024);insert(org,'beam',propertyId,storeDate,'total',gzipSync(JSON.stringify(value)).toString('base64'));await expect(loadGa4Reports(store,org,propertyId,storeDate,storeDate)).rejects.toThrow();
});

it('rejects over-16-MiB JSON before persisting a report',async()=>{
 const {store,db}=fixture(),value=item();value.report.metadata.padding='a'.repeat(16*1024*1024);await expect(saveGa4Report(store,org,propertyId,value)).rejects.toThrow();expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:0});
});

it('bounds compressed bytes to 4 MiB on writes and reads',async()=>{
 const {store,db,insert}=fixture(),value=item();value.report.metadata.padding=randomBytes(6*1024*1024).toString('base64');const payload=gzipSync(JSON.stringify(value.report)).toString('base64');
 await expect(saveGa4Report(store,org,propertyId,value)).rejects.toThrow();expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:0});insert(org,'beam',propertyId,storeDate,'total',payload);await expect(loadGa4Reports(store,org,propertyId,storeDate,storeDate)).rejects.toThrow();
});

it('sanitizes database failures and never logs reports or credentials',async()=>{
 const log=vi.spyOn(console,'log').mockImplementation(()=>{}),warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{}),fail=()=>{throw Error('private-test-access-token');};
 for(const call of [()=>saveGa4Report({run:fail},org,propertyId,item()),()=>saveGa4DayReports({run:fail},org,propertyId,[item(),item('hourly'),item('detail')]),()=>loadGa4Reports({all:fail},org,propertyId,storeDate,storeDate),()=>ga4CachedDays({all:fail},org,propertyId,storeDate,storeDate),()=>pruneGa4Reports({run:fail},org,propertyId,storeDate)]){
  const failure=await call().then(()=>null,error=>error);expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain('private-test-access-token');expect(failure.cause).toBeUndefined();
 }
 expect(log).not.toHaveBeenCalled();expect(warn).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();
});

it('creates the production migration table for atomic day upserts and scoped retention',async()=>{
 const {store,db}=fixture(true);await saveGa4DayReports(store,org,propertyId,[item(),item('hourly'),item('detail')]);await saveGa4Report(store,org,propertyId,item());expect(db.prepare('SELECT count(*) AS count FROM ga4_report_cache').get()).toEqual({count:3});await pruneGa4Reports(store,org,propertyId,'2026-10-16');expect(await ga4CachedDays(store,org,propertyId,storeDate,storeDate)).toEqual([]);
});
