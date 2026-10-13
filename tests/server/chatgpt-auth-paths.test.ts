import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({platform:'vercel'}));
vi.mock('@avenue/runtime',()=>({get runtimePlatform(){return state.platform;}}));
vi.mock('next/headers',()=>({headers:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn()}));
import {chatGPTSignInPath,chatGPTSignOutPath} from '../../app/chatgpt-auth';

it('takes Vercel fallback sign-in directly to the branded screen with the deep link intact',()=>{
 state.platform='vercel';
 expect(chatGPTSignInPath('/clients/kind-patches?view=traffic')).toBe('/signin?callbackUrl=%2Fclients%2Fkind-patches%3Fview%3Dtraffic');
 for(const returnTo of ['/signin','/signin/','/api/auth','/api/auth/signin','//evil.example','https://evil.example'])expect(chatGPTSignInPath(returnTo)).toBe('/signin?callbackUrl=%2F');
 expect(chatGPTSignOutPath('/clients/kind-patches')).toBe('/api/auth/signout?callbackUrl=%2Fclients%2Fkind-patches');
});

it('retains the existing Sites ChatGPT sign-in route',()=>{
 state.platform='sites';
 expect(chatGPTSignInPath('/clients/kind-patches?view=traffic')).toBe('/signin-with-chatgpt?return_to=%2Fclients%2Fkind-patches%3Fview%3Dtraffic');
 expect(chatGPTSignOutPath('/')).toBe('/signout-with-chatgpt?return_to=%2F');
});
