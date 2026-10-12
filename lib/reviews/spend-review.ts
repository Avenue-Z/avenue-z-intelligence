import {change,ratio} from '../analytics/metrics';
type Metrics={revenue:number|null;spend:number|null;newOrders:number|null};
export function authoritativeSpendReview(current:Metrics,prior:Metrics,currency:string,qualified:boolean){
 const money=(n:number|null)=>n===null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:2}).format(n);
 const percent=(n:number|null)=>n===null?'unavailable':`${n>=0?'+':''}${(n*100).toFixed(1)}%`;
 const multiple=(n:number|null)=>n===null?'Unavailable':`${n.toFixed(2)}×`;
 const revenueChange=change(current.revenue,prior.revenue),spendChange=change(current.spend,prior.spend),mer=ratio(current.revenue,current.spend),priorMer=ratio(prior.revenue,prior.spend);
 const direction=revenueChange===null||spendChange===null?'The relative pace is unavailable.':revenueChange<0&&spendChange<0?`Spend fell ${spendChange<revenueChange-.01?'faster':spendChange>revenueChange+.01?'slower':'proportionally'} than revenue.`:`Spend growth was ${spendChange>revenueChange+.01?'higher':spendChange<revenueChange-.01?'lower':'proportional'} than revenue growth.`;
 const headline=`Spend vs revenue: revenue ${percent(revenueChange)}, spend ${percent(spendChange)}. ${direction}${qualified?'':' Matched coverage is unconfirmed.'}`;
 const paragraph=`Selected revenue is ${money(current.revenue)} versus ${money(prior.revenue)}; spend is ${money(current.spend)} versus ${money(prior.spend)}. ${direction} Revenue/spend is ${multiple(mer)} versus ${multiple(priorMer)}. ${qualified?'These figures use qualified matching source windows.':'These are arithmetic ratios; source coverage does not establish a qualified efficiency verdict.'} MER does not establish profitability or break-even without margin data.`;
 return {headline,paragraph,columns:['Metric','Selected window','Comparison window','Change'],rows:[['Revenue',money(current.revenue),money(prior.revenue),percent(revenueChange)],['Ad spend',money(current.spend),money(prior.spend),percent(spendChange)],['Revenue / spend',multiple(mer),multiple(priorMer),'Arithmetic ratio'],['Spend / new-customer order',money(ratio(current.spend,current.newOrders)),money(ratio(prior.spend,prior.newOrders)),qualified?'Matched source windows':'Coverage unconfirmed']]};
}
