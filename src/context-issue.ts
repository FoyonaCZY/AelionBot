import type {ModelConfig} from './shared';
export interface ContextIssue {capacity:number;estimatedTokens?:number;inputBudget?:number;modelKey:string;reason?:string;}
export const contextModelKey=(model:Pick<ModelConfig,'baseUrl'|'model'|'contextTokens'|'providerId'|'protocol'>)=>JSON.stringify([model.providerId||'',model.baseUrl,model.model,model.protocol||'chat',model.contextTokens]);
export const isContextCapacityFailure=(text:string)=>/上下文.*(?:超过|容量|不足|预算|超出)|context.*(?:length|window|limit)|token.limit/i.test(text);
export function contextNeedsChange(issue:ContextIssue|undefined,model?:ModelConfig){return Boolean(issue&&model&&issue.modelKey===contextModelKey(model));}
