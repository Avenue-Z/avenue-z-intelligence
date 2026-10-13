import type {Review} from '../analytics/contracts';

export const reviewIndexFields=['type','title','methodology','reviewStandardVersion','inputFingerprint','filters','generatedAt','model','kpis','summary','headlines','sourceIds','actions','sources','watchActions','reportTiming','presentationCorrection','scheduledOrigin','sourceUrl'] as const;
/** Analytics tabs need dated summaries and action citations. Full report
 * sections, text and numeric appendices load only in the review workspace.
 */
export function workspaceReviewIndex(review:Review):Review{
 return {...review,payload:Object.fromEntries(reviewIndexFields.filter(key=>Object.hasOwn(review.payload,key)).map(key=>[key,review.payload[key]]))};
}
