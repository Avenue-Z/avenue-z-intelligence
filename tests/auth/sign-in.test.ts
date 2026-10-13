import {afterEach,expect,it,vi} from 'vitest';
import {googleSignInError,requestGoogleSignIn,sanitizeSignInCallback} from '../../lib/auth/sign-in';

afterEach(()=>vi.restoreAllMocks());

it('retains a dashboard deep link and rejects external or looping callback destinations',()=>{
 expect(sanitizeSignInCallback('/clients/kind-patches?view=traffic&from=2026-10-13')).toBe('/clients/kind-patches?view=traffic&from=2026-10-13');
 expect(sanitizeSignInCallback('https://app.example/clients/kind-patches?view=traffic','https://app.example')).toBe('/clients/kind-patches?view=traffic');
 for(const value of ['https://evil.example','//evil.example','/\\evil.example','/signin','/signin/','/api/auth','/api/auth/signin?callbackUrl=/signin','/signin-with-chatgpt','/callback'])expect(sanitizeSignInCallback(value,'https://app.example')).toBe('/clients/kind-patches');
});

it('requests a CSRF token and posts directly to Google with the callback intact',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({csrfToken:'verified-token'})).mockResolvedValueOnce(Response.json({url:'https://accounts.google.com/o/oauth2/v2/auth?state=valid-state'}));
 expect(await requestGoogleSignIn('/clients/kind-patches?view=traffic','https://app.example',fetcher)).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=valid-state');
 expect(fetcher.mock.calls[0][0]).toBe('/api/auth/csrf');
 expect(fetcher.mock.calls[1][0]).toBe('/api/auth/signin/google');
 const options=fetcher.mock.calls[1][1];
 expect(options.method).toBe('POST');expect(options.credentials).toBe('same-origin');expect(options.headers['X-Auth-Return-Redirect']).toBe('1');
 expect(new URLSearchParams(options.body).get('csrfToken')).toBe('verified-token');expect(new URLSearchParams(options.body).get('callbackUrl')).toBe('/clients/kind-patches?view=traffic');
});

it('does not redirect to an untrusted URL and surfaces company account errors safely',async()=>{
 for(const url of ['https://accounts.google.com.evil.example/o/oauth2/v2/auth','https://evil.example','javascript:alert(1)','https://accounts.google.com:444/o/oauth2/v2/auth']){
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({csrfToken:'token'})).mockResolvedValueOnce(Response.json({url}));
  await expect(requestGoogleSignIn('/','https://app.example',fetcher)).rejects.toThrow('Google sign-in could not start');
 }
 const denied=vi.fn().mockResolvedValueOnce(Response.json({csrfToken:'token'})).mockResolvedValueOnce(Response.json({url:'https://app.example/signin?error=AccessDenied'}));
 await expect(requestGoogleSignIn('/','https://app.example',denied)).rejects.toThrow('@avenuez.com');
 expect(googleSignInError('untrusted-secret-output')).toBe('Sign-in could not be completed. Please try again.');
});

it('fails without posting when CSRF setup is unavailable',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'Unavailable'},{status:503}));
 await expect(requestGoogleSignIn('/','https://app.example',fetcher)).rejects.toThrow('Google sign-in could not start');expect(fetcher).toHaveBeenCalledTimes(1);
});
