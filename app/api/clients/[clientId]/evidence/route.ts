import {requireClientAccess,getStore} from '../../../../../lib/server/access';
import {parseFilters} from '../../../../../lib/server/workspace';
import {queryClient} from '../../../../../lib/analytics/query';
export async function GET(request:Request,{params}:{params:Promise<{clientId:string}>}){
 try{const {clientId}=await params,scope=await requireClientAccess(clientId),p=new URL(request.url).searchParams,f=parseFilters(p),segment=p.get('segment');if(!segment||segment.length>4000)throw new Error('Choose a valid segment');const s=getStore(),client=(await s.clients(scope.organizationId)).find(c=>c.id===clientId);if(!client)throw new Error('Client unavailable');const a=queryClient(client,await s.observations(scope.organizationId,clientId,f),await s.connections(scope.organizationId,clientId),f),dataset=f.view==='overview'?'funnels':f.view;const rows=a.evidence.filter(r=>r.dataset===dataset&&JSON.stringify(Object.entries(r.dimensions).sort())===segment);return Response.json({rows},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Evidence unavailable or client access denied'},{status:403});}
}
