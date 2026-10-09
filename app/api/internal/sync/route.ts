import {enqueueDue,runSyncBatch,generateReview} from '../../../../lib/jobs/sync';
import {getStore} from '../../../../lib/server/access';
import {privateRunnerScope} from '../../../../lib/server/private-runner';
import {todayIn,shiftDate} from '../../../../lib/analytics/windows';
export async function POST(request:Request){try{const scope=await privateRunnerScope();await enqueueDue(scope);const result=await runSyncBatch(scope);if(new URL(request.url).searchParams.get('review')==='true'){const client=(await getStore().clients(scope.organizationId)).find(c=>c.id==='kind-patches')!;const date=shiftDate(todayIn(client.timezone),client.config.reviewMode==='closed'?-1:0);return Response.json({...result,reviewId:await generateReview(scope,client,date)});}return Response.json(result);}catch(e){return Response.json({error:(e as Error).message},{status:403});}}
