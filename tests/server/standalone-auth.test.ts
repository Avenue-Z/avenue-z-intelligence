import {it,expect,vi,beforeEach} from 'vitest';
import {encode} from '@auth/core/jwt';
const state=vi.hoisted(()=>({platform:'vercel',env:{} as Record<string,unknown>,first:vi.fn(),run:vi.fn()}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:state.platform,env:state.env}));
vi.mock('../../lib/server/access',()=>({getStore:()=>({first:state.first,run:state.run})}));
import {allowGoogleIdentity,standaloneIdentity,standaloneAuthConfig,standaloneAuth} from '../../lib/server/standalone-auth';
beforeEach(()=>{vi.clearAllMocks();for(const key of Object.keys(state.env))delete state.env[key];Object.assign(state.env,{AUTH_SECRET:'a'.repeat(48),AUTH_URL:'https://app.example',AUTH_GOOGLE_ID:'client',AUTH_GOOGLE_SECRET:'secret',APP_BOOTSTRAP_ADMIN_EMAIL:'owner@example.com'});state.first.mockResolvedValue(null);state.run.mockResolvedValue({meta:{changes:1}});});
it('rejects Google profiles with unverified email and uninvited accounts',async()=>{
 expect(await allowGoogleIdentity({email:'owner@example.com',email_verified:false,sub:'id'})).toBe(false);
 expect(await allowGoogleIdentity({email:'outsider@example.com',email_verified:true,sub:'id'})).toBe(false);
 expect(state.run).not.toHaveBeenCalled();
});
it('allows the explicit bootstrap admin only for an empty workspace',async()=>{
 expect(await allowGoogleIdentity({email:'owner@example.com',email_verified:true,sub:'owner'})).toBe(true);
 state.first.mockResolvedValueOnce(null).mockResolvedValueOnce({n:1});
 expect(await allowGoogleIdentity({email:'owner@example.com',email_verified:true,sub:'owner'})).toBe(false);
});
it('accepts an invited verified email with an existing native Sites identity',async()=>{
 state.first.mockImplementation(async(query:string)=>query.startsWith('SELECT email FROM member_identities')||query.includes("actorId LIKE 'google:%'")?null:{email:'analyst@example.com',role:'analyst',actorId:'old-sites-id',clients:'["kind-patches"]'});
 expect(await allowGoogleIdentity({email:'analyst@example.com',email_verified:true,sub:'google-id'})).toBe(true);
});
it('ignores forged platform headers and rejects tampered app sessions',async()=>{
 expect(await standaloneIdentity(new Headers({'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.com'}))).toBeNull();
 const cookieName='__Secure-authjs.session-token';
 const config=standaloneAuthConfig();
 const claims=await config.callbacks!.jwt!({token:{sub:'sdk-random-user-id',email:'analyst@example.com',name:'Analyst'},account:{provider:'google',providerAccountId:'google-id',type:'oidc'},user:{id:'sdk-random-user-id'},trigger:'signIn'} as any);
 const token=await encode({token:claims!,secret:state.env.AUTH_SECRET as string,salt:cookieName});
 const identity=await standaloneIdentity(new Headers({cookie:`${cookieName}=${token}`}));expect(identity).toMatchObject({userId:'google:google-id',email:'analyst@example.com'});
 expect(await standaloneIdentity(new Headers({cookie:`${cookieName}=${token.slice(0,-5)}wrong`}))).toBeNull();
});
it('retains the SDK CSRF and secure-cookie protections',()=>{
 const config=standaloneAuthConfig();expect(config.skipCSRFCheck).toBeUndefined();expect(config.useSecureCookies).toBe(true);expect(config.session?.strategy).toBe('jwt');
});
it('routes provider-list and auth errors through the shared branded sign-in page',async()=>{
 expect(standaloneAuthConfig().pages).toMatchObject({signIn:'/signin',error:'/signin'});
 const response=await standaloneAuth(new Request('https://app.example/api/auth/signin?callbackUrl=%2Fclients%2Fkind-patches%3Fview%3Dtraffic'));
 expect(response.status).toBe(302);const destination=new URL(response.headers.get('location')!,'https://app.example');
 expect(destination.pathname).toBe('/signin');expect(destination.searchParams.get('callbackUrl')).toBe('https://app.example/clients/kind-patches?view=traffic');
});
it('rejects a direct Google sign-in POST without the SDK CSRF cookie',async()=>{
 const response=await standaloneAuth(new Request('https://app.example/api/auth/signin/google',{method:'POST',headers:{origin:'https://app.example','content-type':'application/x-www-form-urlencoded','X-Auth-Return-Redirect':'1'},body:new URLSearchParams({csrfToken:'forged-token',callbackUrl:'/clients/kind-patches'})}));
 const payload=await response.json() as {url:string};expect(payload.url).toContain('/signin?error=MissingCSRF');
});
it('starts Google OAuth directly with a valid SDK CSRF token and secure PKCE cookies',async()=>{
 const csrfResponse=await standaloneAuth(new Request('https://app.example/api/auth/csrf'));
 const {csrfToken}=await csrfResponse.json() as {csrfToken:string};
 const cookie=csrfResponse.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({issuer:'https://accounts.google.com',authorization_endpoint:'https://accounts.google.com/o/oauth2/v2/auth',token_endpoint:'https://oauth2.googleapis.com/token',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs',userinfo_endpoint:'https://openidconnect.googleapis.com/v1/userinfo',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']}));
 try{
  const response=await standaloneAuth(new Request('https://app.example/api/auth/signin/google',{method:'POST',headers:{origin:'https://app.example',cookie,'content-type':'application/x-www-form-urlencoded','X-Auth-Return-Redirect':'1'},body:new URLSearchParams({csrfToken,callbackUrl:'/clients/kind-patches?view=traffic'})}));
  expect(response.status).toBe(200);const destination=new URL((await response.json() as {url:string}).url);
  expect(destination.origin).toBe('https://accounts.google.com');expect(destination.pathname).toBe('/o/oauth2/v2/auth');expect(destination.searchParams.get('redirect_uri')).toBe('https://app.example/api/auth/callback/google');
  expect(destination.searchParams.get('code_challenge_method')).toBe('S256');expect(destination.searchParams.get('code_challenge')).toBeTruthy();
  expect(response.headers.getSetCookie().some(value=>value.includes('__Secure-authjs.pkce.code_verifier=')&&value.includes('HttpOnly')&&value.includes('Secure'))).toBe(true);
  expect(response.headers.getSetCookie().some(value=>value.includes('authjs.callback-url=')&&decodeURIComponent(value).includes('/clients/kind-patches?view=traffic'))).toBe(true);
 }finally{fetchMock.mockRestore();}
});
it('fails closed when company OAuth credentials are missing',()=>{
 delete state.env.AUTH_GOOGLE_SECRET;expect(()=>standaloneAuthConfig()).toThrow('Google application sign-in is not configured');
});
it('serves authentication behind Next proxy routing using the configured public host',async()=>{
 const r=await standaloneAuth(new Request('http://localhost:3000/api/auth/providers',{headers:{host:'app.example'}}));expect(r.status).toBe(200);expect(await r.json()).toHaveProperty('google');
 expect((await standaloneAuth(new Request('http://localhost:3000/api/auth/providers',{headers:{host:'evil.example'}}))).status).toBe(403);
});
