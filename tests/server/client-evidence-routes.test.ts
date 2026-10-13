import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({scope:{organizationId:'avenue-z',actorId:'analyst',role:'analyst',permittedClientIds:['kind-patches']},access:vi.fn(),evidence:vi.fn(),export:vi.fn(),store:vi.fn()}));
vi.mock('@avenue/runtime',()=>({env:{},runtimePlatform:'sites'}));
vi.mock('../../lib/server/access',()=>({requireClientAccess:state.access,getStore:state.store}));
vi.mock('../../lib/server/company-workspace-bridge',()=>({bridgedWorkspace:vi.fn(),bridgedClientEvidence:state.evidence,bridgedClientExport:state.export,publicCompanyWorkspaceSizeError:'This selection has too much detail. Choose a shorter period or a specific landing page.'}));
beforeEach(()=>{vi.clearAllMocks();state.access.mockResolvedValue(state.scope);state.store.mockImplementation(()=>{throw Error('Heavy local read forbidden');});state.evidence.mockResolvedValue({rows:[{date:'2026-10-11',metric:'sessions',value:120}]});state.export.mockResolvedValue({csv:'date,value\r\n2026-10-11,120'});});
it('serves exact client evidence through the native bridge without reading observations in Sites',async()=>{
 const {GET}=await import('../../app/api/clients/[clientId]/evidence/route');
 const response=await GET(new Request('https://preview.example/api/clients/kind-patches/evidence?from=2026-10-11&to=2026-10-11&view=traffic&segment=%5B%5B%22source%22%2C%22Meta%22%5D%5D'),{params:Promise.resolve({clientId:'kind-patches'})});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({rows:[{date:'2026-10-11',metric:'sessions',value:120}]});expect(state.store).not.toHaveBeenCalled();expect(state.evidence.mock.calls[0]?.[1]).toBe('kind-patches');
});
it('returns bridged CSV using the existing attachment contract without local observations',async()=>{
 const {GET}=await import('../../app/api/clients/[clientId]/export/route');
 const response=await GET(new Request('https://preview.example/api/clients/kind-patches/export?from=2026-10-11&to=2026-10-11&view=traffic'),{params:Promise.resolve({clientId:'kind-patches'})});
 expect(response.status).toBe(200);expect(await response.text()).toBe('date,value\r\n2026-10-11,120');expect(response.headers.get('content-type')).toBe('text/csv;charset=utf-8');expect(response.headers.get('content-disposition')).toContain('analytics.csv');expect(state.store).not.toHaveBeenCalled();
});
it('checks the current user before contacting the native endpoint',async()=>{
 state.access.mockRejectedValue(Error('Client access denied'));
 const {GET}=await import('../../app/api/clients/[clientId]/export/route');const response=await GET(new Request('https://preview.example/api/clients/kind-patches/export'),{params:Promise.resolve({clientId:'kind-patches'})});
 expect(response.status).toBe(403);expect(state.export).not.toHaveBeenCalled();
});
it('rejects invalid date ranges and evidence segments before sending a bridge request',async()=>{
 const {GET}=await import('../../app/api/clients/[clientId]/evidence/route');
 for(const suffix of ['from=2026-07-01&to=2026-10-11&segment=%5B%5D','from=2026-10-11&to=2026-10-11'])expect((await GET(new Request('https://preview.example/api/clients/kind-patches/evidence?'+suffix),{params:Promise.resolve({clientId:'kind-patches'})})).status).toBe(400);
 expect(state.evidence).not.toHaveBeenCalled();
});
it('returns a safe size error rather than silently truncating a native export',async()=>{
 state.export.mockRejectedValue(Error('This selection has too much detail. Choose a shorter period or a specific landing page.'));
 const {GET}=await import('../../app/api/clients/[clientId]/export/route');const response=await GET(new Request('https://preview.example/api/clients/kind-patches/export?from=2026-10-11&to=2026-10-11'),{params:Promise.resolve({clientId:'kind-patches'})});expect(response.status).toBe(413);expect(await response.json()).toEqual({error:'This selection has too much detail. Choose a shorter period or a specific landing page.'});
});
