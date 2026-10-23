import {afterEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({error:null as Error|null}));
vi.mock('../../lib/server/company-workspace-bridge',()=>({publicCompanyAIErrors:['Hourly AI request limit reached. Please try again later.'],companyWorkspaceAccess:async()=>({scope:{organizationId:'o',role:'admin',actorId:'a',permittedClientIds:['kind-patches']},params:new URLSearchParams({clientId:'kind-patches',payload:JSON.stringify({clientId:'kind-patches',question:'Current revenue',filters:{}})})})}));
vi.mock('../../lib/ai/server',()=>({parseAIRequest:()=>({clientId:'kind-patches',filters:{}}),answerAI:async()=>{if(state.error)throw state.error;return {id:'answer'};}}));
vi.mock('../../lib/ai/platform-chat',()=>({answerPlatformAI:async()=>{if(state.error)throw state.error;return {id:'answer'};}}));
import {POST} from '../../app/api/internal/chat/route';
afterEach(()=>{state.error=null;vi.restoreAllMocks();});
it.each([
 ['This evidence scope cannot fit the fast chat preview. Choose one client or a narrower reporting scope.','AI_CHAT_PREVIEW_TOO_LARGE'],
 ['OpenAI is temporarily unavailable (400). Please retry.','OPENAI_HTTP_400'],
 ['AI returned an unsupported citation; please retry','AI_UNSUPPORTED_CITATION']
])('logs a fixed safe classification for %s',async(message,code)=>{
 state.error=new Error(message);const logged=vi.spyOn(console,'error').mockImplementation(()=>{}),response=await POST(new Request('https://app.example/api/internal/chat',{method:'POST'}));
 expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'Company AI request unavailable'});expect(logged).toHaveBeenCalledWith('Company AI chat failed',{kind:'Error',code});
});
it('never records provider bodies, request questions, credentials or raw exception messages',async()=>{
 state.error=new Error('private-key and raw SQL/provider body');const logged=vi.spyOn(console,'error').mockImplementation(()=>{});await POST(new Request('https://app.example/api/internal/chat',{method:'POST'}));
 expect(logged).toHaveBeenCalledWith('Company AI chat failed',{kind:'Error',code:'AI_CHAT_FAILED'});expect(JSON.stringify(logged.mock.calls)).not.toContain('private-key');expect(JSON.stringify(logged.mock.calls)).not.toContain('Current revenue');
});
