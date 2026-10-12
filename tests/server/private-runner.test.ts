import {it,expect,vi,beforeEach} from 'vitest';
const state=vi.hoisted(()=>({secret:vi.fn(),scope:vi.fn(),identity:vi.fn()}));
vi.mock('@avenue/runtime',()=>({runtimePlatform:'sites'}));
vi.mock('../../lib/server/secrets',()=>({serverSecret:state.secret}));
vi.mock('../../app/chatgpt-auth',()=>({getChatGPTUser:state.identity}));
vi.mock('../../lib/server/access',()=>({scopeForUser:state.scope}));
import {privateRunnerScope} from '../../lib/server/private-runner';
beforeEach(()=>{state.secret.mockReturnValue('true');state.scope.mockResolvedValue(null);state.identity.mockResolvedValue(null);});
it('requires an explicit private-site service switch',async()=>{state.secret.mockReturnValue(null);await expect(privateRunnerScope()).rejects.toThrow('disabled');});
it('limits unattended writes to Kind Patches in the shared workspace',async()=>{expect(await privateRunnerScope()).toMatchObject({organizationId:'avenue-z',permittedClientIds:['kind-patches']});});
it('does not elevate a signed-in analyst or an admin assigned to another client',async()=>{state.scope.mockResolvedValue({role:'analyst',permittedClientIds:['kind-patches']});await expect(privateRunnerScope()).rejects.toThrow('Administrator');state.scope.mockResolvedValue({role:'admin',permittedClientIds:['beam']});await expect(privateRunnerScope()).rejects.toThrow('Administrator');});

it('rejects a signed-in visitor without workspace membership',async()=>{state.identity.mockResolvedValue({userId:'unassigned'});await expect(privateRunnerScope()).rejects.toThrow('membership');});
