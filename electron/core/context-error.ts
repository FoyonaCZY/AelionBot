import type {ContextIssue} from '../../src/context-issue';
export class ContextCapacityError extends Error {
  constructor(readonly issue:ContextIssue){super(`上下文空间不足：预计需要 ${issue.estimatedTokens??'更多'} token，当前输入预算 ${issue.inputBudget??issue.capacity}。工作记录已保留，请调整模型上下文容量或缩小任务输入后继续。${issue.reason?' 原因：'+issue.reason.slice(0,500):''}`);this.name='ContextCapacityError';}
}
