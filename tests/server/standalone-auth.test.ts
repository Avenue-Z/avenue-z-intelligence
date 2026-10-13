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
it('fails closed when company OAuth credentials are missing',()=>{
 delete state.env.AUTH_GOOGLE_SECRET;expect(()=>standaloneAuthConfig()).toThrow('Google application sign-in is not configured');
});
it('serves authentication behind Next proxy routing using the configured public host',async()=>{
 const r=await standaloneAuth(new Request('http://localhost:3000/api/auth/providers',{headers:{host:'app.example'}}));expect(r.status).toBe(200);expect(await r.json()).toHaveProperty('google');
 expect((await standaloneAuth(new Request('http://localhost:3000/api/auth/providers',{headers:{host:'evil.example'}}))).status).toBe(403);
});
