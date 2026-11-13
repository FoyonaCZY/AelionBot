import Markdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Children, createContext, isValidElement, useContext, useMemo, type ComponentProps } from 'react';
import { MessageLink } from './MessageLink';
import { MessageCodeBlock } from './MessageCodeBlock';
import { MessageVisual } from './MessageVisual';
import { VISUAL_FENCES } from '../../shared/chat/message-blocks';
import './message-markdown.css';
import { useI18n } from '../i18n';

/**
 * Where a fence that is still open at the end of the text starts, or Infinity. While a reply streams, its last
 * fence may not be closed yet; a visual fence there shows a placeholder instead of half a chart or half a page.
 */
function openFenceStart(markdown: string) {
  let open = -1,
    marker = '',
    offset = 0;
  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (open < 0) {
        open = offset;
        marker = fence;
      } else if (fence[0] === marker[0] && fence.length >= marker.length && !line.trim().slice(fence.length)) {
        open = -1;
      }
    }
    offset += line.length + 1;
  }
  return open < 0 ? Infinity : open;
}
const OpenFence = createContext(Infinity);

/** Code blocks, except visual fences, which show what they describe. Stable, so a widget is not reloaded. */
function Pre(pre: ComponentProps<'pre'> & ExtraProps) {
  const open = useContext(OpenFence);
  const child = Children.toArray(pre.children)[0],
    code = isValidElement<ComponentProps<'code'>>(child) ? child.props : undefined,
    language = /\blanguage-([^\s]+)/.exec(code?.className || '')?.[1] || '';
  if (VISUAL_FENCES.includes(language) && typeof code?.children === 'string')
    return (
      <MessageVisual
        language={language}
        source={code.children}
        pending={(pre.node?.position?.start.offset ?? -1) >= open}
      />
    );
  return <MessageCodeBlock {...pre} />;
}
function Table({ node: _node, ...table }: ComponentProps<'table'> & ExtraProps) {
  const { t } = useI18n();
  return (
    <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label={t('表格')}>
      <table {...table} />
    </div>
  );
}

export default function MessageMarkdown(props: ComponentProps<typeof Markdown>) {
  const source = typeof props.children === 'string' ? props.children : '';
  const open = useMemo(() => openFenceStart(source), [source]);
  const overrides = props.components;
  const components = useMemo(() => ({ a: MessageLink, pre: Pre, table: Table, ...overrides }), [overrides]);
  return (
    <OpenFence.Provider value={open}>
      <Markdown {...props} remarkPlugins={[remarkGfm, ...(props.remarkPlugins || [])]} components={components} />
    </OpenFence.Provider>
  );
}
