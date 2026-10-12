import {loadWorkspace} from '../../../lib/server/workspace';
import {workspaceAction} from '../../../lib/server/actions';
export async function GET(request:Request){try{const url=new URL(request.url),params=url.searchParams;
 // Older open dashboard bundles also receive scoped reads during a release.
 // This is only navigation context; loadWorkspace still authorizes the client.
 if(!params.has('clientId')){try{const referrer=new URL(request.headers.get('Referer')||''),match=referrer.pathname.match(/^\/clients\/([^/]+)\/?$/);if(referrer.origin===url.origin&&match)params.set('clientId',decodeURIComponent(match[1]));}catch{/* Missing referrer retains the portfolio scope. */}}
 return Response.json(await loadWorkspace(params),{headers:{'Cache-Control':'no-store'}});}catch(e){const message=e instanceof Error?e.message:'Workspace unavailable';return Response.json({error:message},{status:message.includes('Sign in')?401:message.includes('access')?403:400});}}
export async function POST(request:Request){try{return Response.json(await workspaceAction(request),{headers:{'Cache-Control':'no-store'}});}catch(e){const message=e instanceof Error?e.message:'Save failed';return Response.json({error:message},{status:message.includes('Sign in')?401:message.includes('access')?403:message.includes('Changed')?409:400});}}
