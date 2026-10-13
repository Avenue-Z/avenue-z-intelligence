import {companyWorkspaceAccess} from '../../../../lib/server/company-workspace-bridge';
import {clientEvidenceJSON,clientEvidenceFailure} from '../../../../lib/server/client-evidence';
export const maxDuration=120;
export async function POST(request:Request){
 try{
  const {scope,params}=await companyWorkspaceAccess(request,'export'),clientId=params.get('clientId');
  if(!clientId)throw Error('Client access denied');
  return new Response(await clientEvidenceJSON(scope,clientId,params,'export'),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 }catch(error){return clientEvidenceFailure(error,'export');}
}
