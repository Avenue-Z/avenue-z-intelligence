import {it,expect,vi,beforeEach} from 'vitest';
const state=vi.hoisted(()=>({secret:vi.fn(),sync:vi.fn(),reviews:vi.fn()}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:state.secret}));
vi.mock('../../lib/jobs/runner',()=>({syncTick:state.sync,reviewTick:state.reviews}));
import {GET as sync} from '../../app/api/cron/sync/route';
import {GET as reviews} from '../../app/api/cron/reviews/route';
beforeEach(()=>{vi.clearAllMocks();state.secret.mockReturnValue('a'.repeat(32));state.sync.mockResolvedValue({completed:['job'],failed:[]});state.reviews.mockResolvedValue({completed:['report'],failed:[]});});
it('rejects missing secrets and user identity headers before accessing the job runner',async()=>{
 const request=new Request('https://app.example/api/cron/sync',{headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.com'}});
 expect((await sync(request)).status).toBe(401);expect(state.sync).not.toHaveBeenCalled();
 state.secret.mockReturnValue(null);expect((await reviews(new Request('https://app.example/api/cron/reviews',{headers:{authorization:'Bearer null'}}))).status).toBe(401);expect(state.reviews).not.toHaveBeenCalled();
});
it('runs with only the application service credential and no browser session',async()=>{
 const r=await sync(new Request('https://app.example/api/cron/sync',{headers:{authorization:`Bearer ${'a'.repeat(32)}`}}));
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({completed:['job']});
 const daily=await reviews(new Request('https://app.example/api/cron/reviews',{headers:{authorization:`Bearer ${'a'.repeat(32)}`}}));expect(daily.status).toBe(200);
});
it('signals operational failures and suppresses sensitive exception text',async()=>{
 state.sync.mockRejectedValue(new Error('provider credential SECRET_VALUE'));
 const r=await sync(new Request('https://app.example/api/cron/sync',{headers:{authorization:`Bearer ${'a'.repeat(32)}`}}));expect(r.status).toBe(500);expect(await r.text()).not.toContain('SECRET_VALUE');
});
it('logs only a safe SDK error code and kind without exposing exception or credential text',async()=>{
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});state.sync.mockRejectedValue(Object.assign(new Error('token SECRET_VALUE database [private]'),{name:'LibsqlError',code:'BLOCKED'}));
 try{const r=await sync(new Request('https://app.example/api/cron/sync',{headers:{authorization:`Bearer ${'a'.repeat(32)}`}}));expect(r.status).toBe(500);expect(log).toHaveBeenCalledWith('Scheduled job failed',{kind:'LibsqlError',code:'BLOCKED'});expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET_VALUE');expect(await r.text()).not.toContain('BLOCKED');}finally{log.mockRestore();}
});
