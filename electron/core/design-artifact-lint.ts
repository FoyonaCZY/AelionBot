/**
 * Static design checks for generated HTML. Findings are reported continuously — after every
 * write — so the model can self-correct while building, instead of discovering them at delivery.
 *
 * P0 blocks publication and covers template tells, fake content and external dependencies.
 * P1 and P2 are advisory. Rules mirror the craft references in assets/design-craft so the
 * guidance the model reads and the check it must pass agree.
 */
export type {DesignFinding,DesignFindingLevel} from '../../src/designer-types';
import type {DesignFinding,DesignFindingLevel} from '../../src/designer-types';

const AI_INDIGO=/#(?:6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7)\b/i;
const TWO_STOP=/linear-gradient\([^)]*(?:#(?:6366f1|8b5cf6|7c3aed|a855f7|4f46e5)|rebeccapurple|purple|indigo|violet)[^)]*(?:#(?:3b82f6|06b6d4|0ea5e9|ec4899|22d3ee)|blue|cyan|pink)[^)]*\)/i;
const EMOJI_SET='\\u2728\\u{1F680}\\u{1F3AF}\\u26A1\\u{1F525}\\u{1F4A1}\\u{1F4AA}\\u{1F44D}\\u2705\\u{1F31F}';
const FILLER=/\blorem ipsum\b|placeholder text|your headline here|coming soon\b|feature (?:one|two|three)\b|sample content|示例文案|占位文案/i;
const METRIC=/\b\d{1,3}(?:[×x]\s*(?:faster|better|more)|%\s*(?:uptime|faster))|99\.9+%|\b10x\s+(?:faster|better)/i;
const PLACEHOLDER_CDN=/(?:unsplash\.com|placehold\.co|placekitten\.com|picsum\.photos|via\.placeholder\.com)/i;
const REMOTE_FONT=/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|@import\s+url\s*\(\s*['"]?https?:/i;
const SPACING_SCALE=new Set([0,1,2,4,6,8,10,12,14,16,20,24,28,32,40,48,56,64,72,80,96,112,128,160,192,240,256]);

const strip=(html:string)=>html.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<script[\s\S]*?<\/script>/gi,'');
const styles=(html:string)=>(html.match(/<style[\s\S]*?<\/style>/gi)||[]).map(block=>block.replace(/^<style[^>]*>/i,'').replace(/<\/style>$/i,'')).join('\n');

/** Runs every rule and returns findings ordered by severity. Rule ids are stable so the UI and the model can refer to them. */
export function lintDesignHtml(html:string):DesignFinding[]{
  const findings:DesignFinding[]=[];
  const add=(id:string,level:DesignFindingLevel,message:string,hint:string,craft?:string)=>{if(!findings.some(f=>f.id===id))findings.push({id,level,message,hint,craft});};
  const css=styles(html),body=strip(html),inline=(html.match(/style\s*=\s*"[^"]*"/gi)||[]).join('\n'),allCss=css+'\n'+inline;

  // P0 blocks publication: template tells, fake content, and external dependencies that break offline use.
  // Accessibility and state gaps are P1 — real defects, reported every write, but never a reason to block a delivery.
  if(REMOTE_FONT.test(html))
    add('remote-font','P0','页面引用了远程字体或外部样式表。','使用设计系统 token 中的字体栈，或任务目录 assets/ 里的本地 @font-face。','typography');
  if(AI_INDIGO.test(allCss))
    add('ai-default-indigo','P0','使用了 Tailwind 默认靛蓝/紫作为颜色。','这是最明显的模板化特征。改用设计系统的 var(--accent)。','color');
  if(TWO_STOP.test(allCss))
    add('hero-two-stop-gradient','P0','出现紫蓝/蓝青类双色渐变。','换成纯色块加真实的排版层级，比渐变更有设计感。','anti-ai-slop');
  if(FILLER.test(body))
    add('filler-copy','P0','页面含占位或套话文案。','改成与任务相关的真实文案；版面空是构图问题，不要用假字填充。','anti-ai-slop');
  if(PLACEHOLDER_CDN.test(html))
    add('placeholder-cdn','P0','引用了外部占位图床。','用本地 assets/ 中的真实素材，或 .ph-img 本地占位块。','anti-ai-slop');
  if(new RegExp(`<(?:h[1-6]|button)[^>]*>[^<]*[${EMOJI_SET}]`,'u').test(body)||new RegExp(`class="[^"]*icon[^"]*"[^>]*>\\s*[${EMOJI_SET}]`,'u').test(body))
    add('emoji-as-icon','P0','标题、按钮或图标位置使用了 emoji。','改用 1.5–1.8px 线宽、fill/stroke 取 currentColor 的单色 SVG 图标。','anti-ai-slop');
  if(/outline\s*:\s*(?:none|0)\b/i.test(allCss)&&!/:focus-visible[^{]*\{[^}]*(?:outline|box-shadow)\s*:(?!\s*(?:none|0)\b)/i.test(css))
    add('focus-outline-removed','P1','移除了 outline 但没有补上 :focus-visible 样式。','写 outline:none 的下一条就要给 :focus-visible 补 2px 焦点环，否则键盘用户无法定位。','accessibility-baseline');
  if(!/<html[^>]*\slang\s*=/i.test(html)&&/<html\b/i.test(html))
    add('missing-lang','P1','<html> 缺少 lang 属性。','设置真实语言，例如 <html lang="zh-CN">。','accessibility-baseline');

  // More P1 — real defects that should be fixed before calling the work done.
  const anchors=body.match(/<a\b[^>]*href=[^>]*>/gi)||[];
  if(anchors.length&&!/(?:^|[\s,{])a\s*(?:[:.[][^{]*)?\{/im.test(css)&&!/\ba\s*,/.test(css))
    add('unstyled-anchor','P1','没有为 <a> 写样式，链接会落回浏览器默认蓝色下划线。','显式设置链接颜色、下划线与 hover/focus-visible 状态。','state-coverage');
  if(/<(?:button|a)\b/i.test(body)&&!/:hover/i.test(css))
    add('no-hover-state','P1','可点击元素没有 hover 状态。','给按钮和链接补 hover 的背景、边框或 1px 位移反馈。','state-coverage');
  if(/<(?:input|textarea|select)\b/i.test(body)&&!/(?:input|textarea|select)[^{]*\{[^}]*font(?:-family)?\s*:/i.test(css))
    add('control-font-not-inherited','P1','表单控件没有继承页面字体。','浏览器默认把 input/button/select 设为系统字体，显式写 font-family:inherit。','typography');
  const rawHex=(css.replace(/:root\s*\{[\s\S]*?\}/g,'').match(/#[0-9a-fA-F]{3,8}\b/g)||[]).length;
  if(rawHex>12)
    add('raw-hex-outside-root','P1',`:root 之外有 ${rawHex} 处原始色值。`,'把颜色收进 token，派生色用 color-mix() 而不是手写新的 hex。','color');
  const accent=(body.match(/var\(--accent\)/g)||[]).length+(inline.match(/var\(--accent\)/g)||[]).length;
  if(accent>6)
    add('accent-overused','P1',`正文里 var(--accent) 出现 ${accent} 次。`,'强调色每屏最多两处可见用法；超过之后三处都不再是重点。','color');
  if(/border-left\s*:\s*\d+px\s+solid/i.test(css)&&/border-radius\s*:\s*[1-9]/i.test(css))
    add('left-border-card','P1','圆角卡片配左侧色条是典型模板写法。','去掉左边强调，或改成全边细线。','anti-ai-slop');
  if(METRIC.test(body))
    add('invented-metric','P1','页面出现了未标注来源的量化指标。','引用用户提供的真实数据，或在界面上明确标注为示例。','anti-ai-slop');
  if(/<h3\b/i.test(body)&&!/<h2\b/i.test(body))
    add('heading-order','P1','标题层级跳级（出现 h3 但没有 h2）。','标题级别要逐级下降，视觉大小用 CSS 控制，不要靠跳级实现。','accessibility-baseline');
  const images=body.match(/<img\b[^>]*>/gi)||[];
  if(images.some(tag=>!/\salt\s*=/i.test(tag)))
    add('image-without-alt','P1','有 <img> 缺少 alt。','有意义的图写描述性 alt，纯装饰图写 alt=""。','accessibility-baseline');
  if(!/<meta[^>]+name=["']viewport["']/i.test(html)&&/<head\b/i.test(html))
    add('missing-viewport-meta','P1','缺少 viewport meta，窄屏会按桌面宽度缩放。','加 <meta name="viewport" content="width=device-width, initial-scale=1">。','layout-rhythm');
  if(/(?:transition|animation)\s*:/i.test(css)&&!/prefers-reduced-motion/i.test(css))
    add('missing-reduced-motion','P1','使用了过渡或动画但没有 prefers-reduced-motion 兜底。','在样式表末尾加 @media (prefers-reduced-motion: reduce) 把动效降到近似为零。','motion-discipline');
  if(/maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i.test(html))
    add('zoom-disabled','P1','禁用了页面缩放。','移除 maximum-scale=1 与 user-scalable=no。','accessibility-baseline');

  // P2 — polish.
  const sections=html.match(/<(?:section|article|header|footer|nav|aside|main)\b[^>]*>/gi)||[];
  const tagged=sections.filter(tag=>/data-(?:design|od)-id\s*=/.test(tag)).length;
  if(sections.length&&tagged<sections.length)
    add('untagged-region','P2',`有 ${sections.length-tagged} 个区块缺少 data-design-id。`,'给每个有意义的区块加唯一 data-design-id，预览框选和批注才能对准。','layout-rhythm');
  if(/\bh[1-3]\b[^{]*\{[^}]*font-family\s*:\s*[^;]*(?:Inter|Roboto|Arial|Helvetica|system-ui)/i.test(css)&&/--font-display/.test(css))
    add('display-font-substituted','P1','设计系统提供了 display 字体，但标题写死成了别的字体。','标题使用 var(--font-display)。','typography');
  const caps=css.match(/text-transform\s*:\s*uppercase[^}]*\}/gi)||[];
  if(caps.length&&caps.some(block=>!/letter-spacing/i.test(block)))
    add('caps-without-tracking','P2','全大写文本没有加字距。','全大写始终需要 ≥0.06em 的 letter-spacing，否则字挤在一起。','typography');
  const radii=[...new Set((css.match(/border-radius\s*:\s*(\d+)px/gi)||[]).map(v=>v.replace(/\D/g,'')))];
  if(radii.length===1&&sections.length>3&&Number(radii[0])>0)
    add('uniform-radius','P2','整页只用了一个圆角值。','按元素尺寸分层：小控件小圆角，大面板大圆角。','layout-rhythm');
  const offScale=[...new Set((css.match(/(?:margin|padding|gap)[^:]*:\s*([^;}]+)/gi)||[]).flatMap(rule=>(rule.match(/\b(\d+)px/g)||[]).map(v=>Number(v.replace('px','')))))].filter(value=>!SPACING_SCALE.has(value));
  if(offScale.length>3)
    add('off-scale-spacing','P2',`间距使用了 ${offScale.length} 个不在标准阶上的值（如 ${offScale.slice(0,3).join('、')}px）。`,'统一到一套间距阶：4/8/12/16/24/32/48/64/96。','layout-rhythm');

  const order:Record<DesignFindingLevel,number>={P0:0,P1:1,P2:2};
  return findings.sort((a,b)=>order[a.level]-order[b.level]);
}

export const blockingFindings=(findings:DesignFinding[])=>findings.filter(finding=>finding.level==='P0');

/** One-line-per-finding note appended to history after a write, so the model can self-correct mid-build. */
export function designFindingNote(path:string,findings:DesignFinding[]){
  if(!findings.length)return '';
  const lines=findings.map(finding=>`${finding.level} ${finding.id}：${finding.message} ${finding.hint}`);
  return `设计检查（${path}）：\n${lines.join('\n')}\nP0 必须在下一次修改中解决。用聚焦补丁修复，不要为了一条检查重写整个文件。`;
}
