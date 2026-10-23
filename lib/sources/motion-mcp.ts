type ReadTool='get_auth_context'|'get_creative_insights'|'get_reports'|'get_demographic_breakdown';
const readTools=new Set<string>(['get_auth_context','get_creative_insights','get_reports','get_demographic_breakdown']);
const protocolVersions=new Set(['2025-03-26','2025-06-18','2025-11-25']);
const responseLimit=1024*1024;
class MotionMcpError extends Error{}
const invalidResponse=()=>new MotionMcpError('Motion MCP returned an invalid response');
const timedOut=()=>new MotionMcpError('Motion MCP request timed out');
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function visibleString(value:unknown,limit:number):value is string{return typeof value==='string'&&value.length>0&&value.length<=limit&&/^[\x21-\x7e]+$/.test(value);}
function parseJson(text:string):unknown{try{return JSON.parse(text);}catch{throw invalidResponse();}}
function rpcResult(message:unknown,id:number){
 if(!record(message)||message.jsonrpc!=='2.0'||message.id!==id||Object.hasOwn(message,'method'))throw invalidResponse();
 if(Object.hasOwn(message,'error'))throw new MotionMcpError('Motion MCP request was rejected');
 if(!Object.hasOwn(message,'result'))throw invalidResponse();
 return message.result;
}

type ReadContext={signal:AbortSignal;reader?:ReadableStreamDefaultReader<Uint8Array>};
async function readRpc(response:Response,id:number,context:ReadContext):Promise<unknown>{
 if(Number(response.headers.get('Content-Length'))>responseLimit)throw new MotionMcpError('Motion MCP response exceeds 1 MiB');
 const contentType=response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
 if(!response.body||contentType!=='application/json'&&contentType!=='text/event-stream')throw invalidResponse();
 const reader=response.body.getReader();context.reader=reader;
 const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,buffer='',data:string[]=[];
 const sseLine=(line:string):Record<string,unknown>|undefined=>{
  if(line===''){
   if(!data.length)return;const text=data.join('\n');data=[];if(!text)return;const message=parseJson(text);
   if(!record(message)||message.jsonrpc!=='2.0')throw invalidResponse();
   if(!Object.hasOwn(message,'method')&&message.id===id)return message;
   return;
  }
  if(line.startsWith(':'))return;
  const colon=line.indexOf(':'),field=colon===-1?line:line.slice(0,colon);let value=colon===-1?'':line.slice(colon+1);
  if(value.startsWith(' '))value=value.slice(1);if(field==='data')data.push(value);
 };
 try{
  for(;;){
   const chunk=await reader.read();if(context.signal.aborted)throw timedOut();
   if(chunk.value){bytes+=chunk.value.byteLength;if(bytes>responseLimit)throw new MotionMcpError('Motion MCP response exceeds 1 MiB');}
   buffer+=decoder.decode(chunk.value,{stream:!chunk.done});
   if(contentType==='text/event-stream'){
    for(;;){
     const index=buffer.search(/[\r\n]/);if(index<0||buffer[index]==='\r'&&index===buffer.length-1&&!chunk.done)break;
     const line=buffer.slice(0,index),separator=buffer[index]==='\r'&&buffer[index+1]==='\n'?2:1;buffer=buffer.slice(index+separator);
     const message=sseLine(line);if(message)return rpcResult(message,id);
    }
   }
   if(chunk.done)break;
  }
  if(contentType==='text/event-stream')throw invalidResponse();
  return rpcResult(parseJson(buffer),id);
 }finally{context.reader=undefined;void reader.cancel().catch(()=>{});}
}

function toolPayload(result:unknown,accessToken:string):unknown{
 if(!record(result))throw invalidResponse();
 if(result.isError===true)throw new MotionMcpError('Motion MCP tool failed');
 if(result.isError!==undefined&&typeof result.isError!=='boolean')throw invalidResponse();
 let output:unknown;
 if(Object.hasOwn(result,'structuredContent')){
  if(!record(result.structuredContent))throw invalidResponse();output=result.structuredContent;
 }else{
  if(!Array.isArray(result.content)||result.content.some(item=>!record(item)||typeof item.type!=='string'||item.type==='text'&&typeof item.text!=='string'))throw invalidResponse();
  output=result.content;
  if(result.content.length===1&&result.content[0].type==='text'){
   try{const parsed:unknown=JSON.parse(result.content[0].text);if(record(parsed))output=parsed;}catch{/* Plain text remains a content block. */}
  }
 }
 // A provider must never turn an echoed bearer token into caller-visible data.
 JSON.stringify(output,(key,value:unknown)=>{if(key.includes(accessToken)||typeof value==='string'&&value.includes(accessToken))throw invalidResponse();return value;});
 return output;
}

export async function motionMcpCall(accessToken:string,toolName:ReadTool,args:Record<string,unknown>,fetcher:typeof fetch=fetch):Promise<unknown>{
 let serializedArguments:string;
 try{
  if(!visibleString(accessToken,16384)||!readTools.has(toolName)||!record(args))throw new Error();
  serializedArguments=JSON.stringify(args);
  if(!record(JSON.parse(serializedArguments))||new TextEncoder().encode(serializedArguments).byteLength>responseLimit)throw new Error();
 }catch{throw new Error('Invalid Motion MCP request');}
 const controller=new AbortController(),context:ReadContext={signal:controller.signal};let timer:ReturnType<typeof setTimeout>|undefined;
 let sessionId:string|undefined,protocolVersion='2025-03-26';
 const post=async(body:Record<string,unknown>,id?:number)=>{
  if(controller.signal.aborted)throw timedOut();
  const response=await fetcher('https://projects.motionapp.com/mcp',{
   method:'POST',redirect:'error',signal:controller.signal,
   headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...sessionId?{'Mcp-Session-Id':sessionId}:{},...body.method==='initialize'?{}:{'MCP-Protocol-Version':protocolVersion}},
   body:JSON.stringify(body),
  });
  try{
   if(controller.signal.aborted)throw timedOut();
   if(response.redirected)throw new MotionMcpError('Motion MCP rejected a redirect');
   if(!response.ok)throw new MotionMcpError(`Motion MCP returned HTTP ${response.status}`);
   if(id===undefined){if(response.status!==202&&response.status!==204)throw invalidResponse();return {response,result:undefined};}
   return {response,result:await readRpc(response,id,context)};
  }finally{void response.body?.cancel().catch(()=>{});}
 };
 const perform=async()=>{
  const initialized=await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion,capabilities:{},clientInfo:{name:'beam-analytics',version:'1.0.0'}}},1);
  if(!record(initialized.result)||typeof initialized.result.protocolVersion!=='string'||!protocolVersions.has(initialized.result.protocolVersion)||!record(initialized.result.capabilities)||!record(initialized.result.capabilities.tools))throw invalidResponse();
  protocolVersion=initialized.result.protocolVersion;
  const serverSession=initialized.response.headers.get('Mcp-Session-Id');
  if(serverSession!==null){if(!visibleString(serverSession,4096))throw invalidResponse();sessionId=serverSession;}
  await post({jsonrpc:'2.0',method:'notifications/initialized'});
  const result=await post({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:toolName,arguments:JSON.parse(serializedArguments)}},2);
  return toolPayload(result.result,accessToken);
 };
 const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{reject(timedOut());controller.abort();void context.reader?.cancel().catch(()=>{});},30000);});
 try{return await Promise.race([perform(),timeout]);}
 catch(error){throw new Error(error instanceof MotionMcpError?error.message:'Motion MCP request failed');}
 finally{clearTimeout(timer);controller.abort();void context.reader?.cancel().catch(()=>{});}
}
