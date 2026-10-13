import type {Client,Observation,SourceBatch} from '../analytics/contracts';
import {dayWindow} from '../analytics/windows';
import {boundedRows,checkDate,hourlySessionCutoff,localHourInterval,numeric,observation,reconcile,sourceBatch,type KindWindow,type Raw} from './kind-patches';

export type ShopifyCommerceKind='sales'|'products';
export type ShopifyQLRunner=(query:string)=>Promise<Raw[]>;
export type ShopifyCumulativeOrders={beforeHour:number;rows:Raw[]}[];
const fields={net_sales:'revenue',gross_sales:'gross',discounts:'discounts',returns:'refunds',orders:'orders'} as const;
const specs={
 sales:{dataset:'revenue',definition:'shopify_net_sales_all_channels',population:'shopify_sales',dimensions:['sales_channel']},
 products:{dataset:'products',definition:'shopify_product_net_sales_orders_may_overlap',population:'shopify_product_sales',dimensions:['product_title_at_time_of_sale','sales_channel']}
} as const;

/** Each request is one complete store day, keeping both provider and observation
 * limits explicit. The independent daily query uses the identical completed-hour
 * predicate, so delayed adjustments cannot quietly publish an inconsistent cut. */
export function shopifyHourlyCommerceQueries(kind:ShopifyCommerceKind,w:KindWindow,timezone:string,now=new Date()){
 if(w.from!==w.to)throw new Error('Hourly Shopify commerce requires one store day per batch');
 const cutoff=hourlySessionCutoff(timezone,now),date=w.to;
 checkDate(date,w);dayWindow(date,timezone);
 if(date>cutoff.date)throw new Error('Hourly Shopify commerce extends beyond the current store day');
 if(date===cutoff.date&&!cutoff.hour)throw new Error('The first complete store hour is not available yet');
 const where=date===cutoff.date?` WHERE hour_of_day < ${cutoff.hour}`:'',show=Object.keys(fields).join(','),dimensions=specs[kind].dimensions.join(','),suffix=`SINCE ${date} UNTIL ${date} ORDER BY day ASC LIMIT 10000`;
 return {
  hourly:`FROM sales SHOW ${show}${where} GROUP BY day,hour_of_day,${dimensions} ${suffix}`,
  daily:`FROM sales SHOW ${show}${where} GROUP BY day,${dimensions} ${suffix}`
 };
}

function dimensions(kind:ShopifyCommerceKind,row:Raw):Record<string,string>{return kind==='sales'?{stream:String(row.sales_channel??'Unknown')}:{product:String(row.product_title_at_time_of_sale??'Unknown'),stream:String(row.sales_channel??'Unknown')};}
function groupKey(kind:ShopifyCommerceKind,row:Raw){return JSON.stringify([row.day,Object.entries(dimensions(kind,row)).sort()]);}
function values(row:Raw){const result=Object.fromEntries(Object.keys(fields).map(field=>[field,numeric(row[field])]));if(!Number.isSafeInteger(result.orders)||result.orders<0)throw new Error('Invalid Shopify order count');return result;}

export function shopifyCumulativeOrderQuery(kind:ShopifyCommerceKind,date:string,beforeHour:number){
 checkDate(date,{from:date,to:date});
 if(!Number.isInteger(beforeHour)||beforeHour<1||beforeHour>24)throw new Error('Invalid cumulative Shopify order boundary');
 return `FROM sales SHOW orders WHERE hour_of_day < ${beforeHour} GROUP BY day,${specs[kind].dimensions.join(',')} SINCE ${date} UNTIL ${date} ORDER BY day ASC LIMIT 10000`;
}

export function normalizeShopifyHourlyCommerce(kind:ShopifyCommerceKind,input:{hourly:Raw[];daily:Raw[];cumulativeOrders?:ShopifyCumulativeOrders},client:Client,w:KindWindow,now=new Date()):SourceBatch{
 shopifyHourlyCommerceQueries(kind,w,client.timezone,now);
 if(input.hourly.length>=10000||input.daily.length>=10000)throw new Error('Hourly Shopify commerce export is incomplete or exceeds its row limit');
 boundedRows(input.hourly);boundedRows(input.daily);
 const spec=specs[kind],cutoff=hourlySessionCutoff(client.timezone,now),date=w.to,limit=date===cutoff.date?cutoff.hour:24,through=date===cutoff.date?cutoff.through:dayWindow(date,client.timezone).end;
 const groups=new Map<string,{row:Raw;totals:Record<string,number>}>(),hours=new Map<string,Record<string,number>>();
 for(const row of input.daily){checkDate(row.day,w);const key=groupKey(kind,row);if(groups.has(key))throw new Error('Duplicate independent Shopify commerce aggregate');groups.set(key,{row,totals:values(row)});}
 for(const row of input.hourly){
  checkDate(row.day,w);const hour=numeric(row.hour_of_day);if(!Number.isInteger(hour)||hour<0||hour>23)throw new Error('Invalid Shopify commerce hour');
  const interval=localHourInterval(row.day,hour,client.timezone);if(!interval)throw new Error('Shopify commerce contains a skipped local hour');if(hour>=limit||Date.parse(interval.end)>Date.parse(through))throw new Error('Shopify commerce extends beyond the last complete store hour');
  const key=groupKey(kind,row),hourKey=JSON.stringify([key,hour]);if(!groups.has(key))throw new Error('Independent Shopify commerce aggregate is missing a group');if(hours.has(hourKey))throw new Error('Duplicate hourly Shopify commerce aggregate');hours.set(hourKey,values(row));
 }
 if(!groups.size)throw new Error('Independent Shopify commerce aggregate contains no groups');
 const repairedOrders=new Map<string,number[]>();
 if(input.cumulativeOrders){
  if(input.cumulativeOrders.length!==limit-1)throw new Error('Incomplete independent cumulative Shopify order cuts');
  const boundaries=new Map<number,Map<string,number>>();
  for(const cut of input.cumulativeOrders){
   if(!Number.isInteger(cut.beforeHour)||cut.beforeHour<1||cut.beforeHour>=limit||boundaries.has(cut.beforeHour))throw new Error('Invalid or duplicate cumulative Shopify order boundary');
   if(cut.rows.length>=10000)throw new Error('Cumulative Shopify order export exceeds its row limit');
   const counts=new Map<string,number>();for(const row of boundedRows(cut.rows)){
    checkDate(row.day,w);const key=groupKey(kind,row),count=numeric(row.orders);if(!Number.isSafeInteger(count)||count<0)throw new Error('Invalid cumulative Shopify order count');if(counts.has(key))throw new Error('Duplicate cumulative Shopify order group');
    if(!groups.has(key)&&count)throw new Error('Cumulative Shopify orders do not reconcile with the independent daily group');counts.set(key,count);
   }
   boundaries.set(cut.beforeHour,counts);
  }
  for(const [key,group] of groups){const increments:number[]=[];let previous=0;
   for(let hour=0;hour<limit;hour++){const count=hour===limit-1?group.totals.orders:boundaries.get(hour+1)?.get(key)??0;if(count<previous)throw new Error('Cumulative Shopify orders do not reconcile monotonically');increments.push(count-previous);previous=count;}
   repairedOrders.set(key,increments);
  }
 }
 for(const [key,group] of groups)for(const field of Object.keys(fields)){
  let total=0;for(let hour=0;hour<limit;hour++)total+=hours.get(JSON.stringify([key,hour]))?.[field]??0;
  if(field==='orders'&&repairedOrders.has(key))continue;
  if(field==='orders'&&group.totals[field]!==total)throw new Error('Hourly Shopify orders do not reconcile with independent daily totals; unique cumulative order cuts required');
  reconcile(group.totals[field],total);
 }
 const rows:Observation[]=[];
 for(const [key,group] of groups)for(let hour=0;hour<limit;hour++){
  const interval=localHourInterval(date,hour,client.timezone);if(!interval)continue;
  const measures=hours.get(JSON.stringify([key,hour]));
  // Zeros are supported by a complete independently reconciled group, never by
  // a missing provider query or a partial/truncated response.
  for(const [field,metric] of Object.entries(fields)){
   const value=(field==='orders'&&repairedOrders.has(key)?repairedOrders.get(key)![hour]:measures?.[field]??0)*(metric==='discounts'||metric==='refunds'?-1:1);
   rows.push(observation(date,spec.dataset,metric,value,spec.definition,spec.population,metric==='orders'?null:client.currency,dimensions(kind,group.row),interval));
  }
 }
 if(rows.length>50000)throw new Error('Hourly Shopify commerce exceeds the observation limit');
 return {...sourceBatch(client,rows,through,[],'hourly'),dimensions:kind==='sales'?['stream']:['product','stream']};
}

export async function fetchShopifyHourlyCommerce(kind:ShopifyCommerceKind,client:Client,w:KindWindow,run:ShopifyQLRunner,now=new Date()){
 const queries=shopifyHourlyCommerceQueries(kind,w,client.timezone,now),hourly=await run(queries.hourly),daily=await run(queries.daily);
 try{return normalizeShopifyHourlyCommerce(kind,{hourly,daily},client,w,now);}catch(error){
  if(!(error instanceof Error)||!error.message.includes('unique cumulative order cuts required'))throw error;
 }
 // Shopify's orders metric is distinct inside the queried period. An order with
 // sale events in two hours appears in both hourly groups, so summing those
 // groups can inflate orders/AOV. Independent cumulative period counts establish
 // the unique increments without reading order IDs or changing the population.
 const cutoff=hourlySessionCutoff(client.timezone,now),limit=w.to===cutoff.date?cutoff.hour:24,cumulativeOrders:ShopifyCumulativeOrders=[];
 for(let beforeHour=1;beforeHour<limit;beforeHour+=2){
  const boundaries=[beforeHour,...beforeHour+1<limit?[beforeHour+1]:[]];
  cumulativeOrders.push(...await Promise.all(boundaries.map(async boundary=>({beforeHour:boundary,rows:await run(shopifyCumulativeOrderQuery(kind,w.to,boundary))}))));
 }
 const final=await run(shopifyCumulativeOrderQuery(kind,w.to,limit)),expected=new Map(daily.map(row=>[groupKey(kind,row),numeric(row.orders)]));
 for(const row of final){const key=groupKey(kind,row);if(!expected.has(key)||expected.get(key)!==numeric(row.orders))throw new Error('Cumulative Shopify orders do not reconcile after provider updates');expected.delete(key);}
 if([...expected.values()].some(count=>count!==0))throw new Error('Cumulative Shopify orders do not reconcile after provider updates');
 return normalizeShopifyHourlyCommerce(kind,{hourly,daily,cumulativeOrders},client,w,now);
}
