import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {ComponentProps} from 'react';
import {MessageLink} from './MessageLink';
import './message-markdown.css';

export default function MessageMarkdown(props:ComponentProps<typeof Markdown>){
  return <Markdown {...props} remarkPlugins={[remarkGfm,...(props.remarkPlugins||[])]} components={{a:MessageLink,table:({node,...table})=><div className="markdown-table-scroll"><table {...table}/></div>,...props.components}}/>;
}
