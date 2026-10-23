import {beforeEach,expect,it,vi} from 'vitest';
import type {Store} from '../../lib/server/store';
const state=vi.hoisted(()=>({pending:false,failPending:false,failWarm:false,failMaintenance:false}));
vi.mock('../../lib/jobs/sync',()=>({enqueueDue:vi.fn(async()=>{}),runSyncBatch:vi.fn(async()=>({completed:['beam-published'],failed:[]}))}));
vi.mock('../../lib/server/cache-warming',()=>({warmSuccessfulSourceJobs:vi.fn(async()=>{if(state.failWarm)throw Error('sensitive warm failure');return {attempted:2,completed:2};})}));
vi.mock('../../lib/jobs/archive-materialization-retention',()=>({pruneArchivedMaterializations:vi.fn(async()=>{if(state.failMaintenance)throw Error('sensitive maintenance failure');return {verifiedSnapshots:1,prunedSnapshots:1,rowsDeleted:3,charactersDeleted:20,projectionChunksDeleted:1,skipped:0};})}));
import {runBeamSync} from '../../lib/jobs/beam-sync';
import {enqueueDue,runSyncBatch} from '../../lib/jobs/sync';
import {warmSuccessfulSourceJobs} from '../../lib/server/cache-warming';
import {pruneArchivedMaterializations} from '../../lib/jobs/archive-materialization-retention';
const run=vi.fn(async(sql:string)=>({meta:{changes:sql?1:0}}));
const first=vi.fn(async(sql:string)=>{if(sql.includes('FROM organizations'))return {initialized:1};if(state.failPending)throw Error('sensitive guard failure');return state.pending?{id:'queued'}:null;});
const store={first,run} as unknown as Store;
beforeEach(()=>{state.pending=false;state.failPending=false;state.failWarm=false;state.failMaintenance=false;vi.clearAllMocks();});
it.each(['warm','maintenance','pending'])('retains confirmed source results and releases its lease when optional %s work fails',async(kind)=>{
 state.failWarm=kind==='warm';state.failMaintenance=kind==='maintenance';state.failPending=kind==='pending';
 const result=await runBeamSync(store,'o');expect(result.completed).toEqual(['beam-published']);expect(result.failed).toEqual([]);expect(JSON.stringify(result)).not.toContain('sensitive');expect(run.mock.calls.some(([sql])=>sql.startsWith('DELETE FROM runner_leases'))).toBe(true);
});
it('leaves queued current work ahead of warming and archive maintenance',async()=>{
 state.pending=true;const result=await runBeamSync(store,'o');expect(result.completed).toEqual(['beam-published']);expect(warmSuccessfulSourceJobs).not.toHaveBeenCalled();expect(pruneArchivedMaterializations).not.toHaveBeenCalled();
});
it('passes the owned Beam scope and Store to native source scheduling and execution',async()=>{
 await runBeamSync(store,'o');expect(enqueueDue).toHaveBeenCalledWith(expect.objectContaining({permittedClientIds:['beam'],role:'service'}),undefined,store);expect(runSyncBatch).toHaveBeenCalledWith(expect.objectContaining({permittedClientIds:['beam']}),expect.objectContaining({maxJobs:7,includeHistory:false}),store);
});
