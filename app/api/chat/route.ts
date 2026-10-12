import {answerAI,parseAIRequest} from '../../../lib/ai/server';
import {loadAISession,sessionHistory} from '../../../lib/ai/session';
import {checkApplicationOrigin as checkOrigin} from '../../../lib/server/request-origin';
import {serverSecret} from '../../../lib/server/secrets';
export async function GET(request:Request){try{const p=new URL(request.url).searchParams,b={clientId:p.get('clientId'),reviewId:p.get('reviewId'),filters:Object.fromEntries(p)},a=parseAIRequest(b),session=await loadAISession(a.clientId,a.filters,a.reviewId);return Response.json({turns:await sessionHistory(session),configured:!!serverSecret('OPENAI_API_KEY'),scope:{filters:session.filters,clients:session.clients,reviewId:session.reviewId}},{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:(e as Error).message},{status:403});}}
export async function POST(request:Request){try{checkOrigin(request);const text=await request.text();if(text.length>15000)throw new Error('Question request too large');return Response.json(await answerAI(JSON.parse(text)),{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:(e as Error).message},{status:400});}}
