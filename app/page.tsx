import {getChatGPTUser,chatGPTSignInPath} from './chatgpt-auth';
import {initializePrivateOwner,requireClientAccess} from '../lib/server/access';
import {loadWorkspace,workspaceSearchParams} from '../lib/server/workspace';
import {Dashboard} from '../components/analytics/dashboard';
import {runtimePlatform} from '@avenue/runtime';
import {SignInScreen} from '../components/auth/sign-in-screen';
export const dynamic='force-dynamic';
export async function AuthorizedWorkspace({clientId,query=new URLSearchParams()}:{clientId?:string;query?:URLSearchParams}) {
  const user=await getChatGPTUser();
  if(!user){const callbackUrl=`${clientId?`/clients/${encodeURIComponent(clientId)}`:'/'}${query.size?`?${query}`:''}`;return <SignInScreen callbackUrl={callbackUrl} provider={runtimePlatform==='vercel'?'google':'chatgpt'} signInPath={chatGPTSignInPath(callbackUrl)}/>;}
  try {await initializePrivateOwner();if(clientId)await requireClientAccess(clientId);const requestQuery=new URLSearchParams(query);if(clientId)requestQuery.set('clientId',clientId);const data=await loadWorkspace(requestQuery),section=query.get('section')||'portfolio';return <Dashboard initial={data} initialSection={['portfolio','findings','reviews','sources','settings','ai'].includes(section)?section:'portfolio'} clientId={clientId} userName={user.displayName}/>;}
  catch(error) {console.warn('Workspace load failed',{reason:error instanceof Error&&/^Company workspace/.test(error.message)?error.message:'Workspace access or data load failed',kind:error instanceof Error?error.name:'Unknown'});const waiting=error instanceof Error&&/^Analytics /.test(error.message),retry=`${clientId?`/clients/${encodeURIComponent(clientId)}`:'/'}?${query}`;return <main className="auth-screen"><div className="auth-card"><span className="brand-mark">Z</span><h1>{waiting?'Preparing this period':'Workspace unavailable'}</h1><p>{waiting?(error as Error).message:'The workspace could not load. Please retry, or ask an administrator to check access and the shared database.'}</p><a className="primary-button" href={retry}>Try again</a></div></main>;}
}
export default async function Home({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){return <AuthorizedWorkspace query={workspaceSearchParams(await searchParams??{})}/>;}
