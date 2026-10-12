import type {Client} from '../analytics/contracts';
import {shiftDate,todayIn} from '../analytics/windows';
/** Daily generation follows client configuration, independently of dashboard archive filters. */
export function latestReviewDate(client:Pick<Client,'timezone'|'config'>,now=new Date()){
 return shiftDate(todayIn(client.timezone,now),client.config.reviewMode==='closed'?-1:0);
}
export type ReviewScheduleState={active:boolean;lastJob?:{storeDate:string;mode:string;status:string;completedAt?:string|null;error?:string|null}|null};
export function reviewScheduleLabel(client:Pick<Client,'config'>,state?:ReviewScheduleState){
 const configured=`Configured review time: ${client.config.reviewTime} ${client.config.reviewTimezone}`;
 return `${configured} · ${state?.active===true?'Scheduled generation active':state?.active===false?'Scheduled generation inactive':'Scheduler execution status unconfirmed'}`;
}
