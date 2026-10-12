import {companyWorkspaceAccess,publicCompanyWorkspaceSizeError} from '../../../../lib/server/company-workspace-bridge';
import {loadWorkspaceForScope} from '../../../../lib/server/workspace';
export const maxDuration=120;
export async function POST(request:Request){
 try{const {scope,params}=await companyWorkspaceAccess(request),payload=JSON.stringify(await loadWorkspaceForScope(params,scope));if(new TextEncoder().encode(payload).byteLength>4*1024*1024)return Response.json({error:publicCompanyWorkspaceSizeError},{status:413,headers:{'Cache-Control':'no-store'}});return new Response(payload,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
 catch(error){const denied=error instanceof Error&&(/access|Sign in/.test(error.message));return Response.json({error:denied?'Workspace access denied':'Company workspace unavailable'},{status:denied?403:400,headers:{'Cache-Control':'no-store'}});}
}
