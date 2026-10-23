import {companyWorkspaceAccess,publicCompanyAIErrors} from '../../../../lib/server/company-workspace-bridge';
import {parseAIRequest} from '../../../../lib/ai/server';
import {answerPlatformAI as answerAI} from '../../../../lib/ai/platform-chat';
export const maxDuration=180;
export async function POST(request:Request){
 try{
  const {scope,params}=await companyWorkspaceAccess(request,'chat'),body=JSON.parse(params.get('payload')||'null');
  if(!body||typeof body!=='object'||Object.keys(body).some(key=>!['clientId','reviewId','filters','question'].includes(key)))throw Error('Invalid AI request');
  const parsed=parseAIRequest(body);if(parsed.clientId!==(params.get('clientId')||undefined))throw Error('Client access denied');
  return Response.json(await answerAI({...parsed,question:body.question},scope),{headers:{'Cache-Control':'no-store'}});
 }catch(error){
  const message=error instanceof Error?error.message:'',denied=error instanceof Error&&/access|Sign in/.test(message);
  if(!denied){
   const known:Record<string,string>={
    'This evidence scope cannot fit the fast chat preview. Choose one client or a narrower reporting scope.':'AI_CHAT_PREVIEW_TOO_LARGE',
    'This evidence scope is too large for a bounded AI preview. Choose one client or a narrower reporting scope.':'AI_MODEL_PREVIEW_TOO_LARGE',
    'AI returned an unsupported citation; please retry':'AI_UNSUPPORTED_CITATION',
    'The AI response was incomplete. Please retry.':'AI_RESPONSE_INCOMPLETE',
    'No analysis was returned. Please retry.':'AI_EMPTY_RESPONSE',
    'AI analysis timed out. Please retry with a narrower question.':'AI_PROVIDER_TIMEOUT',
    'OpenAI usage or billing limit reached. Check the Platform project, then retry.':'OPENAI_USAGE_LIMIT',
    'Hourly AI request limit reached. Please try again later.':'AI_HOURLY_LIMIT',
    'OpenAI is not configured':'OPENAI_NOT_CONFIGURED'
   },status=/^OpenAI is temporarily unavailable \((\d{3})\)\. Please retry\.$/.exec(message),code=known[message]??(status?`OPENAI_HTTP_${status[1]}`:error instanceof Error&&error.name==='ZodError'?'AI_RESPONSE_FORMAT_REJECTED':'AI_CHAT_FAILED'),kind=error instanceof Error&&['Error','TypeError','ZodError','LibsqlError','AbortError','SyntaxError'].includes(error.name)?error.name:'Unknown';
   // Fixed classifications only: provider bodies and request/evidence content
   // must never enter application logs.
   console.error('Company AI chat failed',{kind,code});
  }
  return Response.json({error:denied?'AI access denied':error instanceof Error&&publicCompanyAIErrors.includes(error.message)?error.message:'Company AI request unavailable'},{status:denied?403:400,headers:{'Cache-Control':'no-store'}});
 }
}
