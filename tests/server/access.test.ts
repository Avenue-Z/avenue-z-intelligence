import { it,expect } from 'vitest';
import { authorize, checkOrigin } from '../../lib/server/policy';
const member={organizationId:'az',actorId:'u',permittedClientIds:['kind'],role:'analyst' as const};
it('rejects anonymous and unauthorized direct client requests',()=>{expect(()=>authorize(null,'kind')).toThrow('Sign in');expect(()=>authorize(member,'beam')).toThrow('Client access');expect(authorize(member,'kind').actorId).toBe('u');});
it('requires admin for configuration and team changes',()=>expect(()=>authorize(member,'kind',true)).toThrow('Administrator'));
it('rejects cross-origin mutations even with signed-in identity',()=>expect(()=>checkOrigin(new Request('https://app.example/api',{method:'POST',headers:{origin:'https://evil.example'}}))).toThrow('Origin'));
