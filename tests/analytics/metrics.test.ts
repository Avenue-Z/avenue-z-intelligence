import { describe, it, expect } from 'vitest';
import { ratio, opportunity, spendVerdict, compatibleTotal, experimentConclusion } from '../../lib/analytics/metrics';
describe('analytics definitions',()=>{
  it('returns unavailable for missing or zero denominators',()=>{expect(ratio(10,0)).toBeNull();expect(ratio(null,20)).toBeNull();});
  it('uses fractions for conversion opportunities',()=>{expect(opportunity(1000,.03,.04)).toBeCloseTo(10);expect(opportunity(1000,.05,.04)).toBe(0);});
  it('requires new-customer efficiency as well as revenue growth',()=>{
    expect(spendVerdict({spend:[100,110],revenue:[200,240],newOrders:[10,12],complete:true})).toMatchObject({spendComparison:'slower',growth:'efficient'});
    expect(spendVerdict({spend:[100,110],revenue:[200,240],newOrders:[10,9],complete:true}).growth).not.toBe('efficient');
    expect(spendVerdict({spend:[100,110],revenue:[200,240],newOrders:[null,null],complete:true}).growth).toBe('unavailable');
  });
  it('suppresses conclusions when channel coverage is incomplete',()=>expect(spendVerdict({spend:[100,110],revenue:[200,240],newOrders:[10,12],complete:false}).spendComparison).toBe('unavailable'));
  it('does not sum incompatible currency or metric scope',()=>{
    expect(compatibleTotal([{value:10,currency:'USD',definition:'web'},{value:20,currency:'USD',definition:'all'}])).toBeNull();
    expect(compatibleTotal([{value:10,currency:'USD',definition:'web'},{value:20,currency:'USD',definition:'web'}])).toBe(30);
  });
  it('keeps uncertain experiments inconclusive',()=>{expect(experimentConclusion('running',-.01,.02)).toBe('Inconclusive');expect(experimentConclusion('not_ready',.01,.03)).toBe('Not ready');});
});
