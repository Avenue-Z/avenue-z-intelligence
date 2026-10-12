import {getChatGPTUser,chatGPTSignInPath} from './chatgpt-auth';
import {initializePrivateOwner,requireClientAccess} from '../lib/server/access';
import {loadWorkspace,workspaceSearchParams} from '../lib/server/workspace';
import {Dashboard} from '../components/analytics/dashboard';
export const dynamic='force-dynamic';
export async function AuthorizedWorkspace({clientId,query=new URLSearchParams()}:{clientId?:string;query?:URLSearchParams}) {
  const user=await getChatGPTUser();
  if(!user)return <main className="auth-screen"><div className="auth-card"><span className="brand-mark">Z</span><p className="eyebrow">AVENUE Z INTELLIGENCE</p><h1>Your team's client workspace.</h1><p>Performance, evidence, and daily reviews in one place.</p><a className="primary-button" href={chatGPTSignInPath(clientId?`/clients/${clientId}`:'/')} target="_top">Sign in to your workspace</a></div></main>;
  try {await initializePrivateOwner();if(clientId)await requireClientAccess(clientId);const data=await loadWorkspace(query),section=query.get('section')||'portfolio';return <Dashboard initial={data} initialSection={['portfolio','findings','reviews','sources','settings','ai'].includes(section)?section:'portfolio'} clientId={clientId} userName={user.displayName}/>;}
  catch {return <main className="auth-screen"><div className="auth-card"><span className="brand-mark">Z</span><h1>Workspace unavailable</h1><p>Your membership or shared database needs attention. An administrator can restore access.</p><a className="primary-button" href="/">Try again</a></div></main>;}
}
export default async function Home({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <AuthorizedWorkspace query={workspaceSearchParams(await searchParams??{})}/>;}
