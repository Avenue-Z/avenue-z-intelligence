import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({secret:vi.fn(),qualify:vi.fn()}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:state.secret}));
vi.mock('../../lib/server/autobrush-northbeam-qualification',()=>({qualifyAutobrushNorthbeam:state.qualify}));
import {POST} from '../../app/api/cron/autobrush-northbeam-qualify/route';
const url='https://app.example/api/cron/autobrush-northbeam-qualify';
beforeEach(()=>{vi.clearAllMocks();state.secret.mockReturnValue('a'.repeat(32));state.qualify.mockResolvedValue({status:'scope-verified',reportingScopeValidated:true,qualifiedForActivation:false,sourceActivationPerformed:false});});
function request(body:unknown,authenticated=true){return new Request(url,{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:`Bearer ${'a'.repeat(32)}`}:{})},body:JSON.stringify(body)});}
it('rejects browser identity without the application credential before qualification',async()=>{expect((await POST(request({date:'2026-10-21'},false))).status).toBe(401);expect(state.qualify).not.toHaveBeenCalled();});
it('calls only the fixed qualifier with date and server-side secret function',async()=>{const response=await POST(request({date:'2026-10-21'}));expect(response.status).toBe(200);expect(state.qualify).toHaveBeenCalledWith({date:'2026-10-21'},state.secret);expect(response.headers.get('cache-control')).toBe('no-store');});
it.each([{date:'2026-10-21',apiKey:'arbitrary'},{date:'2026-10-21',exportId:'arbitrary'},{date:'2026-10-21',account:'beam'},{date:'2026-10-21',request:{metrics:[]}}])('rejects arbitrary scope fields %j',async body=>{const response=await POST(request(body));expect(response.status).toBe(500);expect(await response.json()).toMatchObject({qualification:{status:'failed',reason:'invalid_request'}});expect(state.qualify).not.toHaveBeenCalled();});
it('returns a safe precise failure without claiming activation',async()=>{state.qualify.mockResolvedValue({status:'failed',reason:'attributed_revenue_metric_unavailable_or_ambiguous',qualifiedForActivation:false});const response=await POST(request({date:'2026-10-21'}));expect(response.status).toBe(500);expect(await response.json()).toMatchObject({qualification:{reason:'attributed_revenue_metric_unavailable_or_ambiguous',qualifiedForActivation:false}});});
it('cancels an oversized request stream before reading its remaining body',async()=>{
 let cancelled=false,finish=()=>{};
 const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(6001));finish=()=>controller.close();},cancel(){cancelled=true;}});
 const incoming=new Request(url,{method:'POST',headers:{authorization:`Bearer ${'a'.repeat(32)}`},body,duplex:'half'} as RequestInit);
 const pending=POST(incoming),timer=setTimeout(()=>{if(!cancelled)finish();},10);
 const response=await pending;clearTimeout(timer);expect(response.status).toBe(500);expect(cancelled).toBe(true);expect(state.qualify).not.toHaveBeenCalled();
});
