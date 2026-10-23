import {parseAIRequest,aiContext,reserveAI} from './server';
import {serverSecret} from '../server/secrets';
import type {AccessScope} from '../analytics/contracts';
import type {Store} from '../server/store';
import {fingerprint} from '../reviews/build';
import {validateAnswer,type AISource} from './context';
import {loadPlatformSession,platformSessionHistory,PLATFORM_CHAT_VERSION} from './platform-session';
import {createPlatformTools} from './platform-tools';
import {askPlatformOpenAI} from './platform-provider';
import {untracedChatPhase,type ChatPhaseRunner} from './chat-phases';
import {todayIn} from '../analytics/windows';
/** Existing dashboard context is a navigation hint. Every data lookup remains
 * server-authorized and carries its own dates, population and source links. */
export async function answerPlatformAI(body:Parameters<typeof parseAIRequest>[0],existingScope?:AccessScope,options:{store?:Store;phase?:ChatPhaseRunner}={}){
 if(typeof body.question!=='string'||!body.question.trim()||body.question.length>3000)throw Error('Ask a question of up to 3,000 characters');
 const a=parseAIRequest(body),phase=options.phase??untracedChatPhase;
 const session=await phase('context',()=>loadPlatformSession(a.clientId,a.filters,a.reviewId,existingScope,options.store)),{s,scope,scopeKey}=session;
 const key=serverSecret('OPENAI_API_KEY');if(!key)throw Error('OpenAI is not configured');await phase('reserve',()=>reserveAI(s,scope));
 const history=await phase('history',()=>platformSessionHistory(session));
 const modelHistory=history.slice(-6).map(turn=>({question:turn.question,...turn.payload?.analysisStandardVersion===PLATFORM_CHAT_VERSION&&typeof turn.payload.answer==='string'?{answer:turn.payload.answer.slice(0,6000)}:{}}));
 const sources=new Map<string,AISource>(),lookups:unknown[]=[],answeredBrands=new Map<string,string>();
 const tools=createPlatformTools({scope,clients:session.records,filters:session.filters,currentClientId:a.clientId,reviewId:a.reviewId,question:body.question,store:s,loadContext:async(clientId,filters,question,reviewId)=>
  (await aiContext(clientId,filters,reviewId,scope,false,true,question,s,true)).context
 }).map(tool=>({...tool,execute:async(input:unknown)=>{const result=await tool.execute(input) as {sources?:AISource[];clients?:{client?:{id?:string;name?:string}}[]};
  for(const source of result.sources??[])sources.set(source.id,source);
  for(const client of result.clients??[])if(client.client?.id&&client.client.name)answeredBrands.set(client.client.id,client.client.name);
  lookups.push(result);return result;
 }}));
 const brief={asOf:new Date().toISOString(),authorizedBrands:session.records.map(client=>({id:client.id,name:client.name,timezone:client.timezone,currency:client.currency,today:todayIn(client.timezone),revenueDefinition:client.config.revenueDefinition,subscriptionsEnabled:client.config.subscriptionsEnabled!==false&&client.id!=='beam',minSessions:client.config.minSessions,minOpportunity:client.config.minOpportunity})),startingContext:{clientId:a.clientId??null,filters:session.filters,reviewId:a.reviewId??null},instruction:'The starting screen supplies navigation context, never a data-access boundary. Look up any authorized brand/date/dataset needed to answer; all/portfolio/both means every authorized brand. Named brands override the starting client. For broad unqualified platform questions about markets/pages, query all brands. Preserve explicitly referenced this page/market filters, otherwise null filters mean all segments. Day over day means compare previous even when the screen has last-week selected. Re-read current evidence for follow-ups; previous assistant answers establish conversation references, never current facts.'};
 const answer=await phase('model',async()=>validateAnswer(await askPlatformOpenAI(key,serverSecret('OPENAI_MODEL')||'gpt-5.4-mini',brief,modelHistory,body.question,tools),[...sources.values()]));
 return phase('persist',async()=>{const payload={...answer,sources:[...sources.values()].filter(source=>answer.sourceIds.includes(source.id)),scope:{filters:(lookups.find(value=>value&&typeof value==='object'&&'filtersByBrand' in value) as {filtersByBrand?:{filters:typeof session.filters}[]}|undefined)?.filtersByBrand?.[0]?.filters??session.filters,clients:[...answeredBrands.values()],reviewId:a.reviewId??null,queries:lookups.flatMap(value=>value&&typeof value==='object'&&'filtersByBrand' in value?(value as {filtersByBrand:unknown[]}).filtersByBrand:[])},analysisStandardVersion:PLATFORM_CHAT_VERSION,evidenceFingerprint:await fingerprint(lookups)},id=crypto.randomUUID(),createdAt=new Date().toISOString();await s.run('INSERT INTO ai_turns(id,organizationId,actorId,scopeKey,question,payload,createdAt) VALUES(?,?,?,?,?,?,?)',id,scope.organizationId,scope.actorId,scopeKey,body.question,JSON.stringify(payload),createdAt);return {id,question:body.question,payload,createdAt};});
}
