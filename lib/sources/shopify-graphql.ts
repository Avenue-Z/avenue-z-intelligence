import {providerJson} from './kind-patches';

const cooldowns=new Map<string,number>();
function hold(domain:string,until:number){cooldowns.set(domain,Math.max(cooldowns.get(domain)??0,until));}
export class ShopifyRateLimitError extends Error{
 constructor(public readonly retryAfterMs:number){super('Shopify analytics rate limited; retry after its cooldown');this.name='ShopifyRateLimitError';}
}
function resetDelay(result:any,attempt:number){
 const reset=Date.parse(result?.extensions?.shopifyqlCost?.windowResetAt??''),remaining=reset-Date.now();
 if(Number.isFinite(remaining)&&remaining>0)return remaining+250;
 const cost=result?.extensions?.cost,needed=Number(cost?.requestedQueryCost)-Number(cost?.throttleStatus?.currentlyAvailable),rate=Number(cost?.throttleStatus?.restoreRate);
 if(Number.isFinite(needed)&&needed>0&&Number.isFinite(rate)&&rate>0)return Math.max(1000,Math.ceil(needed/rate*1000)+250);
 return 2000*2**attempt;
}
async function waitForBudget(delay:number,deadline:number){
 if(delay>60000||Date.now()+delay+1000>=deadline)throw new ShopifyRateLimitError(delay);
 await new Promise(resolve=>setTimeout(resolve,delay));
}

/** ShopifyQL has its own window budget in addition to the Admin GraphQL
 * bucket. Retry only recognized throttles; never hide schema/access failures. */
export async function fetchShopifyGraphQL(config:{SHOP_DOMAIN:string;SHOPIFY_ADMIN_TOKEN:string},query:string,fetcher:typeof fetch,deadline:number,responseLimit:6000000|16000000=6000000){
 const analytics=query.includes('shopifyqlQuery');
 for(let attempt=0;attempt<3;attempt++){
  while(analytics){
   const held=cooldowns.get(config.SHOP_DOMAIN)??0;
   if(held<=Date.now())break;
   await waitForBudget(held-Date.now(),deadline);
  }
  let result:any;
  try{result=await providerJson(fetcher,`https://${config.SHOP_DOMAIN}/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':config.SHOPIFY_ADMIN_TOKEN},body:JSON.stringify({query})},deadline,0,25000,responseLimit);}
  catch(error){
   if(!(error instanceof Error)||!['Provider rate limited; retry after its cooldown','Provider returned HTTP 429'].includes(error.message))throw error;
   // HTTP 429 reached the transport's bounded retries. Its response body has
   // no trusted reset metadata here, so defer this bucket for one minute.
   const delay=60000;if(analytics)hold(config.SHOP_DOMAIN,Date.now()+delay);
   if(attempt===2)throw new ShopifyRateLimitError(delay);await waitForBudget(delay,deadline);continue;
  }
  if(result.errors?.length){
   const codes=result.errors.map((error:any)=>error?.extensions?.code);
   if(codes.every((code:unknown)=>code==='THROTTLED')){
    const delay=resetDelay(result,attempt);if(analytics)hold(config.SHOP_DOMAIN,Date.now()+delay);
    console.warn('Shopify budget throttled',{operation:analytics?'shopifyql':'graphql',code:'THROTTLED',retryAfterMs:delay,attempt:attempt+1});
    if(attempt===2)throw new ShopifyRateLimitError(delay);await waitForBudget(delay,deadline);continue;
   }
   const code=codes.find((value:unknown)=>typeof value==='string'&&/^[A-Z0-9_]{1,40}$/.test(value));
   throw Error(`Shopify GraphQL request rejected${code?` (${code})`:''}`);
  }
  const budget=result.extensions?.shopifyqlCost,reset=Date.parse(budget?.windowResetAt??'');
  if(analytics&&budget?.currentlyAvailable===0&&Number.isFinite(reset)&&reset>Date.now())hold(config.SHOP_DOMAIN,reset+250);
  else if(analytics&&(cooldowns.get(config.SHOP_DOMAIN)??0)<=Date.now())cooldowns.delete(config.SHOP_DOMAIN);
  return result.data;
 }
 throw new ShopifyRateLimitError(60000);
}
