import {getChatGPTUser,chatGPTSignInPath} from './chatgpt-auth';
import {initializePrivateOwner,requireClientAccess} from '../lib/server/access';
import {loadWorkspace} from '../lib/server/workspace';
import {Dashboard} from '../components/analytics/dashboard';
export const dynamic='force-dynamic';
export async function AuthorizedWorkspace({clientId}:{clientId?:string}) {
  const user=await getChatGPTUser();
  if(!user)return <main className="auth-screen"><div className="auth-card"><span className="brand-mark">Z</span><p className="eyebrow">AVENUE Z INTELLIGENCE</p><h1>Your team's client workspace.</h1><p>Performance, evidence, and daily reviews in one place.</p><a className="primary-button" href={chatGPTSignInPath(clientId?`/clients/${clientId}`:'/')} target="_top">Sign in to your workspace</a></div></main>;
  try {await initializePrivateOwner();if(clientId)await requireClientAccess(clientId);const data=await loadWorkspace(new URLSearchParams());return <Dashboard initial={data} clientId={clientId} userName={user.displayName}/>;}
  catch {return <main className="auth-screen"><div className="auth-card"><span className="brand-mark">Z</span><h1>Workspace unavailable</h1><p>Your membership or shared database needs attention. An administrator can restore access.</p><a className="primary-button" href="/">Try again</a></div></main>;}
}
export default function Home(){return <AuthorizedWorkspace/>;}
