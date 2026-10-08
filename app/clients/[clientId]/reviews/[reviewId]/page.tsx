import {requireClientAccess,getStore} from '../../../../../lib/server/access';
import {getChatGPTUser,chatGPTSignInPath} from '../../../../chatgpt-auth';
import {ReviewDocument} from '../../../../../components/analytics/review-document';
export const dynamic='force-dynamic';
export default async function ReviewPage({params}:{params:Promise<{clientId:string;reviewId:string}>}){
 // Vinext canonicalizes page params as URL-encoded segments; route handlers
 // receive decoded params. Decode the page identity before scoped lookup.
 const raw=await params,clientId=decodeURIComponent(raw.clientId),reviewId=decodeURIComponent(raw.reviewId);
 if(!await getChatGPTUser())return <main className="auth-screen"><a className="primary-button" href={chatGPTSignInPath(`/clients/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(reviewId)}`)} target="_top">Sign in to read this review</a></main>;
 try{const scope=await requireClientAccess(clientId),s=getStore(),client=(await s.clients(scope.organizationId)).find(c=>c.id===clientId),row=await s.first('SELECT * FROM reviews WHERE organizationId=? AND clientId=? AND id=?',scope.organizationId,clientId,reviewId);if(!client||!row)throw new Error('Review unavailable');const review={...row,current:!!row.current,payload:JSON.parse(row.payload)};return <main className="standalone-review"><a className="text-button report-back" href={`/clients/${encodeURIComponent(clientId)}?view=reviews`}>← {client.name} workspace</a><ReviewDocument client={client} review={review} standalone/></main>;}catch{return <main className="auth-screen"><p>This review is unavailable or you do not have client access.</p><a href="/">Return to workspace</a></main>;}
}
