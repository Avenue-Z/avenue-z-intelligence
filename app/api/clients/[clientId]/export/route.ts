import {requireClientAccess} from '../../../../../lib/server/access';
import {parseFilters} from '../../../../../lib/server/workspace';
import {bridgedClientExport} from '../../../../../lib/server/company-workspace-bridge';
import {clientEvidenceJSON,clientEvidenceFailure} from '../../../../../lib/server/client-evidence';
export async function GET(request:Request,{params}:{params:Promise<{clientId:string}>}){
 try{
  const {clientId}=await params,scope=await requireClientAccess(clientId),query=new URL(request.url).searchParams;
  parseFilters(query);
  const result=await bridgedClientExport(scope,clientId,query)??JSON.parse(await clientEvidenceJSON(scope,clientId,query,'export')) as {csv:string};
  return new Response(result.csv,{headers:{'Content-Type':'text/csv;charset=utf-8','Content-Disposition':'attachment; filename="analytics.csv"','Cache-Control':'no-store'}});
 }catch(error){return clientEvidenceFailure(error,'export');}
}
