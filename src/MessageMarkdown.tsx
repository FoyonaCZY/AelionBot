import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {ComponentProps} from 'react';
import {MessageLink} from './MessageLink';
import {MessageCodeBlock} from './MessageCodeBlock';
import './message-markdown.css';

export default function MessageMarkdown(props:ComponentProps<typeof Markdown>){
  return <Markdown {...props} remarkPlugins={[remarkGfm,...(props.remarkPlugins||[])]} components={{a:MessageLink,pre:MessageCodeBlock,table:({node,...table})=><div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="表格"><table {...table}/></div>,...props.components}}/>;
}
