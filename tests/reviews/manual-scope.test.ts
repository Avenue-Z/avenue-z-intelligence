import {expect,it} from 'vitest';
import type {Client} from '../../lib/analytics/contracts';
import clients from '../../data/initial-clients.json';
import {manualReviewMode} from '../../lib/reviews/manual-scope';
it('uses closed evidence for a prior Stockholm day while New York is still on that date',()=>{
 const client=clients[0] as Client,now=new Date('2026-10-12T22:30:00Z');
 expect(manualReviewMode(client,'2026-10-12',now)).toBe('closed');
 expect(manualReviewMode(client,'2026-10-13',now)).toBe('partial');
 expect(()=>manualReviewMode(client,'2026-10-14',now)).toThrow('earlier store date');
});
it('preserves a closed-day brand schedule for its current calendar date',()=>{
 const client=clients[1] as Client;
 expect(manualReviewMode(client,'2026-10-12',new Date('2026-10-12T22:30:00Z'))).toBe('closed');
});
