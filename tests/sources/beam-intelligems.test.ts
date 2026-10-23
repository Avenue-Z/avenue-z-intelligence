import {describe,expect,it,vi} from 'vitest';
import type {Client} from '../../lib/analytics/contracts';
import {fetchBeamIntelligemsSource,beamIntelligemsQualification,BEAM_INTELLIGEMS_ORGANIZATION} from '../../lib/sources/beam-intelligems';
import {validateRegisteredBatch} from '../../lib/sources/registered-contract';
const client={id:'beam',timezone:'America/New_York',currency:'USD'} as Client,connection={id:'beam-intelligems',clientId:'beam'},now=new Date('2026-10-16T18:00:00Z');
const eid='7a29f923-8162-484f-be35-b5aaecbf00b5',vid='5ac024ea-27d9-4110-a65d-4b5e41345533',bid='b7966d4e-1d3b-49ec-92d5-c611fb482035';
const experiment={id:eid,name:'Menu experiment',category:'experiment',status:'started',startedAtTs:Date.parse('2026-10-14T00:00:00Z'),endedAtTs:null,organizationId:BEAM_INTELLIGEMS_ORGANIZATION};
function result(){return {datasetId:'variation_overview',latestRunTs:0,experienceId:eid,variations:[{id:vid,name:'Original',isControl:true},{id:bid,name:'New',isControl:false}],metrics:[{variation_id:vid,n_visitors:{value:100},n_orders:{value:10},net_revenue:{value:10000},conversion_rate:{value:.1,ci_low:.05,ci_high:.15,p2bb:.3}},{variation_id:bid,n_visitors:{value:100},n_orders:{value:12},conversion_rate:{value:.12,ci_low:.06,ci_high:.18,p2bb:.7,p2bc:.7,uplift:{value:.2,ci_low:-.2,ci_high:.6}}}]};}
const response=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
function fetcher(data:unknown=result(),catalog:unknown={experiencesList:[experiment],page:1,limit:20,total:1,totalPages:1}){return vi.fn().mockResolvedValueOnce(response(catalog)).mockResolvedValueOnce(response(data)) as unknown as ReturnType<typeof vi.fn>&typeof fetch;}
function read(f:typeof fetch){return fetchBeamIntelligemsSource(connection,client,{from:'2026-10-15',to:'2026-10-15'},'private-key',f,Date.now()+10000,now);}
describe('Beam Intelligems experiments',()=>{
 it('uses documented POST analysis with explicit visitor population, provider confidence and no money or causal verdict',async()=>{
  const f=fetcher(),b=await read(f);expect(b.coverageThrough).toBeNull();expect(b.rows.find(r=>r.metric==='conversion_rate_lift_ci_low')).toMatchObject({value:-.2,dimensions:{status:'started',market:'US',is_control:'false'}});expect(b.rows.some(r=>r.metric==='revenue'||r.currency!==null)).toBe(false);
  const [url,init]=f.mock.calls[1];expect(url).toBe(`https://api.intelligems.io/v25-10-beta/analytics/resource/${eid}`);expect(init.method).toBe('POST');expect(JSON.parse(init.body)).toEqual({view:'overview',startTs:'1792036800',endTs:'1792123200',analyticsViewType:'sitewide_orders',filters:{countryCodes:['US'],experimentProductsOnly:false,maxZScore:3}});
  expect(b.rows.filter(r=>r.dimensions.is_control==='true').some(r=>r.metric.includes('lift')||r.metric==='conversion_rate_probability_to_beat_control')).toBe(false);expect(validateRegisteredBatch(b,beamIntelligemsQualification(b))).toEqual(b);
 });
 it('returns an honest empty batch when no experiments exist',async()=>{const f=fetcher(undefined,{experiencesList:[],page:1,limit:20,total:0,totalPages:0}),b=await read(f);expect(b.rows).toEqual([]);expect(b.complete).toBe(true);expect(beamIntelligemsQualification(b).profiles.length).toBeGreaterThan(0);expect(f).toHaveBeenCalledTimes(1);});
 it('fully paginates the catalog and rejects duplicate experiment records',async()=>{
  const f=vi.fn().mockResolvedValueOnce(response({experiencesList:[experiment],page:1,limit:20,total:2,totalPages:2})).mockResolvedValueOnce(response({experiencesList:[experiment],page:2,limit:20,total:2,totalPages:2}));await expect(read(f)).rejects.toThrow(/identity or pagination/);expect(f.mock.calls[1][0]).toContain('page=2');
 });
 it.each(['wrong-org','incomplete-catalog','wrong-experiment','missing-variation','inverted-ci','invalid-probability'])('rejects %s',async(reason)=>{
  const data=result(),catalog={experiencesList:[{...experiment}],page:1,limit:20,total:1,totalPages:1};if(reason==='wrong-org')catalog.experiencesList[0].organizationId='other';if(reason==='incomplete-catalog')catalog.total=2;if(reason==='wrong-experiment')data.experienceId='other';if(reason==='missing-variation')data.metrics.pop();if(reason==='inverted-ci')data.metrics[1].conversion_rate.ci_low=.9;if(reason==='invalid-probability')data.metrics[1].conversion_rate.p2bc=1.1;
  await expect(read(fetcher(data,catalog))).rejects.toThrow(/Intelligems/);
 });
 it('does not fetch experiments outside the requested date',async()=>{const catalog={experiencesList:[{...experiment,startedAtTs:now.getTime()}],page:1,limit:20,total:1,totalPages:1},f=fetcher(result(),catalog);expect((await read(f)).rows).toEqual([]);expect(f).toHaveBeenCalledTimes(1);});
 it('excludes experiments paused before the requested store day',async()=>{const catalog={experiencesList:[{...experiment,status:'paused',pausedAtTs:Date.parse('2026-10-14T12:00:00Z')}],page:1,limit:20,total:1,totalPages:1},f=fetcher(result(),catalog);expect((await read(f)).rows).toEqual([]);expect(f).toHaveBeenCalledTimes(1);});
 it('sanitizes provider rejection bodies',async()=>{const f=vi.fn().mockResolvedValue(new Response('private-key secret details',{status:401}));await expect(read(f)).rejects.toThrow('Provider returned HTTP 401');});
});
