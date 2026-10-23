import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Store} from '../../lib/server/store';
const state=vi.hoisted(()=>({secret:vi.fn(),createClient:vi.fn(),sync:vi.fn(),globalStore:vi.fn(),stores:[] as Store[]}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:state.secret}));
vi.mock('../../lib/server/access',()=>({getStore:state.globalStore}));
vi.mock('@libsql/client',()=>({createClient:state.createClient}));
vi.mock('../../lib/jobs/ga4-sync',()=>({createAutobrushGa4Sync:(deps:{store:()=>Store})=>async()=>{
 const store=deps.store();state.stores.push(store,deps.store());await store.first('SELECT 1');return state.sync();
}}));
import {GET} from '../../app/api/cron/autobrush-ga4/route';
const request=(authorized=true)=>new Request('https://app.example/api/cron/autobrush-ga4',{headers:authorized?{authorization:`Bearer ${'a'.repeat(32)}`}:{}});
beforeEach(()=>{
 vi.clearAllMocks();state.stores.length=0;
 state.secret.mockImplementation((key:string)=>({CRON_SECRET:'a'.repeat(32),TURSO_DATABASE_URL:'https://database.invalid',TURSO_AUTH_TOKEN:'private-test-token'}[key]??null));
 state.createClient.mockImplementation(()=>({execute:vi.fn().mockResolvedValue({columns:['value'],rows:[[1]],rowsAffected:0}),close:vi.fn()}));
 state.globalStore.mockReturnValue({first:vi.fn().mockResolvedValue({value:1})});
 state.sync.mockResolvedValue({completed:['2026-10-16'],failed:[],remainingDays:29});
 vi.spyOn(console,'error').mockImplementation(()=>{});
});
afterEach(()=>vi.restoreAllMocks());
it('gives every authenticated invocation its own database client and closes each after success',async()=>{
 for(let n=0;n<2;n++)expect((await GET(request())).status).toBe(200);
 expect(state.createClient).toHaveBeenCalledTimes(2);expect(state.globalStore).not.toHaveBeenCalled();
 expect(state.stores[0]).toBe(state.stores[1]);expect(state.stores[2]).toBe(state.stores[3]);expect(state.stores[0]).not.toBe(state.stores[2]);
 for(const result of state.createClient.mock.results){expect(result.value.execute).toHaveBeenCalledWith({sql:'SELECT 1',args:[]});expect(result.value.close).toHaveBeenCalledTimes(1);}
 expect(state.createClient).toHaveBeenCalledWith({url:'https://database.invalid',authToken:'private-test-token',fetch:expect.any(Function)});
});
it('closes the invocation client when the job fails and keeps its failure sanitized',async()=>{
 state.sync.mockRejectedValue(new Error('private-test-token'));
 const response=await GET(request());expect(response.status).toBe(500);expect(await response.text()).not.toContain('private-test-token');
 expect(state.createClient).toHaveBeenCalledTimes(1);expect(state.createClient.mock.results[0].value.close).toHaveBeenCalledTimes(1);
});
it('authenticates before creating a database client or running the job',async()=>{
 expect((await GET(request(false))).status).toBe(401);expect(state.createClient).not.toHaveBeenCalled();expect(state.sync).not.toHaveBeenCalled();expect(state.globalStore).not.toHaveBeenCalled();
});
