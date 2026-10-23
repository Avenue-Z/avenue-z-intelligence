import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Client,Connection,SourceBatch} from '../../lib/analytics/contracts';
import type {Store} from '../../lib/server/store';
import {readProviderCredential,saveProviderCredential} from '../../lib/server/provider-credentials';
import {fetchBeamShopifySource} from '../../lib/sources/beam-shopify';
import {fetchBeamMotionSource} from '../../lib/sources/beam-motion';
import {fetchBeamIntelligemsSource} from '../../lib/sources/beam-intelligems';
import {refreshMotionGrant} from '../../lib/sources/motion-auth';
import {BEAM_SOURCES,beamSourceDefinition} from '../../lib/sources/beam-sources';
import {beamSourceDates,fetchBeamBatches,fetchBeamSource} from '../../lib/sources/beam-fetch';
vi.mock('../../lib/server/provider-credentials',()=>({readProviderCredential:vi.fn(),saveProviderCredential:vi.fn()}));
vi.mock('../../lib/sources/beam-shopify',async importOriginal=>({...await importOriginal<typeof import('../../lib/sources/beam-shopify')>(),fetchBeamShopifySource:vi.fn()}));
vi.mock('../../lib/sources/beam-motion',async importOriginal=>({...await importOriginal<typeof import('../../lib/sources/beam-motion')>(),fetchBeamMotionSource:vi.fn()}));
vi.mock('../../lib/sources/beam-intelligems',async importOriginal=>({...await importOriginal<typeof import('../../lib/sources/beam-intelligems')>(),fetchBeamIntelligemsSource:vi.fn()}));
vi.mock('../../lib/sources/motion-auth',async importOriginal=>({...await importOriginal<typeof import('../../lib/sources/motion-auth')>(),refreshMotionGrant:vi.fn()}));
const client={id:'beam',timezone:'America/New_York',currency:'USD'} as Client;
const store={first:vi.fn(),run:vi.fn()} as unknown as Pick<Store,'first'|'run'>;
const window={from:'2026-10-15',to:'2026-10-15'},now=new Date('2026-10-16T18:00:00Z');
const app={storeDomain:'beamtlc.myshopify.com',clientId:'beam-app',clientSecret:'dummy-client-secret'};
const shopifyGrant={storeDomain:app.storeDomain,appClientId:app.clientId,accessToken:'dummy-shopify-token',scopes:['read_reports','read_orders','read_products'],authorizedAt:'2026-10-15T00:00:00Z'};
const motionGrant={appClientId:'motion-app',accessToken:'dummy-motion-token',refreshToken:'dummy-motion-refresh',expiresAt:now.getTime()+120000,tokenType:'Bearer' as const,scopes:['offline_access'],authorizedAt:'2026-10-15T00:00:00Z'};
const secrets=(key:string)=>({AUTH_SECRET:'x'.repeat(32),SOURCE_BEAM_SHOPIFY:JSON.stringify(app),SOURCE_BEAM_MOTION:JSON.stringify({clientId:'motion-app'}),SOURCE_BEAM_INTELLIGEMS:'dummy-experiment-key'}[key]??null);
const connection=(provider:string)=>({...beamSourceDefinition(provider,'beam'),id:provider,clientId:'beam'}) as Connection;
const batch={clientId:'beam'} as SourceBatch;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(fetchBeamShopifySource).mockResolvedValue(batch);vi.mocked(fetchBeamMotionSource).mockResolvedValue(batch);vi.mocked(fetchBeamIntelligemsSource).mockResolvedValue(batch);});
describe('Beam credential dispatch',()=>{
 it('loads the Beam Shopify grant from the organization-scoped vault and passes only its token',async()=>{
  vi.mocked(readProviderCredential).mockResolvedValue(shopifyGrant);
  await expect(fetchBeamSource(connection('beam-shopify-sales'),client,window,store,'avenue-z',secrets,fetch,Date.now()+30000,now)).resolves.toBe(batch);
  expect(readProviderCredential).toHaveBeenCalledWith(store,{organizationId:'avenue-z',clientId:'beam',provider:'shopify'},'x'.repeat(32));
  expect(fetchBeamShopifySource).toHaveBeenCalledWith(expect.anything(),client,window,shopifyGrant.accessToken,fetch,expect.any(Number),now);
 });
 it('rejects foreign app grants, endpoints and secret references before provider execution',async()=>{
  vi.mocked(readProviderCredential).mockResolvedValue({...shopifyGrant,appClientId:'another-app'});
  await expect(fetchBeamSource(connection('beam-shopify-sales'),client,window,store,'avenue-z',secrets,fetch,Date.now()+30000,now)).rejects.toThrow(/authorized/i);
  for(const c of [{...connection('beam-shopify-sales'),endpoint:'https://example.com'},{...connection('beam-shopify-sales'),secretRef:'SOURCE_KIND'}])await expect(fetchBeamSource(c,client,window,store,'avenue-z',secrets,fetch,Date.now()+30000,now)).rejects.toThrow(/fixed/i);
  expect(fetchBeamShopifySource).not.toHaveBeenCalled();
 });
 it('refreshes an expiring Motion grant and stores the rotation before reading reports',async()=>{
  vi.mocked(readProviderCredential).mockResolvedValue({...motionGrant,expiresAt:now.getTime()+1000});
  vi.mocked(refreshMotionGrant).mockResolvedValue({...motionGrant,accessToken:'rotated-token',refreshToken:'rotated-refresh',expiresAt:now.getTime()+3600000});
  await fetchBeamSource(connection('beam-motion'),client,window,store,'avenue-z',secrets,fetch,Date.now()+30000,now);
  expect(refreshMotionGrant).toHaveBeenCalledTimes(1);
  expect(saveProviderCredential).toHaveBeenCalledWith(store,{organizationId:'avenue-z',clientId:'beam',provider:'motion'},expect.objectContaining({accessToken:'rotated-token',appClientId:'motion-app',authorizedAt:motionGrant.authorizedAt}),'x'.repeat(32));
  expect(fetchBeamMotionSource).toHaveBeenCalledWith(expect.objectContaining({id:'beam-motion'}),client,window,'rotated-token',expect.any(Function),expect.any(Number),now);
 });
 it('reads raw and JSON Intelligems keys without consulting OAuth credentials',async()=>{
  for(const key of ['dummy-experiment-key',JSON.stringify({apiKey:'dummy-experiment-key'})])await fetchBeamSource(connection('beam-intelligems'),client,window,store,'avenue-z',name=>name==='SOURCE_BEAM_INTELLIGEMS'?key:secrets(name),fetch,Date.now()+30000,now);
  expect(fetchBeamIntelligemsSource).toHaveBeenCalledTimes(2);expect(readProviderCredential).not.toHaveBeenCalled();
 });
 it('captures the previous real day at Shopify midnight and rejects multi-day batches',async()=>{
  vi.mocked(readProviderCredential).mockResolvedValue(shopifyGrant);
  await fetchBeamSource(connection('beam-shopify-sales'),client,{from:'2026-10-16',to:'2026-10-16'},store,'avenue-z',secrets,fetch,Date.now()+30000,new Date('2026-10-16T04:30:00Z'));
  expect(fetchBeamShopifySource).toHaveBeenCalledWith(expect.anything(),client,window,shopifyGrant.accessToken,fetch,expect.any(Number),expect.any(Date));
  await expect(fetchBeamSource(connection('beam-shopify-sales'),client,{from:'2026-10-14',to:'2026-10-16'},store,'avenue-z',secrets)).rejects.toThrow(/one store day/i);
  expect(BEAM_SOURCES).toHaveLength(7);
 });
 it('captures every explicitly requested date in newest-first single-day chunks',async()=>{
  vi.mocked(readProviderCredential).mockResolvedValue(shopifyGrant);
  const batches=[];
  for await(const result of fetchBeamBatches(connection('beam-shopify-sales'),client,{from:'2026-10-13',to:'2026-10-15'},store,'avenue-z',secrets,fetch,Date.now()+30000,now))batches.push(result);
  expect(batches.map(result=>result.window.to)).toEqual(['2026-10-15','2026-10-14','2026-10-13']);
  expect(fetchBeamShopifySource).toHaveBeenCalledTimes(3);
  expect(beamSourceDates(connection('beam-shopify-sales'),client,{from:'2026-10-15',to:'2026-10-16'},new Date('2026-10-16T04:30:00Z'))).toEqual(['2026-10-15']);
  expect(beamSourceDates(connection('beam-motion'),client,{from:'2026-10-15',to:'2026-10-16'},new Date('2026-10-16T04:30:00Z'))).toEqual(['2026-10-16','2026-10-15']);
 });
});
