import {InteractionDenied} from './interactions';
import {redactHost} from './host';
import type {OperationDenial} from '../../src/operation-denial';
export function operationDenial(error:InteractionDenied,redact:(text:string)=>string=redactHost):OperationDenial{
 const details=error.details,result:OperationDenial={source:error.source,reason:redact(error.message).slice(0,1600)};
 for(const key of ['operation','command','cwd','path','tool','server','content'] as const)if(typeof details?.[key]==='string')result[key]=redact(details[key]!).slice(0,key==='content'?4000:6000);
 if(details?.arguments)result.arguments=redact(JSON.stringify(details.arguments,null,2)).slice(0,4000);
 return result;
}
export const DENIAL_GUIDANCE='This operation was denied and was not performed. Do not retry it, disguise it, or use another tool to perform the same denied action. Continue with other authorized work where possible, or explain what remains blocked and ask the user for clarification. Do not claim the denied work succeeded.';
