import {expect,it,vi} from 'vitest';
import type {Store} from '../../lib/server/store';
import {qualifyAutobrushSource} from '../../lib/server/autobrush-source-qualification';
const store={first:vi.fn(),run:vi.fn()} as unknown as Store,now=new Date('2026-10-22T12:00:00Z');
it('rejects unknown providers and dates outside the retained month before any provider call',async()=>{
 const pull=vi.fn();for(const [provider,date]of [['gateway','2026-10-21'],['beam-shopify-sales','2026-10-21'],['autobrush-shopify-sales','2026-09-01'],['autobrush-shopify-sales','2026-10-23'],['autobrush-shopify-sales','2026-09-31']])await expect(qualifyAutobrushSource(store,'avenue-z',provider,date,()=>null,pull,now)).rejects.toThrow();expect(pull).not.toHaveBeenCalled();
});
it('returns only a fixed-brand contract and aggregate proof after validating a complete native batch',async()=>{
 const pull=vi.fn(async()=>({clientId:'autobrush',timezone:'America/New_York',currency:'USD',channels:[],dimensions:[],grain:'hourly',complete:true,coverageThrough:'2026-10-22T04:00:00Z',rows:[{date:'2026-10-21',dataset:'overview',metric:'revenue',value:123,definition:'shopify_net_sales_all_channels',population:'shopify_sales',currency:'USD',dimensions:{},sourceId:'autobrush-shopify-sales',retrievedAt:now.toISOString(),coverageThrough:'2026-10-22T04:00:00Z',quality:'complete',start:'2026-10-21T04:00:00Z',end:'2026-10-21T05:00:00Z'}]}));
 const result=await qualifyAutobrushSource(store,'avenue-z','autobrush-shopify-sales','2026-10-21',()=>null,pull as never,now);
 expect(result.clientId).toBe('autobrush');expect(result.contract.clientId).toBe('autobrush');expect(result.rowCount).toBe(1);expect(result.overview).toEqual({revenue:123});expect(result).not.toHaveProperty('rows');expect(result).not.toHaveProperty('accessToken');expect(store.run).not.toHaveBeenCalled();
});
