import {parseAIRequest} from '../../../lib/ai/server';
import {answerPlatformAI as answerAI} from '../../../lib/ai/platform-chat';
import {loadPlatformSession as loadAISession,platformSessionHistory as sessionHistory} from '../../../lib/ai/platform-session';
import {checkApplicationOrigin as checkOrigin} from '../../../lib/server/request-origin';
import {serverSecret} from '../../../lib/server/secrets';
import {requireClientAccess} from '../../../lib/server/access';
import {bridgedChat} from '../../../lib/server/company-workspace-bridge';
import {withChatRequestStore} from '../../../lib/server/chat-request-store';
import {createChatPhaseRunner} from '../../../lib/ai/chat-phases';
export const maxDuration=180;
export async function GET(request:Request){try{const p=new URL(request.url).searchParams,b={clientId:p.get('clientId'),reviewId:p.get('reviewId'),filters:Object.fromEntries(p)},a=parseAIRequest(b);return await withChatRequestStore(async store=>{const phase=createChatPhaseRunner(),scope=await phase('authorize',()=>requireClientAccess(a.clientId,false,store)),session=await phase('context',()=>loadAISession(a.clientId,a.filters,a.reviewId,scope,store));return Response.json({turns:await phase('history',()=>sessionHistory(session)),configured:!!serverSecret('OPENAI_API_KEY'),scope:{filters:session.filters,clients:session.clients,reviewId:session.reviewId}},{headers:{'Cache-Control':'no-store'}});});}catch(e){return Response.json({error:(e as Error).message},{status:403});}}
export async function POST(request:Request){try{checkOrigin(request);const text=await request.text();if(text.length>15000)throw new Error('Question request too large');const body=JSON.parse(text),parsed=parseAIRequest(body);return await withChatRequestStore(async store=>{const phase=createChatPhaseRunner(),scope=await phase('authorize',()=>requireClientAccess(parsed.clientId,false,store));if(typeof body.question!=='string'||!body.question.trim()||body.question.length>3000)throw Error('Ask a question of up to 3,000 characters');const input={...parsed,question:body.question};return Response.json(await bridgedChat(scope,input)??await answerAI(input,scope,{store,phase}),{headers:{'Cache-Control':'no-store'}});});}catch(e){return Response.json({error:(e as Error).message},{status:400});}}
