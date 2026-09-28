import { useEffect, useState } from 'react';
import type {
  EditorCommand,
  EditorResult,
  PreviewElement,
  PreviewTreeNode,
} from '../../shared/types/preview-editor-types';
import { PreviewPicker } from './PreviewPicker';
import { PreviewIcon } from './PreviewIcon';
import { useI18n } from '../i18n';
import { translate } from '../../shared/i18n';
import './web-element-inspector.css';
type Command = (command: EditorCommand) => Promise<EditorResult>;
function color(value: string) {
  const parts = value.match(/[\d.]+/g);
  return !parts || parts.length < 3 || (parts.length === 4 && Number(parts[3]) === 0)
    ? '#ffffff'
    : '#' +
        parts
          .slice(0, 3)
          .map((n) => Math.round(Number(n)).toString(16).padStart(2, '0'))
          .join('');
}
function TreeBranch({
  id,
  command,
  selected,
  depth = 0,
}: {
  id?: string;
  command: Command;
  selected?: string;
  depth?: number;
}) {
  const [nodes, setNodes] = useState<PreviewTreeNode[]>([]),
    [open, setOpen] = useState<Record<string, boolean>>({}),
    [more, setMore] = useState(false),
    [error, setError] = useState('');
  const load = (offset = 0) =>
    void command({ type: 'children', id, offset })
      .then((result) => {
        setNodes((old) => (offset ? [...old, ...(result.nodes || [])] : result.nodes || []));
        setMore(Boolean(result.more));
      })
      .catch((error) => setError(error.message));
  useEffect(() => {
    load();
  }, [id]);
  return (
    <div className="web-element-tree-branch">
      {error && <p role="alert">{error}</p>}
      {nodes.map((node) => (
        <div key={node.id}>
          <div className="web-element-tree-row" style={{ paddingLeft: Math.min(depth, 12) * 10 }}>
            <button
              disabled={!node.hasChildren}
              aria-label={translate(open[node.id] ? '收起子元素' : '展开子元素')}
              aria-expanded={open[node.id] || false}
              onClick={() => setOpen((old) => ({ ...old, [node.id]: !old[node.id] }))}
            >
              {node.hasChildren ? <PreviewIcon name={open[node.id] ? 'minus' : 'right'} /> : null}
            </button>
            <button
              aria-current={selected === node.id ? 'true' : undefined}
              title={node.label}
              onClick={() => void command({ type: 'select', id: node.id }).catch((e) => setError(e.message))}
            >
              {node.label}
            </button>
          </div>
          {open[node.id] && <TreeBranch id={node.id} command={command} selected={selected} depth={depth + 1} />}
        </div>
      ))}
      {more && <button onClick={() => load(nodes.length)}>{translate('更多元素')}</button>}
    </div>
  );
}
export function WebElementInspector({
  selected,
  command,
  busy,
  onClose,
  initialTab = 'style',
  errorMessage,
  onSendChanges,
}: {
  errorMessage?: string;
  onSendChanges?: () => void;
  initialTab?: 'style' | 'attrs' | 'html' | 'tree';
  selected?: PreviewElement;
  command: Command;
  busy: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [tab, setTab] = useState<'style' | 'attrs' | 'html' | 'tree'>(initialTab),
    [fields, setFields] = useState<Record<string, string>>({}),
    [attrs, setAttrs] = useState<Array<[string, string]>>([]),
    [text, setText] = useState(''),
    [html, setHtml] = useState(''),
    [css, setCss] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    setFields(selected?.styles || {});
    setAttrs(Object.entries(selected?.attributes || {}));
    setText(selected?.text || '');
    setHtml(selected?.html || '');
    setCss(selected?.styles.cssText || '');
    setError('');
  }, [selected?.id, selected?.html]);
  useEffect(() => setTab(initialTab), [initialTab]);
  const fontOptions = [
    { value: 'system-ui, sans-serif', label: t('系统默认') },
    { value: '"Microsoft YaHei", sans-serif', label: t('微软雅黑') },
    { value: '"Noto Sans SC", sans-serif', label: t('思源黑体') },
    { value: 'Georgia, "Noto Serif SC", serif', label: t('衬线字体') },
    { value: 'Arial, sans-serif', label: 'Arial' },
    { value: '"JetBrains Mono", Consolas, monospace', label: t('等宽字体') },
  ];
  const fontValue = fields['font-family'] || '';
  const applyField = (name: string) => {
    let value = (fields[name] || '').trim();
    if (
      ['font-size', 'width', 'height', 'padding', 'margin', 'letter-spacing'].includes(name) &&
      /^-?(?:\d+\.?\d*|\.\d+)$/.test(value)
    )
      value += 'px';
    if (value !== selected?.styles[name]) void act({ type: 'style', values: { [name]: value } });
  };
  const act = async (value: EditorCommand) => {
    setError('');
    try {
      await command(value);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return (
    <aside className={`web-element-inspector ${tab === 'html' ? 'is-code' : ''}`} aria-label={t('网页元素编辑')}>
      <header>
        <strong title={selected?.label}>{selected?.label || t('页面结构')}</strong>
        {selected?.parentId && (
          <button aria-label={t('选择父级')} title={t('选择父级')} onClick={() => void act({ type: 'parent' })}>
            <PreviewIcon name="left" />
          </button>
        )}
        <button aria-label={t('关闭面板')} onClick={onClose}>
          <PreviewIcon name="close" />
        </button>
      </header>
      {selected && (
        <div className="web-element-path" title={selected.path.join(' > ')}>
          {selected.path.map((p) => p.replace(/:\d+$/, '')).join(' › ')}
        </div>
      )}
      <nav aria-label={t('编辑分类')}>
        {(['style', 'attrs', 'html', 'tree'] as const).map((key) => (
          <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
            {{ style: t('样式'), attrs: t('属性'), html: 'HTML', tree: t('结构') }[key]}
          </button>
        ))}
      </nav>
      <fieldset disabled={busy}>
        {tab === 'tree' ? (
          <div className="web-element-tree">
            <TreeBranch command={command} selected={selected?.id} />
          </div>
        ) : !selected ? (
          <p className="web-element-hint">{t('点选网页中的任意元素，或从结构中选择。')}</p>
        ) : tab === 'style' ? (
          <>
            {selected.leaf && (
              <label className="web-element-text-label">
                {t('文字')}
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onBlur={() => {
                    if (text !== selected.text) void act({ type: 'text', value: text });
                  }}
                />
              </label>
            )}
            <p className="web-element-hint web-element-manipulation-hint">
              {t('拖动选中元素或蓝色标签移动，拖动边角调整大小。')}
            </p>
            <div className="web-element-font">
              <span>{t('字体')}</span>
              <PreviewPicker
                label={t('选择字体')}
                value={fontValue}
                options={[
                  ...(!fontOptions.some((f) => f.value === fontValue)
                    ? [{ value: fontValue, label: t('当前字体') }]
                    : []),
                  ...fontOptions,
                ]}
                onChange={(value) => {
                  setFields((old) => ({ ...old, 'font-family': value }));
                  void act({ type: 'style', values: { 'font-family': value } });
                }}
              />
              <input
                aria-label={t('自定义字体')}
                placeholder={t('输入字体名称或字体栈')}
                value={fontValue}
                onChange={(e) => setFields((old) => ({ ...old, 'font-family': e.target.value }))}
                onBlur={() => applyField('font-family')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <small>{t('使用网页已加载或电脑已安装的字体。')}</small>
            </div>
            <div className="web-element-fields">
              {[
                ['font-size', t('字号')],
                ['font-weight', t('字重')],
                ['line-height', t('行高')],
                ['letter-spacing', t('字间距')],
                ['color', t('文字颜色')],
                ['background-color', t('背景')],
                ['width', t('宽度')],
                ['height', t('高度')],
                ['padding', t('内边距')],
                ['margin', t('外边距')],
              ].map(([name, label]) => (
                <label key={name}>
                  {label}
                  <input
                    type={name.includes('color') ? 'color' : 'text'}
                    value={name.includes('color') ? color(fields[name] || '') : fields[name] || ''}
                    onChange={(e) => setFields((old) => ({ ...old, [name]: e.target.value }))}
                    onBlur={() => applyField(name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                </label>
              ))}
            </div>
            <details>
              <summary>{t('完整 CSS')}</summary>
              <textarea
                className="web-element-code"
                spellCheck={false}
                value={css}
                onChange={(e) => setCss(e.target.value)}
              />
              <footer>
                <button onClick={() => void act({ type: 'css', value: css })}>{t('应用 CSS')}</button>
              </footer>
            </details>
          </>
        ) : tab === 'attrs' ? (
          <>
            <div className="web-element-attributes">
              {attrs.map(([name, value], i) => (
                <div key={i}>
                  <input
                    aria-label={t('属性名')}
                    value={name}
                    onChange={(e) => setAttrs((old) => old.map((row, j) => (j === i ? [e.target.value, row[1]] : row)))}
                  />
                  <input
                    aria-label={t('属性值')}
                    value={value}
                    onChange={(e) => setAttrs((old) => old.map((row, j) => (j === i ? [row[0], e.target.value] : row)))}
                  />
                  <button aria-label={t('删除属性')} onClick={() => setAttrs((old) => old.filter((_, j) => j !== i))}>
                    <PreviewIcon name="close" />
                  </button>
                </div>
              ))}
            </div>
            <button className="web-element-add" onClick={() => setAttrs((old) => [...old, ['', '']])}>
              + {t('添加属性')}
            </button>
            <footer>
              <button
                onClick={() =>
                  void act({ type: 'attributes', values: Object.fromEntries(attrs.filter(([name]) => name.trim())) })
                }
              >
                {t('应用属性')}
              </button>
            </footer>
          </>
        ) : (
          <>
            <textarea
              className="web-element-code is-html"
              value={html}
              readOnly={selected.truncated}
              maxLength={1_048_576}
              spellCheck={false}
              onChange={(e) => setHtml(e.target.value)}
            />
            {selected.truncated && <p>{t('元素较大，请使用源码编辑。')}</p>}
            <footer>
              <button onClick={() => void act({ type: 'revert-preview' })}>{t('撤回预览')}</button>
              <button
                disabled={selected.truncated}
                onClick={() => void act({ type: 'html', value: html, preview: true })}
              >
                {t('预览')}
              </button>
              <button disabled={selected.truncated} onClick={() => void act({ type: 'html', value: html })}>
                {t('应用 HTML')}
              </button>
            </footer>
          </>
        )}
      </fieldset>
      {(error || errorMessage) && (
        <div className="web-element-error" role="alert">
          {error || errorMessage}
          {errorMessage && onSendChanges && <button onClick={onSendChanges}>{t('把修改发给 Bot')}</button>}
        </div>
      )}
    </aside>
  );
}
