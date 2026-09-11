import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {ComponentProps} from 'react';
import {MessageLink} from './MessageLink';
import {MessageCodeBlock} from './MessageCodeBlock';
import './message-markdown.css';
import {useI18n} from './i18n';

export default function MessageMarkdown(props:ComponentProps<typeof Markdown>){
  const {t}=useI18n();
  return <Markdown {...props} remarkPlugins={[remarkGfm,...(props.remarkPlugins||[])]} components={{a:MessageLink,pre:MessageCodeBlock,table:({node,...table})=><div className="markdown-table-scroll" tabIndex={0} role="region" aria-label={t('表格')}><table {...table}/></div>,...props.components}}/>;
}
