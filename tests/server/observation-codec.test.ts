import {expect,it} from 'vitest';
import {observationCodec} from '../../lib/server/observation-codec';
import type {FunnelRollupObservation} from '../../lib/analytics/funnel-rollup';
it('retains nulls, counts, intervals and provenance while giving decoded rows independent dimensions and channels',()=>{
 const row:FunnelRollupObservation={date:'2026-10-07',dataset:'funnels',metric:'sessions',value:0,definition:'shopify_human_public_landing_pages',population:'human_public_landing_page_sessions',currency:null,dimensions:{page:'/lp',market:'US'},sourceId:'hourly',retrievedAt:'2026-10-08T00:00:00Z',coverageThrough:'2026-10-08T00:00:00Z',quality:'complete',channels:['meta'],start:'2026-10-07T00:00:00Z',end:'2026-10-08T00:00:00Z',aggregation:'hourly_public_page_funnel_rollup',contributionCount:24};
 const rows=[row,{...row,value:null,numerator:0,denominator:0,contributionCount:3},{...row,date:'2026-10-06'}],decoded=observationCodec.decode(observationCodec.encode(rows));expect(decoded).toEqual(rows);
 decoded[0].dimensions.page='/changed';decoded[0].channels![0]='changed';expect(decoded[2].dimensions.page).toBe('/lp');expect(decoded[2].channels).toEqual(['meta']);
});
it('validates compact dictionaries and references without reconstructing full observations',()=>{
 const row={date:'2026-10-07',dataset:'overview',metric:'revenue',value:42,definition:'web',currency:'USD',dimensions:{},sourceId:'source',retrievedAt:'now',coverageThrough:null,quality:'complete'} as const,payload=observationCodec.encode([row]);expect(observationCodec.valid(payload)).toBe(true);
 const broken=JSON.parse(payload);broken.rows[0][0]=99;expect(observationCodec.valid(JSON.stringify(broken))).toBe(false);expect(observationCodec.valid('{"scopes":[],"dimensions":[],"timings":[],"rows":[[0,0,0,42]]}')).toBe(false);expect(observationCodec.valid('broken')).toBe(false);
});
