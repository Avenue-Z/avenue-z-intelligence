import {env,runtimePlatform} from '@avenue/runtime';
import {chatGPTSignInPath} from '../chatgpt-auth';
import {SignInScreen} from '../../components/auth/sign-in-screen';
import {googleSignInError,sanitizeSignInCallback} from '../../lib/auth/sign-in';

export const dynamic='force-dynamic';
export default async function SignIn({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const query=await searchParams,base=(env as unknown as Record<string,unknown>).AUTH_URL;
 const callbackUrl=sanitizeSignInCallback(query.callbackUrl,typeof base==='string'?base:undefined);
 const error=typeof query.error==='string'?googleSignInError(query.error):undefined;
 return <SignInScreen callbackUrl={callbackUrl} provider={runtimePlatform==='vercel'?'google':'chatgpt'} signInPath={runtimePlatform==='vercel'?undefined:chatGPTSignInPath(callbackUrl)} error={error}/>;
}
