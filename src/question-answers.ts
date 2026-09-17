export const QUESTION_ANSWER_PREFIX='用户对会话内问题的回答：';
export interface QuestionAnswerData{requestId:string;items:Array<{id:string;title:string;answer:string}>;}

export function questionAnswerData(value:unknown):QuestionAnswerData|undefined{
  if(questionAnswerText(value)===undefined)return;
  const reply=value as {id:string;questions:Array<{id:string;title:string}>;answers:Record<string,string>};
  return {requestId:reply.id,items:reply.questions.map(question=>({id:question.id,title:question.title.trim(),answer:reply.answers[question.id].trim()}))};
}

export function legacyQuestionAnswerData(content:string):QuestionAnswerData|undefined{
  if(!content.startsWith(QUESTION_ANSWER_PREFIX))return;
  try{return questionAnswerData(JSON.parse(content.slice(QUESTION_ANSWER_PREFIX.length)));}catch{return;}
}

export function questionAnswerText(value:unknown):string|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const reply=value as Record<string,unknown>;
  if(reply.status!=='answered'||typeof reply.id!=='string'||!Array.isArray(reply.questions)||!reply.questions.length||reply.questions.length>3||!reply.answers||typeof reply.answers!=='object'||Array.isArray(reply.answers))return;
  const answers=reply.answers as Record<string,unknown>,pairs:Array<{title:string;answer:string}>=[],ids=new Set<string>();
  for(const question of reply.questions){
    if(!question||typeof question!=='object'||typeof question.id!=='string'||!question.id||ids.has(question.id)||typeof question.title!=='string'||!question.title.trim()||!Object.hasOwn(answers,question.id))return;
    const answer=answers[question.id];if(typeof answer!=='string'||!answer.trim())return;
    ids.add(question.id);pairs.push({title:question.title.trim(),answer:answer.trim()});
  }
  if(Object.keys(answers).length!==pairs.length)return;
  return pairs.length===1?pairs[0].answer:pairs.map(pair=>`${pair.title}\n${pair.answer}`).join('\n\n');
}

export function readableQuestionAnswer(content:string):string{
  if(!content.startsWith(QUESTION_ANSWER_PREFIX))return content;
  try{return questionAnswerText(JSON.parse(content.slice(QUESTION_ANSWER_PREFIX.length)))??content;}catch{return content;}
}
export function questionToolMessage<T extends {id:string;botId:string;role:string;tool?:string;content:string}>(messages:T[],botId:string,requestId:string){
  return [...messages].reverse().find(message=>{
    if(message.botId!==botId||message.role!=='tool'||!['request_user_input','user_input_wait'].includes(message.tool||''))return false;
    try{const body=JSON.parse(message.content);return body.result?.id===requestId||body.id===requestId;}catch{return false;}
  });
}
const asksUser=(content:string)=>/[？?]/.test(content)||/请(?:你)?选|选一个|选项/.test(content);
export function placeQuestionAnswers<T extends {id:string;botId:string;role:string;tool?:string;content:string;status?:string;questionAnswer?:QuestionAnswerData}>(messages:T[]){
  const answers=messages.filter(message=>message.role==='user'&&(message.questionAnswer||legacyQuestionAnswerData(message.content)));
  if(!answers.length)return messages;
  const waiting=new Set(answers.map(message=>message.id)),placed=new Set<string>(),result:T[]=[];
  const release=(answer:T)=>{if(waiting.delete(answer.id)&&!placed.has(answer.id)){placed.add(answer.id);result.push(answer);}};
  const ready=(answer:T)=>{
    const requestId=(answer.questionAnswer||legacyQuestionAnswerData(answer.content))?.requestId;if(!requestId)return true;
    const tool=questionToolMessage(messages,answer.botId,requestId);if(!tool)return true;
    if(!result.includes(tool))return false;
    const asked=messages.slice(0,messages.indexOf(tool)).some(item=>item.role==='assistant'&&item.status!=='running'&&item.status!=='cancelled'&&asksUser(item.content));
    if(asked)return true;
    const follow=messages.slice(messages.indexOf(tool)+1).find(item=>item.id!==answer.id&&item.role==='assistant'&&item.status!=='running'&&item.status!=='cancelled'&&asksUser(item.content));
    return !follow||result.includes(follow);
  };
  for(const message of messages){
    if(waiting.has(message.id)||placed.has(message.id))continue;
    result.push(message);placed.add(message.id);
    for(const answer of answers)if(waiting.has(answer.id)&&ready(answer))release(answer);
  }
  for(const answer of answers)release(answer);
  return result;
}
