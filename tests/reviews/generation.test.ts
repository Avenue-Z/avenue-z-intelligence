import {it,expect} from 'vitest';
import {latestReviewDate,reviewScheduleLabel} from '../../lib/reviews/generation';
const client={timezone:'America/New_York',config:{reviewMode:'closed',reviewTime:'09:00',reviewTimezone:'America/New_York'}} as any;
it('generates the configured latest store day independently of retained historical dashboard dates',()=>{
 const now=new Date('2026-10-12T02:00:00Z');expect(latestReviewDate(client,now)).toBe('2026-10-10');expect(latestReviewDate({...client,config:{...client.config,reviewMode:'partial'}},now)).toBe('2026-10-11');
});
it('does not infer scheduler activation from a configured clock',()=>{
 expect(reviewScheduleLabel(client)).toContain('execution status unconfirmed');expect(reviewScheduleLabel(client)).not.toContain('Scheduled generation active');expect(reviewScheduleLabel(client,{active:true})).toContain('Scheduled generation active');
});
it('does not advertise automatic reports for a brand without live sources',()=>{const label=reviewScheduleLabel(client,{active:true,waitingForSources:true});expect(label).toContain('waiting for live client sources');expect(label).not.toContain('Scheduled generation active');});
