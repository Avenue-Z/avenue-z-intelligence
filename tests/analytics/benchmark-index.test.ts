import {expect,it} from 'vitest';
import {benchmarkLookup,chooseBenchmark} from '../../lib/analytics/benchmark';
import {summarize,type detailRows} from '../../lib/analytics/query';
type Detail=ReturnType<typeof detailRows>[number];
const detail=(key:string,dimensions:Record<string,string>,sessions:number|null=1000,cvr:number|null=.05):Detail=>({key,dimensions,metrics:{},summary:{...summarize([]),sessions,cvr},evidence:[]});
it('preserves the first canonical-market peer and the first eligible own-prior match',()=>{
 const target=detail('de',{page:'/a',market:'Germany',source:'meta',device:'mobile'}),wrong=detail('wrong',{...target.dimensions,market:'FR',source:'google'},1000,.5),first=detail('first',{...target.dimensions,market:'France'},1000,.1),later=detail('later',{...first.dimensions,market:'FR'},1000,.2),emptyPrior=detail(target.key,target.dimensions,1000,null),prior=detail(target.key,target.dimensions,1000,.03),previous=[emptyPrior,prior],current=[wrong,first,later,target],lookup=benchmarkLookup(current,previous,'FR');
 expect(lookup.choose(target)).toEqual(chooseBenchmark(target,current,previous,'FR'));expect(lookup.choose(target).reference).toBe(first);expect(lookup.previous(target.key)).toBe(emptyPrior);
 const own=benchmarkLookup([target],previous,'DE');expect(own.choose(target)).toEqual(chooseBenchmark(target,[target],previous,'DE'));expect(own.choose(target).reference).toBe(prior);
});
it('preserves stable family ranking and excludes self only after taking the top five',()=>{
 const rows=[detail('self',{family:'f',market:'US',page:'/self'},2000,.2),...Array.from({length:5},(_,index)=>detail(`p${index}`,{family:'f',market:'US',page:`/${index}`},1000,index===4?.001:.1))],lookup=benchmarkLookup(rows,[],'US'),before=JSON.stringify(rows);
 expect(lookup.choose(rows[0])).toEqual(chooseBenchmark(rows[0],rows,[],'US'));expect(lookup.choose(rows[0]).reference).toBe(rows[1]);expect(lookup.choose(rows[1])).toEqual(chooseBenchmark(rows[1],rows,[],'US'));expect(JSON.stringify(rows)).toBe(before);
});
it('matches the legacy benchmark for mixed countries, contexts, missing rates and duplicate keys',()=>{
 const current=Array.from({length:250},(_,index)=>detail(`k${index%31}`,{page:`/p${index%17}`,market:['US','United States','CA','Canada','France','FR',''][index%7],source:index%2?'meta':'google',device:index%3?'mobile':'desktop',stream:index%5?'web':'retail',...index%4?{family:`f${index%3}`}:{}} ,index%11?index*13:null,index%9?(index%7)/100:null)),previous=current.slice().reverse().map((row,index)=>({...row,summary:{...row.summary,cvr:index%3?.08:null}})),lookup=benchmarkLookup(current,previous,'United States');
 for(const row of current)expect(lookup.choose(row)).toEqual(chooseBenchmark(row,current,previous,'United States'));
});
it('bounds peer inspection to one indexing pass instead of rescanning every peer for each candidate',()=>{
 let marketReads=0;const rows=Array.from({length:1000},(_,index)=>detail(`k${index}`,new Proxy({page:`/p${index}`,market:'CA'},{get(target,key,receiver){if(key==='market')marketReads++;return Reflect.get(target,key,receiver);}}))),lookup=benchmarkLookup(rows,[],'US');for(const row of rows)lookup.choose(row);expect(marketReads).toBeLessThan(rows.length*10);
});
