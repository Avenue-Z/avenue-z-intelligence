import {it,expect} from 'vitest';
import {chooseBenchmark} from '../../lib/analytics/benchmark';
const row={key:'us',dimensions:{page:'/a',market:'US',source:'meta',device:'mobile'},summary:{sessions:6000,cvr:.02}} as any;
it('uses own prior period instead of benchmarking the US page against itself',()=>expect(chooseBenchmark(row,[row],[{...row,summary:{sessions:5000,cvr:.03}}],'US').cvr).toBe(.03));
it('holds source and device fixed across markets',()=>{const ca={...row,key:'ca',dimensions:{...row.dimensions,market:'CA'}};expect(chooseBenchmark(ca,[{...row,dimensions:{...row.dimensions,source:'google'},summary:{sessions:5000,cvr:.1}},row],[],'US').cvr).toBe(.02);});
