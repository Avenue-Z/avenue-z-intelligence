import {companyWorkspaceAccess,publicCompanyAIErrors} from '../../../../lib/server/company-workspace-bridge';
import {getStore} from '../../../../lib/server/access';
import {generateAIReview} from '../../../../lib/ai/server';
import {parseFilters} from '../../../../lib/server/workspace';
import {manualReviewMode} from '../../../../lib/reviews/manual-scope';
export const maxDuration=180;
export async function POST(request:Request){
 try{
  const {scope,params}=await companyWorkspaceAccess(request,'review'),body=JSON.parse(params.get('payload')||'null');
  if(!body||typeof body!=='object'||Object.keys(body).some(key=>!['clientId','date'].includes(key))||typeof body.clientId!=='string'||typeof body.date!=='string')throw Error('Invalid review request');
  if(body.clientId!==params.get('clientId')||!scope.permittedClientIds.includes(body.clientId))throw Error('Client access denied');
  const client=(await getStore().clients(scope.organizationId)).find(client=>client.id===body.clientId);if(!client)throw Error('Client access denied');
  const filters=parseFilters(new URLSearchParams({from:body.date,to:body.date,compare:'previous',mode:manualReviewMode(client,body.date),view:'overview'}));
  return Response.json({id:await generateAIReview(scope,client.id,filters)},{headers:{'Cache-Control':'no-store'}});
 }catch(error){const denied=error instanceof Error&&/access|Sign in/.test(error.message);return Response.json({error:denied?'Review access denied':error instanceof Error&&publicCompanyAIErrors.includes(error.message)?error.message:'Company AI review unavailable'},{status:denied?403:400,headers:{'Cache-Control':'no-store'}});}
}
