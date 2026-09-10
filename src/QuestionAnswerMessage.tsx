import type {QuestionAnswerData} from './question-answers';
import './question-answer-message.css';

export function QuestionAnswerMessage({answer}:{answer:QuestionAnswerData}){
  return <section className="question-answer-message" aria-label="已提交的问答">
    <header><span>你的回答</span><span>{answer.items.length} 项</span></header>
    <dl>{answer.items.map(item=><div className="question-answer-pair" key={item.id}><dt>{item.title}</dt><dd>{item.answer}</dd></div>)}</dl>
  </section>;
}
