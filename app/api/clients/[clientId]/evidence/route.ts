import {requireClientAccess} from '../../../../../lib/server/access';
import {parseFilters} from '../../../../../lib/server/workspace';
import {bridgedClientEvidence} from '../../../../../lib/server/company-workspace-bridge';
import {clientEvidenceJSON,clientEvidenceFailure} from '../../../../../lib/server/client-evidence';
export async function GET(request:Request,{params}:{params:Promise<{clientId:string}>}){
 try{
  const {clientId}=await params,scope=await requireClientAccess(clientId),query=new URL(request.url).searchParams;
  parseFilters(query);const segment=query.get('segment');if(!segment||segment.length>4000)throw Error('Choose a valid segment');
  const remote=await bridgedClientEvidence(scope,clientId,query);
  if(remote)return Response.json(remote,{headers:{'Cache-Control':'no-store'}});
  return new Response(await clientEvidenceJSON(scope,clientId,query,'evidence'),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 }catch(error){return clientEvidenceFailure(error,'evidence');}
}
