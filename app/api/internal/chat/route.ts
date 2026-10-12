import {companyWorkspaceAccess,publicCompanyAIErrors} from '../../../../lib/server/company-workspace-bridge';
import {answerAI,parseAIRequest} from '../../../../lib/ai/server';
export const maxDuration=180;
export async function POST(request:Request){
 try{
  const {scope,params}=await companyWorkspaceAccess(request,'chat'),body=JSON.parse(params.get('payload')||'null');
  if(!body||typeof body!=='object'||Object.keys(body).some(key=>!['clientId','reviewId','filters','question'].includes(key)))throw Error('Invalid AI request');
  const parsed=parseAIRequest(body);if(parsed.clientId!==(params.get('clientId')||undefined))throw Error('Client access denied');
  return Response.json(await answerAI({...parsed,question:body.question},scope),{headers:{'Cache-Control':'no-store'}});
 }catch(error){const denied=error instanceof Error&&/access|Sign in/.test(error.message);return Response.json({error:denied?'AI access denied':error instanceof Error&&publicCompanyAIErrors.includes(error.message)?error.message:'Company AI request unavailable'},{status:denied?403:400,headers:{'Cache-Control':'no-store'}});}
}
