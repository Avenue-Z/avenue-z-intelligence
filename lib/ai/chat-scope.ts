import {workspaceObservationSelection} from '../analytics/workspace-datasets';

export function chatNeedsMonthHistory(question:string){
 return /\b(?:mtd|months?|monthly)\b/i.test(question);
}
export function chatNeedsReviewBody(question:string){
 return /\b(?:reports?|reviews?|recommendations?)\b|\bwatch\s+list\b/i.test(question);
}
export function chatObservationSelection(view:string,question:string){
 const selection=workspaceObservationSelection(chatDatasets(view,question)),history=/\b(?:charts?|trends?|history|historical|hourly|daily|weekly|monthly)\b|\bover\s+time\b|\bday\s+by\s+day\b|\b(?:last|past|previous)\s+(?:(?:\d+|seven|thirty)\s+)?(?:days?|weeks?|months?)\b/i.test(question);
 return {...selection,dimensions:true,includePriorWeek:false,trendDatasets:history?selection.trendDatasets:[]};
}
export function needsCreativeDetail(question:string){
 const q=question.toLowerCase();
 return /creative|campaign|\bcpc\b|\bcpm\b|\bctr\b|click|impression/.test(q)||/\b(?:which|best|top|worst)\s+(?:performing\s+)?ads?\b|\bad[\s-]+level\b|\bads?\s+(?:performance|performed|performing)\b/.test(q);
}
export function chatDatasets(view:string,question:string){
 const selected=view==='reviews'?'overview':view,sets=new Set(['overview',selected]),q=question.toLowerCase();
 if(selected==='overview'||['traffic','funnels'].includes(selected)||/traffic|session|funnel|conversion|cvr|checkout|landing|page|utm/.test(q)){sets.add('traffic');sets.add('funnels');}
 if(selected==='overview'||/country|market|region|localisation|localization/.test(q))sets.add('markets');
 if(selected==='subscriptions'||selected==='overview'||/subscription|renewal|recurring|cancel|refund|recharge|churn/.test(q)){sets.add('subscriptions');sets.add('subscriptionEvents');}
 if(selected==='media'||/spend|mer|roas|acquisition|efficiency|ad\b|ads\b|creative|campaign|meta|snapchat|\bcpc\b|\bcpm\b|\bctr\b|click|impression/.test(q))sets.add('media');
 if(needsCreativeDetail(question))sets.add('creatives');
 if(selected==='products'||/product|offer|price|pricing|bundle|discount/.test(q))sets.add('products');
 if(selected==='revenue'||/revenue|sales|order|aov/.test(q))sets.add('revenue');
 if(selected==='revenue'||selected==='subscriptions'||selected==='overview'||/order type|subscription|renewal|one.time|aov|items per order|units/.test(q))sets.add('orderStreams');
 if(selected==='subscriptions'||/renewal|recurring|refunded amount|currency mix|items per order/.test(q))sets.add('renewalDiagnostics');
 if(selected==='revenue'||selected==='products'||/onbrand|zero.?value|zero.?dollar|promo|freebie|seeding/.test(q))sets.add('orderHygiene');
 if(/experiment|variant/.test(q))sets.add('experiments');
 return [...sets].sort();
}
