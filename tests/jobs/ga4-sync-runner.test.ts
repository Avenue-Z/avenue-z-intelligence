import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Store} from '../../lib/server/store';
import {createBeamGa4Sync} from '../../lib/jobs/ga4-sync';
import {saveProviderCredential,readProviderCredential} from '../../lib/server/provider-credentials';
import {loadGa4Reports,saveGa4DayReports} from '../../lib/server/ga4-report-cache';
import type {Ga4Report,Ga4ReportRequest} from '../../lib/sources/ga4-data';
import initialClients from '../../data/initial-clients.json';
const at=Date.parse('2026-10-16T17:50:00Z'),key='test-GA4-vault-secret-at-least-thirty-two-characters';
const config={clientId:'beam-test.apps.googleusercontent.com',clientSecret:'test-client-secret',propertyId:'292550743'};
let db:DatabaseSync,store:Store;
const identity={organizationId:'avenue-z',clientId:'beam',provider:'ga4'};
const grant={appClientId:config.clientId,propertyId:config.propertyId,accessToken:'private-access',refreshToken:'private-refresh',expiresAt:at-1000,scopes:['https://www.googleapis.com/auth/analytics.readonly'],tokenType:'Bearer',authorizedAt:new Date(at-3600000).toISOString()};
function report(q:Ga4ReportRequest):Ga4Report{
 const dimensions:Record<string,string>={dateHour:q.from.replaceAll('-','')+'09',landingPage:'/pages/dream',countryId:'US',deviceCategory:'mobile',sessionSource:'facebook',sessionMedium:'paid_social',sessionCampaignName:'Dream'};
 return {rows:[{dimensions:Object.fromEntries(q.dimensions.map(name=>[name,dimensions[name]])),metrics:{sessions:10,engagedSessions:6,ecommercePurchases:2,purchaseRevenue:50}}],rowCount:1,dimensionHeaders:q.dimensions.map(name=>({name})),metricHeaders:q.metrics.map(name=>({name,type:name==='purchaseRevenue'?'TYPE_CURRENCY':'TYPE_INTEGER'})),metadata:{timeZone:'America/New_York',currencyCode:'USD'}};
}
const runReport=vi.fn(async(_token:string,_propertyId:string,q:Ga4ReportRequest)=>report(q));
const refresh=vi.fn(async()=>({...grant,accessToken:'renewed-access',tokenType:'Bearer' as const,expiresAt:at+3600000}));
function runner(changes:Record<string,string>={}){
 const secrets:Record<string,string>={APP_ORGANIZATION_ID:'avenue-z',AUTH_SECRET:key,SOURCE_BEAM_GA4:JSON.stringify(config),...changes};
 return createBeamGa4Sync({store:()=>store,secret:(name:string)=>secrets[name]??null,runReport,refresh,now:()=>new Date(Date.now())});
}
beforeEach(async()=>{
 vi.useFakeTimers();vi.setSystemTime(at);runReport.mockClear();refresh.mockClear();db=new DatabaseSync(':memory:');
 for(const file of readdirSync('drizzle').filter(name=>name.endsWith('.sql')).sort())db.exec(readFileSync(`drizzle/${file}`,'utf8'));
 const prepare=(sql:string)=>{let values:unknown[]=[];const statement={bind(...v:unknown[]){values=v;return statement;},async all(){return {results:db.prepare(sql).all(...values as string[])};},async first(){return db.prepare(sql).get(...values as string[])??null;},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values as string[]).changes)}};}};return statement;};
 store=new Store({prepare,batch:async(statements:{run:()=>Promise<unknown>}[])=>Promise.all(statements.map(statement=>statement.run()))});
 await store.run("INSERT INTO organizations VALUES('avenue-z','Avenue Z',1)");const client=initialClients.find(c=>c.id==='beam')!;
 await store.run('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)',client.id,'avenue-z',client.name,client.slug,client.timezone,client.currency,client.color,JSON.stringify(client.config),1);
 await saveProviderCredential(store,identity,grant,key);
});
afterEach(()=>{db.close();vi.useRealTimers();vi.restoreAllMocks();});
it('skips a missing source without provider requests',async()=>{
 expect(await runner({SOURCE_BEAM_GA4:''})()).toMatchObject({skipped:'not-configured',failed:[]});expect(runReport).not.toHaveBeenCalled();
});
it('refreshes an expired offline grant and publishes complete daily report sets from an application job',async()=>{
 const result=await runner()();expect(result.failed).toEqual([]);expect(result.completed[0]).toBe('2026-10-16');expect(refresh).toHaveBeenCalledOnce();
 const saved=await loadGa4Reports(store,'avenue-z',config.propertyId,'2026-10-16','2026-10-16');expect(saved.map(row=>row.kind).sort()).toEqual(['detail','hourly','total']);expect(new Set(saved.map(row=>row.capturedAt)).size).toBe(1);
 expect(saved.find(row=>row.kind==='detail')!.report.rows[0].dimensions.landingPage).toBe('/pages/dream');
 expect(await readProviderCredential(store,identity,key)).toMatchObject({accessToken:'renewed-access'});
 expect(JSON.stringify(await store.all('SELECT * FROM ga4_report_cache'))).not.toContain('private-access');expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('retains the last good report set when a provider fails and releases the lease for the next tick',async()=>{
 runReport.mockRejectedValueOnce(Error('private-access invalid provider payload'));const result=await runner()();expect(result.failed).toHaveLength(1);expect(JSON.stringify(result)).not.toContain('private-access');
 expect(await loadGa4Reports(store,'avenue-z',config.propertyId,'2026-10-16','2026-10-16')).toEqual([]);expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('reuses captured reports within an hour after the thirty-day history is complete',async()=>{
 const q={from:'2026-10-16',to:'2026-10-16',dimensions:[],metrics:['sessions','engagedSessions','ecommercePurchases','purchaseRevenue']};
 for(let offset=0;offset<30;offset++){
  const date=new Date(Date.UTC(2026,9,16-offset)).toISOString().slice(0,10);
  await saveGa4DayReports(store,'avenue-z',config.propertyId,(['total','hourly','detail'] as const).map(kind=>({storeDate:date,kind,capturedAt:new Date(at-300000).toISOString(),report:report({...q,from:date,to:date,dimensions:kind==='total'?[]:['dateHour']})})));
 }
 expect((await runner()()).completed).toEqual([]);expect(runReport).not.toHaveBeenCalled();vi.setSystemTime(at+3600000);
 expect((await runner()()).completed).toContain('2026-10-16');expect(runReport).toHaveBeenCalled();
});
it('does not overlap another application-owned GA4 sync',async()=>{
 await store.run('INSERT INTO runner_leases VALUES(?,?,?)','avenue-z:beam:ga4-sync','other-runner',new Date(at+60000).toISOString());
 expect(await runner()()).toMatchObject({skipped:'already-running',failed:[]});expect(runReport).not.toHaveBeenCalled();
});
it('does not replace a captured day when the detail query fails after totals succeed',async()=>{
 const date='2026-10-16',q={from:date,to:date,dimensions:[],metrics:['sessions','engagedSessions','ecommercePurchases','purchaseRevenue']};
 await saveGa4DayReports(store,'avenue-z',config.propertyId,(['total','hourly','detail'] as const).map(kind=>({storeDate:date,kind,capturedAt:'2026-10-16T16:05:00Z',report:report(q)})));
 runReport.mockImplementationOnce(async(_token,_property,q)=>report(q)).mockImplementationOnce(async(_token,_property,q)=>report(q)).mockRejectedValueOnce(Error('GA4 report returned HTTP 429'));
 const result=await runner()();expect(result.failed).toEqual([{date,error:'GA4 reporting returned HTTP 429'}]);
 const saved=await loadGa4Reports(store,'avenue-z',config.propertyId,date,date);expect(saved).toHaveLength(3);expect(saved.every(item=>item.capturedAt==='2026-10-16T16:05:00Z')).toBe(true);
});
it('waits for a missing offline grant without a browser session or provider calls',async()=>{
 await store.run('DELETE FROM provider_credentials WHERE organizationId=? AND clientId=? AND provider=?','avenue-z','beam','ga4');
 expect(await runner()()).toMatchObject({skipped:'awaiting-authorization',failed:[]});expect(runReport).not.toHaveBeenCalled();expect(await store.all('SELECT * FROM runner_leases')).toEqual([]);
});
it('counts slow setup against the original lease instead of starting a fresh capture budget',async()=>{
 const original=store.first.bind(store);vi.spyOn(store,'first').mockImplementation(async(sql,...args)=>{const result=await original(sql,...args);if(sql.includes('FROM provider_credentials'))vi.setSystemTime(at+100000);return result;});
 const result=await runner()();expect(result.completed).toEqual([]);expect(result.remainingDays).toBe(30);expect(runReport).not.toHaveBeenCalled();
});
it('fences publication if another runner takes ownership after the ownership read',async()=>{
 const original=store.run.bind(store);let replaced=false;
 vi.spyOn(store,'run').mockImplementation(async(sql,...args)=>{if(sql.startsWith('INSERT INTO ga4_report_cache')&&!replaced){replaced=true;await original('UPDATE runner_leases SET token=? WHERE id=?','replacement','avenue-z:beam:ga4-sync');}return original(sql,...args);});
 const result=await runner()();expect(result.completed).toEqual([]);expect(result.failed).toHaveLength(1);expect(await store.all('SELECT * FROM ga4_report_cache')).toEqual([]);
 expect(await store.first('SELECT token FROM runner_leases WHERE id=?','avenue-z:beam:ga4-sync')).toMatchObject({token:'replacement'});
});
it('rejects another property or reporting identity before collecting any data',async()=>{
 await expect(runner({SOURCE_BEAM_GA4:JSON.stringify({...config,propertyId:'123'})})()).rejects.toThrow();expect(runReport).not.toHaveBeenCalled();
 await store.run("UPDATE clients SET timezone='UTC' WHERE id='beam'");await expect(runner()()).rejects.toThrow();expect(runReport).not.toHaveBeenCalled();
});
