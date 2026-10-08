import {it,expect} from 'vitest';
import { csv } from '../../lib/server/export';
it('escapes formulas, commas and quotes in actual exports',()=>expect(csv([{page:'=HYPERLINK("x")',revenue:15,label:'a,b'}])).toBe('page,revenue,label\r\n"\'=HYPERLINK(""x"")",15,"a,b"'));
