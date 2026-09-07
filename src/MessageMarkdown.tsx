import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {ComponentProps} from 'react';
import './message-markdown.css';

export default function MessageMarkdown(props:ComponentProps<typeof Markdown>){
  return <Markdown {...props} remarkPlugins={[remarkGfm,...(props.remarkPlugins||[])]} components={{table:({node,...table})=><div className="markdown-table-scroll"><table {...table}/></div>,...props.components}}/>;
}
