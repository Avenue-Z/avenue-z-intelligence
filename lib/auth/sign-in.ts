const DEFAULT_CALLBACK='/clients/kind-patches';
const ERROR_MESSAGES:Record<string,string>={
 AccessDenied:'Use your verified @avenuez.com Google account to access this workspace.',
 OAuthSignin:'Google sign-in could not start. Please try again.',
 OAuthCallback:'Google sign-in could not be completed. Please try again.',
 OAuthAccountNotLinked:'Please use the Google account already associated with your workspace access.',
 CallbackRouteError:'Google sign-in could not be completed. Please try again.',
 MissingCSRF:'Your sign-in session expired. Please try again.',
 SessionRequired:'Please sign in to open this workspace.',
 Configuration:'Sign-in is temporarily unavailable. Please try again shortly.',
};

export function googleSignInError(code:unknown):string {
 return typeof code==='string'&&Object.hasOwn(ERROR_MESSAGES,code)?ERROR_MESSAGES[code]:'Sign-in could not be completed. Please try again.';
}

export function sanitizeSignInCallback(value:unknown,baseOrigin?:string):string {
 if(typeof value!=='string'||!value||/[\u0000-\u001f\\]/.test(value))return DEFAULT_CALLBACK;
 try{
  const base=new URL(baseOrigin||'https://app.local');
  if(!value.startsWith('/')&&!baseOrigin)return DEFAULT_CALLBACK;
  const target=new URL(value,base.origin);
  if(target.origin!==base.origin||target.username||target.password)return DEFAULT_CALLBACK;
  let path=target.pathname;
  for(let i=0;i<2;i++)path=decodeURIComponent(path);
  const route=path.replace(/\/+$/,'')||'/';
  if(path.startsWith('//')||path.includes('\\')||route==='/signin'||route==='/api/auth'||route.startsWith('/api/auth/')||['/signin-with-chatgpt','/signout-with-chatgpt','/callback'].includes(route))return DEFAULT_CALLBACK;
  return `${target.pathname}${target.search}${target.hash}`;
 }catch{return DEFAULT_CALLBACK;}
}

export async function requestGoogleSignIn(callbackUrl:string,appOrigin:string,fetcher:typeof fetch=fetch):Promise<string> {
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15_000);
 const unavailable='Google sign-in could not start. Please try again.';
 try{
  const csrfResponse=await fetcher('/api/auth/csrf',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
  if(!csrfResponse.ok)throw new Error(unavailable);
  const csrf=await csrfResponse.json() as {csrfToken?:unknown};
  if(typeof csrf.csrfToken!=='string'||!csrf.csrfToken)throw new Error(unavailable);
  const response=await fetcher('/api/auth/signin/google',{method:'POST',credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/x-www-form-urlencoded','X-Auth-Return-Redirect':'1'},body:new URLSearchParams({csrfToken:csrf.csrfToken,callbackUrl:sanitizeSignInCallback(callbackUrl,appOrigin)})});
  if(!response.ok)throw new Error(unavailable);
  const result=await response.json() as {url?:unknown};
  if(typeof result.url!=='string')throw new Error(unavailable);
  const target=new URL(result.url,appOrigin);
  if(target.origin===new URL(appOrigin).origin&&target.pathname==='/signin')throw new Error(googleSignInError(target.searchParams.get('error')));
  if(target.protocol!=='https:'||target.hostname!=='accounts.google.com'||target.port||target.username||target.password||!['/o/oauth2/v2/auth','/o/oauth2/auth'].includes(target.pathname))throw new Error(unavailable);
  return target.href;
 }catch(error){
  if(controller.signal.aborted)throw new Error('Sign-in timed out. Please try again.');
  if(error instanceof Error&&(error.message===unavailable||Object.values(ERROR_MESSAGES).includes(error.message)||error.message===googleSignInError(null)))throw error;
  throw new Error(unavailable);
 }finally{clearTimeout(timeout);}
}
