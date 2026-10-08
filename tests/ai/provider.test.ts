import {it,expect,vi} from 'vitest';
import {askOpenAI} from '../../lib/ai/provider';
it('sends bounded server-side responses with storage disabled',async()=>{
 const fetcher=vi.fn(async(_url:any,_init:any)=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"answer":"Evidence answer","sourceIds":[],"followUps":[],"caveats":[]}'}]}]}));
 const result=await askOpenAI('test-key','gpt-5.4-mini','context',[], 'Question?',fetcher as any);
 expect(result.answer).toBe('Evidence answer');const b=JSON.parse(fetcher.mock.calls[0][1]!.body);expect(b.store).toBe(false);expect(b.max_output_tokens).toBe(3500);expect(b.text.format.type).toBe('json_schema');
});
it('redacts provider error bodies',async()=>{await expect(askOpenAI('private','model','ctx',[],'?',async()=>new Response('private',{status:401}))).rejects.toThrow('authentication');});
