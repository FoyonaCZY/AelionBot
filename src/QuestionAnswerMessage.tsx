import type {QuestionAnswerData} from './question-answers';
import {useI18n} from './i18n';
import './question-answer-message.css';

export function QuestionAnswerMessage({answer}:{answer:QuestionAnswerData}){
  const {t}=useI18n();
  return <section className="question-answer-message" aria-label={t('已提交的问答')}>
    <header><span>{t('你的回答')}</span><span>{t('{count} 项',{count:answer.items.length})}</span></header>
    <dl>{answer.items.map(item=><div className="question-answer-pair" key={item.id}><dt>{item.title}</dt><dd>{item.answer}</dd></div>)}</dl>
  </section>;
}
