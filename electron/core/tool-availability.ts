export class TemporarilyUnavailableTool extends Error {
 readonly code='TOOL_TEMPORARILY_UNAVAILABLE';
 constructor(message:string){super(message);this.name='TemporarilyUnavailableTool';}
}

export function reactionRestriction(name:string,hasWork:boolean,duplicateReaction=false){
 if(hasWork&&(name==='chat_pin'||name==='group_pin'))return '当前有计划或目标需要处理，请继续执行工作或给出文字结果，不要使用表情工具结束任务。';
 if(duplicateReaction&&name==='chat_pin')return '本轮已经存在相同表态，请用文字回应用户，不要继续调用 chat_pin。';
}

export function reactionRestrictionContext(hasWork:boolean,duplicateReaction:boolean){
 const restrictions=[hasWork?'chat_pin、group_pin：当前计划或目标处理中，请继续工作或用文字答复。':'',duplicateReaction?'chat_pin：本轮已有相同表态，请用文字回应。':''].filter(Boolean);
 return restrictions.length?'当前工具执行限制（工具定义不代表本轮允许执行，调用前仍由应用校验）：\n'+restrictions.join('\n'):'';
}
