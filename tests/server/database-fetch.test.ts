import {afterEach,expect,it,vi} from 'vitest';
import {createClient} from '@libsql/client';
import {createDatabaseFetch} from '../../lib/server/database-fetch';

afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('bypasses framework caching while preserving the database request and its private headers/body',async()=>{
 const request=new Request('https://database.invalid/v2/pipeline',{method:'POST',headers:{authorization:'test-only', 'content-type':'application/json'},body:'{"requests":[]}'});
 const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
 const response=await createDatabaseFetch(transport)(request,{cache:'force-cache'});expect(await response.text()).toBe('{}');
 const [input,init]=transport.mock.calls[0];expect(input).toBe(request);expect(init?.cache).toBe('no-store');expect(init?.signal).toBeInstanceOf(AbortSignal);
 const forwarded=new Request(input,init);expect(forwarded.method).toBe('POST');expect(forwarded.headers.get('authorization')).toBe('test-only');expect(await forwarded.text()).toBe('{"requests":[]}');
});
it('aborts a stalled database RPC instead of permanently occupying a pooled SDK request',async()=>{
 const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
 const transport=vi.fn<typeof fetch>().mockImplementation((_input,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true})));
 await expect(createDatabaseFetch(transport,20)('https://database.invalid/v2/pipeline')).rejects.toMatchObject({name:'TimeoutError'});
 expect(log).toHaveBeenCalledWith('Database request failed',expect.objectContaining({operation:'database-rpc',kind:'TimeoutError'}));
 expect(JSON.stringify(log.mock.calls)).not.toContain('database.invalid');
});
it('releases the awaiting RPC when the transport ignores its abort signal',async()=>{
 vi.useFakeTimers();vi.spyOn(console,'warn').mockImplementation(()=>{});
 let finish!:(response:Response)=>void,signal:AbortSignal|undefined,failure:unknown;
 const transport=vi.fn<typeof fetch>().mockImplementation((_input,init)=>{signal=init?.signal??undefined;return new Promise(resolve=>{finish=resolve;});});
 const pending=createDatabaseFetch(transport,20)('https://database.invalid/v2/pipeline').catch(error=>{failure=error;});
 await vi.advanceTimersByTimeAsync(21);
 expect(failure).toMatchObject({name:'TimeoutError'});expect(signal?.aborted).toBe(true);
 finish(new Response('{}'));await pending;
});
it('bounds a stalled response body even when its stream ignores cancellation',async()=>{
 vi.useFakeTimers();vi.spyOn(console,'warn').mockImplementation(()=>{});
 const body=new ReadableStream<Uint8Array>({pull:()=>new Promise(()=>{})}),transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
 const response=await createDatabaseFetch(transport,20)('https://database.invalid/v2/pipeline');let failure:unknown;
 const pending=response.text().catch(error=>{failure=error;});
 await vi.advanceTimersByTimeAsync(21);
 expect(failure).toMatchObject({name:'TimeoutError'});
 await pending;
});
it('releases the real SDK slot after a stalled body so the next SQL read can finish',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const result={cols:[{name:'value',decltype:'INTEGER'}],rows:[[{type:'integer',value:'7'}]],affected_row_count:0,last_insert_rowid:null};
 const transport=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({pull:()=>new Promise(()=>{})}))).mockResolvedValueOnce(Response.json({baton:null,base_url:null,results:[{type:'ok',response:{type:'execute',result}},{type:'ok',response:{type:'close'}}]}));
 const client=createClient({url:'https://database.invalid',concurrency:1,fetch:createDatabaseFetch(transport,20)});
 try{await expect(client.execute('SELECT 1')).rejects.toThrow();const recovered=await client.execute('SELECT 7 AS value');expect(recovered.rows[0].value).toBe(7);expect(transport).toHaveBeenCalledTimes(2);}finally{client.close();}
});
it('retains cancellation from both the original request and the caller signal',async()=>{
 for(const which of ['request','init'] as const){
  const requestController=new AbortController(),initController=new AbortController();
  const request=new Request('https://database.invalid/v2/pipeline',{signal:requestController.signal});
  const transport=vi.fn<typeof fetch>().mockImplementation((_input,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true})));
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  const work=createDatabaseFetch(transport)(request,{signal:initController.signal});
  (which==='request'?requestController:initController).abort();await expect(work).rejects.toMatchObject({name:'AbortError'});
 }
});
it('does not expose server URLs, SQL or credentials in transport failure logs',async()=>{
 const log=vi.spyOn(console,'warn').mockImplementation(()=>{}),failure=Object.assign(new Error('https://private.invalid SQL secret-value'),{code:'FAILED_RPC'});
 const transport=vi.fn<typeof fetch>().mockRejectedValue(failure);await expect(createDatabaseFetch(transport)('https://private.invalid')).rejects.toBe(failure);
 expect(log).toHaveBeenCalledWith('Database request failed',expect.objectContaining({kind:'Error',code:'FAILED_RPC'}));
 const output=JSON.stringify(log.mock.calls);for(const privateValue of ['private.invalid','SQL','secret-value'])expect(output).not.toContain(privateValue);
});
