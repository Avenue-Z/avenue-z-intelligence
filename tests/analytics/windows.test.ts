import { it, expect } from 'vitest';
import { dayWindow, recurringWindows, matchedCutoff } from '../../lib/analytics/windows';
it('accounts for both store DST transitions',()=>{expect(dayWindow('2026-11-01','America/New_York').durationHours).toBe(25);expect(dayWindow('2026-10-25','Europe/Stockholm').durationHours).toBe(25);});
it('uses local Monday and four calendar weeks earlier',()=>expect(recurringWindows('2026-10-08')).toEqual({current:'2026-10-05',comparison:'2026-09-07'}));
it('uses the mutually available complete hour',()=>expect(matchedCutoff(['2026-10-08T12:55:00Z','2026-10-08T11:48:00Z'])).toBe('2026-10-08T11:00:00Z'));
