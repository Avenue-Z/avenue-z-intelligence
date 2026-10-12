import {AuthorizedWorkspace} from '../../page';
import {workspaceSearchParams} from '../../../lib/server/workspace';
export const dynamic='force-dynamic';
export default async function ClientPage({params,searchParams}:{params:Promise<{clientId:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {const {clientId}=await params;return <AuthorizedWorkspace clientId={clientId} query={workspaceSearchParams(await searchParams??{})}/>;}
