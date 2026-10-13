import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {fetchShopifyGraphQL,ShopifyRateLimitError} from '../../lib/sources/shopify-graphql';

let count=0;
const config=()=>({SHOP_DOMAIN:`throttle-test-${++count}.myshopify.com`,SHOPIFY_ADMIN_TOKEN:'private-test-token'});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const query='query { shopifyqlQuery(query: "FROM sales SHOW orders") { tableData { rows } parseErrors } }';
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime('2026-10-13T19:10:00Z');});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

it('waits for the independent ShopifyQL reset and recovers the same request without replacing its data',async()=>{
 const calls:number[]=[],fetcher=vi.fn(async()=>{calls.push(Date.now());return calls.length===1?response({errors:[{message:'Throttled',extensions:{code:'THROTTLED'}}],extensions:{shopifyqlCost:{requestedQueryCost:7,maximumAvailable:1000,currentlyAvailable:0,windowResetAt:'2026-10-13T19:10:30Z'}}}):response({data:{shopifyqlQuery:{tableData:{rows:[{orders:42}]},parseErrors:[]}}});});
 const result=fetchShopifyGraphQL(config(),query,fetcher,Date.now()+90000);await vi.advanceTimersByTimeAsync(29999);expect(calls).toHaveLength(1);await vi.advanceTimersByTimeAsync(1001);expect(await result).toEqual({shopifyqlQuery:{tableData:{rows:[{orders:42}]},parseErrors:[]}});expect(calls[1]-calls[0]).toBeGreaterThanOrEqual(30000);
});
it('keeps expired reset timestamps bounded and reports typed throttling when repeated attempts cannot recover',async()=>{
 const fetcher=vi.fn(async()=>response({errors:[{extensions:{code:'THROTTLED'}}],extensions:{shopifyqlCost:{currentlyAvailable:0,windowResetAt:'2026-10-13T19:09:59Z'}}}));
 const pending=fetchShopifyGraphQL(config(),query,fetcher,Date.now()+90000);const outcome=pending.catch(error=>error);await vi.runAllTimersAsync();expect(await outcome).toBeInstanceOf(ShopifyRateLimitError);expect(fetcher).toHaveBeenCalledTimes(3);
});
it('does not exceed the source deadline or retry another date when the documented reset will not fit',async()=>{
 const fetcher=vi.fn(async()=>response({errors:[{extensions:{code:'THROTTLED'}}],extensions:{shopifyqlCost:{currentlyAvailable:0,windowResetAt:'2026-10-13T19:11:00Z'}}}));
 await expect(fetchShopifyGraphQL(config(),query,fetcher,Date.now()+10000)).rejects.toBeInstanceOf(ShopifyRateLimitError);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('preserves server failures and permanent GraphQL errors instead of treating them as throttle retries',async()=>{
 const http=vi.fn(async()=>response({error:'private provider detail'},500));await expect(fetchShopifyGraphQL(config(),query,http,Date.now()+90000)).rejects.toThrow('Provider returned HTTP 500');expect(http).toHaveBeenCalledTimes(1);
 const access=vi.fn(async()=>response({errors:[{message:'secret account detail',extensions:{code:'ACCESS_DENIED'}}]}));await expect(fetchShopifyGraphQL(config(),query,access,Date.now()+90000)).rejects.toThrow('Shopify GraphQL request rejected (ACCESS_DENIED)');expect(access).toHaveBeenCalledTimes(1);
});
it('shares a known ShopifyQL cooldown across query callers for the same store without delaying identity reads',async()=>{
 const c=config(),fetcher=vi.fn(async()=>response({errors:[{extensions:{code:'THROTTLED'}}],extensions:{shopifyqlCost:{currentlyAvailable:0,windowResetAt:'2026-10-13T19:11:00Z'}}}));
 await expect(fetchShopifyGraphQL(c,query,fetcher,Date.now()+1000)).rejects.toBeInstanceOf(ShopifyRateLimitError);
 const identity=vi.fn(async()=>response({data:{shop:{currencyCode:'USD'}}}));expect(await fetchShopifyGraphQL(c,'query { shop { currencyCode } }',identity,Date.now()+10000)).toEqual({shop:{currencyCode:'USD'}});
 const second=vi.fn(async()=>response({data:{shopifyqlQuery:{tableData:{rows:[]},parseErrors:[]}}}));await expect(fetchShopifyGraphQL(c,query,second,Date.now()+10000)).rejects.toBeInstanceOf(ShopifyRateLimitError);expect(second).not.toHaveBeenCalled();
});
it('recovers a terminal short-Retry-After HTTP 429 as typed budget pressure after transport retries',async()=>{
 let attempts=0;const fetcher=vi.fn(async()=>++attempts<=3?new Response(JSON.stringify({errors:[{extensions:{code:'THROTTLED'}}]}),{status:429,headers:{'Content-Type':'application/json','Retry-After':'0'}}):response({data:{shopifyqlQuery:{tableData:{rows:[{orders:42}]},parseErrors:[]}}}));
 const pending=fetchShopifyGraphQL(config(),query,fetcher,Date.now()+90000),outcome=pending.catch(error=>error);await vi.runAllTimersAsync();expect(await outcome).toEqual({shopifyqlQuery:{tableData:{rows:[{orders:42}]},parseErrors:[]}});expect(fetcher).toHaveBeenCalledTimes(4);
});
it('keeps a longer known reset when an older in-flight request reports a shorter fallback throttle',async()=>{
 const c=config();let release!:(value:Response)=>void;const slow=fetchShopifyGraphQL(c,query,async()=>new Promise<Response>(resolve=>{release=resolve;}),Date.now()+1000).catch(error=>error);
 await Promise.resolve();await expect(fetchShopifyGraphQL(c,query,async()=>response({errors:[{extensions:{code:'THROTTLED'}}],extensions:{shopifyqlCost:{currentlyAvailable:0,windowResetAt:'2026-10-13T19:10:30Z'}}}),Date.now()+1000)).rejects.toBeInstanceOf(ShopifyRateLimitError);
 release(response({errors:[{extensions:{code:'THROTTLED'}}]}));expect(await slow).toBeInstanceOf(ShopifyRateLimitError);
 const next=vi.fn(async()=>response({data:{rows:[]}})),result=fetchShopifyGraphQL(c,query,next,Date.now()+10000).catch(error=>error);await vi.runAllTimersAsync();expect(await result).toBeInstanceOf(ShopifyRateLimitError);expect(next).not.toHaveBeenCalled();
});
it('does not let an older in-flight success clear a still-future fallback cooldown',async()=>{
 const c=config();let release!:(value:Response)=>void;const slow=fetchShopifyGraphQL(c,query,async()=>new Promise<Response>(resolve=>{release=resolve;}),Date.now()+1000);
 await Promise.resolve();await expect(fetchShopifyGraphQL(c,query,async()=>response({errors:[{extensions:{code:'THROTTLED'}}]}),Date.now()+1000)).rejects.toBeInstanceOf(ShopifyRateLimitError);
 release(response({data:{rows:[]},extensions:{shopifyqlCost:{currentlyAvailable:900,windowResetAt:'2026-10-13T19:11:00Z'}}}));await slow;
 const next=vi.fn(async()=>response({data:{rows:[]}}));await expect(fetchShopifyGraphQL(c,query,next,Date.now()+1000)).rejects.toBeInstanceOf(ShopifyRateLimitError);expect(next).not.toHaveBeenCalled();
});
it('rechecks a longer reset learned while another caller is already sleeping',async()=>{
 const c=config();let release!:(value:Response)=>void;
 const older=fetchShopifyGraphQL(c,query,async()=>new Promise<Response>(resolve=>{release=resolve;}),Date.now()+10000).catch(error=>error);
 await Promise.resolve();
 const calls:number[]=[],fetcher=vi.fn(async()=>{calls.push(Date.now());return calls.length===1?response({errors:[{extensions:{code:'THROTTLED'}}],extensions:{shopifyqlCost:{currentlyAvailable:0,windowResetAt:'2026-10-13T19:10:30Z'}}}):response({data:{rows:[{orders:42}]}});});
 const waiting=fetchShopifyGraphQL(c,query,fetcher,Date.now()+90000);
 await vi.advanceTimersByTimeAsync(5000);
 release(response({errors:[{extensions:{code:'THROTTLED'}}],extensions:{shopifyqlCost:{currentlyAvailable:0,windowResetAt:'2026-10-13T19:11:00Z'}}}));
 expect(await older).toBeInstanceOf(ShopifyRateLimitError);
 await vi.advanceTimersByTimeAsync(26000);expect(fetcher).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(29250);expect(await waiting).toEqual({rows:[{orders:42}]});expect(calls[1]-calls[0]).toBeGreaterThanOrEqual(60250);
});
