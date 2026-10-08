export function ratio(n:number|null|undefined,d:number|null|undefined) { return n==null||d==null||d<=0 ? null : n/d; }
export function opportunity(sessions:number,current:number,benchmark:number) { return sessions*Math.max(0,benchmark-current); }
export function change(current:number|null,previous:number|null) { return current==null||previous==null||previous===0?null:(current-previous)/Math.abs(previous); }
type Pair=[number|null,number|null];
export function spendVerdict(input:{spend:Pair;revenue:Pair;newOrders:Pair;complete:boolean;tolerance?:number}) {
  const sd=change(input.spend[1],input.spend[0]),rd=change(input.revenue[1],input.revenue[0]);
  const mer=ratio(input.revenue[1],input.spend[1]),previousMer=ratio(input.revenue[0],input.spend[0]);
  const cost=ratio(input.spend[1],input.newOrders[1]),previousCost=ratio(input.spend[0],input.newOrders[0]);
  const empty={spendComparison:'unavailable',growth:'unavailable',sd,rd,mer,previousMer,cost,previousCost};
  if(!input.complete||sd===null||rd===null) return empty;
  const tolerance=input.tolerance??.01;
  const spendComparison=sd>rd+tolerance?'faster':sd<rd-tolerance?'slower':'proportional';
  const growth=cost===null||previousCost===null?'unavailable':rd>0&&rd>=sd&&cost<=previousCost?'efficient':sd>rd+tolerance||cost>previousCost?'inefficient':'inconclusive';
  return {...empty,spendComparison,growth};
}
export function compatibleTotal(rows:{value:number|null;currency:string|null;definition:string}[]) {
  if(!rows.length||rows.some(x=>x.value===null||x.currency!==rows[0].currency||x.definition!==rows[0].definition)) return null;
  return rows.reduce((s,x)=>s+x.value!,0);
}
export function experimentConclusion(status:string,low:number,high:number) { return status.includes('not_ready')?'Not ready':low>0?'Positive evidence':high<0?'Negative evidence':'Inconclusive'; }
