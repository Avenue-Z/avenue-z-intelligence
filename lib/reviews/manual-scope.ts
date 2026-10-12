import type {Client} from '../analytics/contracts';
import {todayIn} from '../analytics/windows';
/** An archived store day is closed even when the brand's daily schedule is
 * intraday. Applying today's clock to that date would truncate its evidence. */
export function manualReviewMode(client:Client,date:string,asOf=new Date()){
 const today=todayIn(client.timezone,asOf);
 if(date>today)throw Error('Choose today or an earlier store date');
 return date<today?'closed' as const:client.config.reviewMode;
}
