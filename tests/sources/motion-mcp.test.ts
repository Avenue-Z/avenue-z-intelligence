import {afterEach,expect,it,vi} from 'vitest';
import {motionMcpCall} from '../../lib/sources/motion-mcp';

const token='motion-private-test-access-token';
const initialized={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Motion',version:'1'}};
const rpc=(id:number,result:unknown)=>({jsonrpc:'2.0',id,result});
const json=(value:unknown,headers:HeadersInit={})=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json',...headers}});
function fixture(result:unknown={structuredContent:{organizations:[{id:'organization'}]}},options:{initialize?:Response;notification?:Response;tool?:Response}={}){
 const requests:{url:string;options:RequestInit;body:Record<string,unknown>}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  requests.push({url:String(url),options:init!,body:JSON.parse(String(init?.body))});
  return requests.length===1?options.initialize??json(rpc(1,initialized)):requests.length===2?options.notification??new Response(null,{status:202}):options.tool??json(rpc(2,result));
 };
 return {fetcher,requests};
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});

it('initializes before one allowlisted read tool call, carrying bearer auth only to the fixed endpoint',async()=>{
 const {fetcher,requests}=fixture();expect(await motionMcpCall(token,'get_auth_context',{},fetcher)).toEqual({organizations:[{id:'organization'}]});
 expect(requests.map(request=>request.body.method)).toEqual(['initialize','notifications/initialized','tools/call']);
 expect(requests[0].body).toEqual({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'beam-analytics',version:'1.0.0'}}});
 expect(requests[1].body).toEqual({jsonrpc:'2.0',method:'notifications/initialized'});
 expect(requests[2].body).toEqual({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_auth_context',arguments:{}}});
 for(const request of requests){
  expect(request.url).toBe('https://projects.motionapp.com/mcp');expect(request.options.method).toBe('POST');expect(request.options.redirect).toBe('error');expect(request.options.signal).toBeInstanceOf(AbortSignal);
  const headers=new Headers(request.options.headers);expect(headers.get('Authorization')).toBe(`Bearer ${token}`);expect(headers.get('Content-Type')).toBe('application/json');expect(headers.get('Accept')).toBe('application/json, text/event-stream');
  expect(JSON.stringify(request.body)).not.toContain(token);
 }
});

it.each(['get_auth_context','get_creative_insights','get_reports','get_demographic_breakdown'] as const)('allows only the read tool %s and preserves its arguments',async name=>{
 const {fetcher,requests}=fixture({content:[{type:'text',text:'{"count":3}'}]});expect(await motionMcpCall(token,name,{workspace_id:'workspace',limit:3},fetcher)).toEqual({count:3});
 expect(requests[2].body.params).toEqual({name,arguments:{workspace_id:'workspace',limit:3}});
});

it('carries the server session and negotiated protocol version on subsequent requests',async()=>{
 const {fetcher,requests}=fixture(undefined,{initialize:json(rpc(1,{...initialized,protocolVersion:'2025-06-18'}),{'Mcp-Session-Id':'session-123'})});
 await motionMcpCall(token,'get_auth_context',{},fetcher);expect(new Headers(requests[0].options.headers).has('Mcp-Session-Id')).toBe(false);
 for(const request of requests.slice(1)){const headers=new Headers(request.options.headers);expect(headers.get('Mcp-Session-Id')).toBe('session-123');expect(headers.get('MCP-Protocol-Version')).toBe('2025-06-18');}
});

it('starts a fresh independent initialization for each call when no server session is returned',async()=>{
 const first=fixture(),second=fixture();await motionMcpCall(token,'get_auth_context',{},first.fetcher);await motionMcpCall(token,'get_reports',{},second.fetcher);
 for(const request of [...first.requests,...second.requests])expect(new Headers(request.options.headers).has('Mcp-Session-Id')).toBe(false);
 expect(first.requests).toHaveLength(3);expect(second.requests).toHaveLength(3);
});

it('prefers structured content and preserves asynchronous waiting states without retrying',async()=>{
 const waiting={status:'waiting',report_id:'report-in-progress',retry_after:5};const {fetcher,requests}=fixture({structuredContent:waiting,content:[{type:'text',text:'not ready'}]});
 expect(await motionMcpCall(token,'get_creative_insights',{},fetcher)).toEqual(waiting);expect(requests).toHaveLength(3);
});

it.each([
 {content:[{type:'text',text:'Plain report description'}]},
 {content:[{type:'text',text:'[1,2]'}]},
 {content:[{type:'text',text:'{"first":1}'},{type:'text',text:'second'}]},
 {content:[]},
])('preserves unstructured content case %# without inventing analytics',async({content})=>{
 const {fetcher}=fixture({content});expect(await motionMcpCall(token,'get_reports',{},fetcher)).toEqual(content);
});

it('reads chunked SSE messages, ignores progress notifications and closes after the matching response',async()=>{
 const cancel=vi.fn();const text=': keepalive\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":\r\ndata: {"content":[{"type":"text","text":"{\\"name\\":\\"café\\"}"}]}}\r\n\r\n';
 const bytes=new TextEncoder().encode(text);
 const body=new ReadableStream<Uint8Array>({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));},cancel});
 const {fetcher}=fixture(undefined,{tool:new Response(body,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}})});
 expect(await motionMcpCall(token,'get_reports',{},fetcher)).toEqual({name:'café'});expect(cancel).toHaveBeenCalled();
});

it('supports SSE initialization and byte-sized LF-separated chunks',async()=>{
 const bytes=new TextEncoder().encode(`data: ${JSON.stringify(rpc(1,initialized))}\n\n`);
 const initBody=new ReadableStream<Uint8Array>({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}});
 const {fetcher}=fixture({structuredContent:{value:7}},{initialize:new Response(initBody,{headers:{'Content-Type':'text/event-stream'}})});
 expect(await motionMcpCall(token,'get_auth_context',{},fetcher)).toEqual({value:7});
});

it('ignores empty SSE priming events before the tool response',async()=>{
 const text=`id: event-1\ndata:\n\ndata: ${JSON.stringify(rpc(2,{structuredContent:{count:3}}))}\n\n`;
 const {fetcher}=fixture(undefined,{tool:new Response(text,{headers:{'Content-Type':'text/event-stream'}})});
 expect(await motionMcpCall(token,'get_reports',{},fetcher)).toEqual({count:3});
});

it.each(['','contains space','line\nbreak','é','x'.repeat(16385),null,42])('rejects invalid bearer token case %# before fetching',async invalid=>{
 const fetcher=vi.fn();await expect(motionMcpCall(invalid as string,'get_auth_context',{},fetcher)).rejects.toThrow('Invalid Motion MCP request');expect(fetcher).not.toHaveBeenCalled();
});

it.each(['delete_report','tools/list','get_creative_summary','submit_feedback',null])('rejects a tool outside the exact allowlist case %# before fetching',async name=>{
 const fetcher=vi.fn();await expect(motionMcpCall(token,name as Parameters<typeof motionMcpCall>[1],{},fetcher)).rejects.toThrow('Invalid Motion MCP request');expect(fetcher).not.toHaveBeenCalled();
});

it.each([null,[],42,{limit:BigInt(1)},{query:'x'.repeat(1024*1024)}])('rejects invalid or unbounded arguments case %# before fetching',async args=>{
 const fetcher=vi.fn();await expect(motionMcpCall(token,'get_reports',args as Record<string,unknown>,fetcher)).rejects.toThrow('Invalid Motion MCP request');expect(fetcher).not.toHaveBeenCalled();
});

it.each([
 {jsonrpc:'2.0',id:2,error:{code:-32603,message:token,data:{sensitive:token}}},
 rpc(2,{isError:true,content:[{type:'text',text:token}]}),
 rpc(999,{structuredContent:{count:3}}),
 {jsonrpc:'1.0',id:2,result:{content:[]}},
 rpc(2,null),
 rpc(2,{content:'bad'}),
 rpc(2,{structuredContent:'bad'}),
])('rejects failed or malformed JSON-RPC tool response case %# with sanitized errors',async response=>{
 const {fetcher}=fixture(undefined,{tool:json(response)});const failure=await motionMcpCall(token,'get_reports',{},fetcher).then(()=>null,error=>error);
 expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain(token);expect(failure.cause).toBeUndefined();
});

it.each([
 rpc(1,{...initialized,protocolVersion:'2099-01-01'}),
 rpc(1,{...initialized,protocolVersion:'invalid\r\nheader'}),
 rpc(1,{protocolVersion:'2025-03-26',capabilities:{}}),
 {jsonrpc:'2.0',id:1,error:{code:-1,message:token}},
])('rejects unsuccessful or unsupported initialization case %# before a tool call',async initialize=>{
 const {fetcher,requests}=fixture(undefined,{initialize:json(initialize)});await expect(motionMcpCall(token,'get_reports',{},fetcher)).rejects.toThrow();expect(requests).toHaveLength(1);
});

it('rejects an oversized server session before forwarding it',async()=>{
 const {fetcher,requests}=fixture(undefined,{initialize:json(rpc(1,initialized),{'Mcp-Session-Id':'s'.repeat(4097)})});
 await expect(motionMcpCall(token,'get_reports',{},fetcher)).rejects.toThrow();expect(requests).toHaveLength(1);
});

it.each([401,403,429,500])('reports sanitized HTTP %i without consuming the provider error',async status=>{
 const {fetcher}=fixture(undefined,{tool:new Response(token,{status})});const failure=await motionMcpCall(token,'get_reports',{},fetcher).then(()=>null,error=>error);
 expect(String(failure)).toContain(`HTTP ${status}`);expect(String(failure)).not.toContain(token);
});

it('rejects redirects without following them',async()=>{
 const response=json(rpc(1,initialized));Object.defineProperty(response,'redirected',{value:true});
 const {fetcher,requests}=fixture(undefined,{initialize:response});await expect(motionMcpCall(token,'get_reports',{},fetcher)).rejects.toThrow();expect(requests).toHaveLength(1);expect(requests[0].options.redirect).toBe('error');
});

it.each([
 new Response('not-json',{headers:{'Content-Type':'application/json'}}),
 new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}),
 new Response('data: not-json\n\n',{headers:{'Content-Type':'text/event-stream'}}),
 new Response('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),
])('rejects malformed or incomplete protocol content case %#',async tool=>{
 const {fetcher}=fixture(undefined,{tool});await expect(motionMcpCall(token,'get_reports',{},fetcher)).rejects.toThrow();
});

it.each(['application/json','text/event-stream'])('bounds streamed %s response bytes to 1 MiB and cancels oversized data',async contentType=>{
 const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},cancel});
 const {fetcher}=fixture(undefined,{tool:new Response(body,{headers:{'Content-Type':contentType}})});
 await expect(motionMcpCall(token,'get_reports',{},fetcher)).rejects.toThrow('Motion MCP response exceeds 1 MiB');expect(cancel).toHaveBeenCalled();
});

it('rejects excessive Content-Length without reading the response',async()=>{
 const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({cancel});const {fetcher}=fixture(undefined,{tool:new Response(body,{headers:{'Content-Type':'application/json','Content-Length':String(1024*1024+1)}})});
 await expect(motionMcpCall(token,'get_reports',{},fetcher)).rejects.toThrow('Motion MCP response exceeds 1 MiB');expect(cancel).toHaveBeenCalled();
});

it('limits all three request phases to one 30-second deadline and aborts a stalled fetch',async()=>{
 vi.useFakeTimers();const signals:AbortSignal[]=[],methods:string[]=[];
 const fetcher:typeof fetch=async(_url,init)=>{signals.push(init!.signal!);const method=JSON.parse(String(init?.body)).method;methods.push(method);await new Promise(resolve=>setTimeout(resolve,12000));return method==='initialize'?json(rpc(1,initialized)):method==='notifications/initialized'?new Response(null,{status:202}):json(rpc(2,{content:[]}));};
 const outcome=motionMcpCall(token,'get_reports',{},fetcher).then(()=>null,error=>error);await vi.advanceTimersByTimeAsync(30000);
 expect(String(await outcome)).toBe('Error: Motion MCP request timed out');expect(methods).toEqual(['initialize','notifications/initialized','tools/call']);expect(signals.every(signal=>signal.aborted)).toBe(true);
 await vi.advanceTimersByTimeAsync(12000);expect(methods).toHaveLength(3);
});

it('times out a response body that never closes and cancels the active reader',async()=>{
 vi.useFakeTimers();const cancel=vi.fn();const {fetcher}=fixture(undefined,{tool:new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel}),{headers:{'Content-Type':'application/json'}})});
 const outcome=motionMcpCall(token,'get_reports',{},fetcher).then(()=>null,error=>error);await vi.advanceTimersByTimeAsync(30000);
 expect(String(await outcome)).toBe('Error: Motion MCP request timed out');expect(cancel).toHaveBeenCalled();
});

it('does not start later phases after an initialization fetch resolves beyond the deadline',async()=>{
 vi.useFakeTimers();const {fetcher:base,requests}=fixture();const fetcher:typeof fetch=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,31000));return base(...args);};
 const outcome=motionMcpCall(token,'get_reports',{},fetcher).then(()=>null,error=>error);await vi.advanceTimersByTimeAsync(30000);expect(String(await outcome)).toBe('Error: Motion MCP request timed out');
 await vi.advanceTimersByTimeAsync(2000);expect(requests).toHaveLength(1);
});

it.each([{structuredContent:{access_token:token}},{content:[{type:'text',text:`provider echoed ${token}`}]}])('rejects a provider-echoed access token case %# instead of returning it',async output=>{
 const {fetcher}=fixture(output);const failure=await motionMcpCall(token,'get_reports',{},fetcher).then(()=>null,error=>error);expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain(token);
});

it('sanitizes thrown transport errors and never logs requests, tokens or provider payloads',async()=>{
 const log=vi.spyOn(console,'log').mockImplementation(()=>{}),warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),error=vi.spyOn(console,'error').mockImplementation(()=>{});
 const fetcher:typeof fetch=async()=>{throw Error(`${token} secret-provider-payload`);};const failure=await motionMcpCall(token,'get_reports',{},fetcher).then(()=>null,error=>error);
 expect(String(failure)).toBe('Error: Motion MCP request failed');expect(failure.cause).toBeUndefined();expect(log).not.toHaveBeenCalled();expect(warn).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();
});

it('uses the default fetch implementation when a fetcher is not supplied',async()=>{
 const {fetcher}=fixture();vi.stubGlobal('fetch',fetcher);expect(await motionMcpCall(token,'get_auth_context',{})).toEqual({organizations:[{id:'organization'}]});
});
