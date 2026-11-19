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
 * Where a fence that is still open at the end of the text starts, or Infinity, along with the starting offsets of
 * every ```widget fence in the source so multiple widgets in one reply get stable indices.
 */
function scanFences(markdown: string) {
  let open = -1,
    marker = '',
    offset = 0;
  const widgetOffsets: number[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    if (match) {
      const fence = match[1];
      if (open < 0) {
        open = offset;
        marker = fence;
        const lang = match[2].trim().split(/\s+/)[0];
        if (lang === 'widget') widgetOffsets.push(offset);
      } else if (fence[0] === marker[0] && fence.length >= marker.length && !line.trim().slice(fence.length)) {
        open = -1;
      }
    }
    offset += line.length + 1;
  }
  return { open: open < 0 ? Infinity : open, widgetOffsets };
}

const FenceScan = createContext<{ open: number; widgetOffsets: number[] }>({ open: Infinity, widgetOffsets: [] });

/** Code blocks, except visual fences, which show what they describe. Stable, so a widget is not reloaded. */
function Pre(pre: ComponentProps<'pre'> & ExtraProps) {
  const { open, widgetOffsets } = useContext(FenceScan);
  const child = Children.toArray(pre.children)[0],
    code = isValidElement<ComponentProps<'code'>>(child) ? child.props : undefined,
    language = /\blanguage-([^\s]+)/.exec(code?.className || '')?.[1] || '';
  if (VISUAL_FENCES.includes(language) && typeof code?.children === 'string') {
    const startOffset = pre.node?.position?.start.offset ?? -1;
    let widgetIndex = 0;
    if (language === 'widget' && startOffset >= 0 && widgetOffsets.length > 1) {
      const found = widgetOffsets.indexOf(startOffset);
      widgetIndex = found >= 0 ? found : widgetOffsets.filter((pos) => pos < startOffset).length;
    }
    return (
      <MessageVisual
        language={language}
        source={code.children}
        pending={startOffset >= open}
        widgetIndex={widgetIndex}
      />
    );
  }
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
  const scan = useMemo(() => scanFences(source), [source]);
  const overrides = props.components;
  const components = useMemo(() => ({ a: MessageLink, pre: Pre, table: Table, ...overrides }), [overrides]);
  return (
    <FenceScan.Provider value={scan}>
      <Markdown {...props} remarkPlugins={[remarkGfm, ...(props.remarkPlugins || [])]} components={components} />
    </FenceScan.Provider>
  );
}
