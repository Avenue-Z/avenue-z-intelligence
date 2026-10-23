import {z} from 'zod';
import {cronRequest} from '../../../../lib/server/cron';
import {serverSecret} from '../../../../lib/server/secrets';
import {qualifyAutobrushNorthbeam} from '../../../../lib/server/autobrush-northbeam-qualification';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=240;
const input=z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),resume:z.string().min(1).max(4096).optional()}).strict();
// Protected onboarding only. This endpoint is absent from recurring cron entries
// and accepts no account, credentials, export IDs or arbitrary export requests.
export async function POST(request:Request){return cronRequest(request,async()=>{
 let value:unknown;
 try{if(new URL(request.url).search||Number(request.headers.get('content-length'))>6000)throw Error();const reader=request.body?.getReader();if(!reader)throw Error();let text='',bytes=0;try{const decoder=new TextDecoder('utf8',{fatal:true});for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>6000)throw Error();text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{void reader.cancel().catch(()=>{});}value=JSON.parse(text);}catch{return {failed:[{provider:'northbeam',reason:'invalid_request'}],qualification:{status:'failed',reason:'invalid_request',qualifiedForActivation:false}};}
 const parsed=input.safeParse(value);
 if(!parsed.success)return {failed:[{provider:'northbeam',reason:'invalid_request'}],qualification:{status:'failed',reason:'invalid_request',qualifiedForActivation:false}};
 const qualification=await qualifyAutobrushNorthbeam(parsed.data,serverSecret);
 return {failed:qualification.status==='failed'?[{provider:'northbeam',reason:qualification.reason}]:[],qualification};
});}
