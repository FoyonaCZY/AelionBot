import type {BotMention} from '../../src/peer-types';
import type {GroupRoom} from '../../src/group-types';
export const normalized=(value:string)=>value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
// These describe the act of explaining; they are not evidence of an additional fact.
const framing=new Set('这个 这是 那个 一个 一种 名为 名叫 标题 主要 内容 包含 具有 提供 支持 基本 实现 使用 通过 它是 其中 此外 以及 并且 然后 已经 可以 能够 就能 即可 直接 附件 文件 页面 绘制 显示 查看 观看 效果 大家 我们 你们'.split(' '));
const facts=(text:string)=>new Set([...segmenter.segment(text.toLowerCase())].filter(part=>part.isWordLike&&part.segment.length>1&&!framing.has(part.segment)).map(part=>part.segment));
const grams=(text:string)=>new Set(Array.from({length:Math.max(0,text.length-1)},(_,i)=>text.slice(i,i+2)));
const numbers=(text:string)=>text.match(/\d+(?:\.\d+)?/g)?.join('|')||'';
const freshSignal=/[?？]|但是|然而|不过|更正|纠正|补充|反对|不支持|无法|不能|并非|不是|尚未|未完成|失败|风险|错误|漏洞|(?:只|仅)支持|不要|请|需要|负责|分工|分配|交给|\b(?:but|however|not|cannot|instead|correction|risk|failed)\b/i;

export function individualGroupResponses(request:string){
  if(/(?:不要|不用|无需|不必).{0,12}(?:分别|各自|每|逐一|表态|投票)/.test(request))return false;
  return /(?:分别|各自|每(?:个|位|人)|逐一|轮流|依次).{0,20}(?:回答|回复|说|介绍|意见|看法|观点|判断|结论|核对)|投票|各抒己见|自我介绍|介绍(?:一下)?自己|\b(?:each of you|everyone.{0,15}(?:answer|vote)|vote)\b/i.test(request);
}

export function repeatedGroupResponse(room:GroupRoom,rootId:string,answer:string,mentions?:BotMention[],speakerId?:string,individual=false){
  const value=normalized(answer),tokens=numbers(answer),question=/[?？]/.test(answer);
  const previousReplies=room.messages.filter(message=>message.rootId===rootId&&message.sender.kind==='bot'&&message.kind==='message'&&(!mentions||JSON.stringify(message.mentions?.map(m=>m.id)||[])===JSON.stringify(mentions.map(m=>m.id))));
  // A requested vote or individual report has value through the identity of its author.
  const candidates=individual&&speakerId?previousReplies.filter(message=>message.sender.id===speakerId):previousReplies;
  if(candidates.some(message=>normalized(message.content)===value&&/[?？]/.test(message.content)===question))return true;
  if(value.length<40||value.length>16000||mentions?.length||freshSignal.test(answer))return false;
  const terms=facts(answer);if(terms.size<8)return false;
  const literals=[...answer.matchAll(/`([^`]+)`|《([^》]+)》|(https?:\/\/[^\s<>"'）)]+)/g)].map(match=>match[1]||match[2]||match[3]);
  const fragments=grams(value);
  return candidates.slice(-12).some(message=>{
    const previous=normalized(message.content);
    if(previous.length<40||value.length>previous.length*1.1||tokens!==numbers(message.content)||literals.some(literal=>!message.content.includes(literal)))return false;
    const known=facts(message.content);if([...terms].some(term=>!known.has(term)))return false;
    const covered=grams(previous);
    return [...fragments].filter(fragment=>covered.has(fragment)).length/fragments.size>=0.5;
  });
}

export function groupAcknowledgment(answer:string){
  const value=normalized(answer).replace(/[呀啊呢啦了哒喵吧]+$/,'');
  return /^(好的?|收到|谢谢|感谢|明白|了解|同意|赞同|ok|thanks|thankyou|understood)$/.test(value)||/^(我也?)?(同意|赞同)(你|大家|上述|以上)?(的)?(观点|意见|看法|建议|结论)$/.test(value)||/^(我这边|我)?(目前|暂时)?(没有|暂无)(其他|更多|新的|新)?(补充|信息|意见)$/.test(value);
}

export function groupContributionContext(room:GroupRoom,rootId:string,botId:string,triggerIds:string[]){
  const triggers=room.messages.filter(message=>triggerIds.includes(message.id)),latest=triggers.at(-1),replies=room.messages.filter(message=>message.rootId===rootId&&message.sender.kind==='bot'&&message.kind==='message');
  return `\n群聊发言规则：一条用户问题由群共同处理，不要求每位 Bot 各写一遍答案。别人已经回答的部分视为已回答。只有新增事实、未覆盖的要点、基于证据的纠错、必要的澄清问题或实际工作结果才值得发言；只输出增量部分。换一种措辞、缩短或重新排版、换角色语气、重复附件介绍、重复总结、表示同意、致谢、报到或宣布没有补充，都不算增量。没有这些增量时，只返回 [群聊静默]，不要发一条说明自己会保持安静的消息，也不要改用工具或 emoji 附和。\n如果用户明确要求分别回答、各自报告或投票，可以给出你自己的那一份；不要再重复已经发过的回答。如果自己有尚未完成的分工，应继续实际执行，其他人的总结不表示你的任务已经完成；已有工具结果应复用，不能为了接话再读一遍相同附件或重新执行已完成操作。\n本次真正触发处理的是消息序号 ${triggers.map(message=>message.seq).join('、')}；最后一条来自 ${latest?.sender.name||'群成员'}（${latest?.sender.kind||'unknown'}），消息 ID ${latest?.id||''}。${latest?.sender.kind==='bot'?'这是其他 Bot 的发言，不是用户再次提出原问题。先判断它是否需要你补充；没有新增内容时直接静默。':''}本轮已经有 ${replies.length} 条正式回答，你已发表 ${replies.filter(message=>message.sender.id===botId).length} 条。原始用户问题只用于理解背景，不是每条新成员消息都要重新完成的指令。以上判断在内部完成，不要把判断过程发到群里。`;
}
