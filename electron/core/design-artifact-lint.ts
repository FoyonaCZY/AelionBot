/** Static HTML checks inspired by OpenDesign lint-artifact.ts at d465086. Findings are local; they do not run OpenDesign. */
export function lintDesignHtml(html:string){
  const blocking:string[]=[],warnings:string[]=[];
  if(/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net/i.test(html)||/@import\s+url\s*\(\s*['"]?https?:/i.test(html))
    blocking.push('不要引用远程字体或外部样式表。使用设计系统 token 中的字体栈，或任务目录 assets/ 里的本地 @font-face。');
  if(/\blorem ipsum\b|placeholder text|your headline here|coming soon\b/i.test(html))
    blocking.push('页面含套话或占位文案。请改成与任务相关的真实文案，或删掉空段落。');
  const style=html.match(/<style[\s\S]*?<\/style>/gi)?.join('\n')||'';
  const cssWithoutRoot=style.replace(/:root\s*\{[\s\S]*?\}/g,'');
  const hexes=cssWithoutRoot.match(/#[0-9a-fA-F]{3,8}\b/g)||[];
  if(hexes.length>12)warnings.push(`:root 外有 ${hexes.length} 处原始色值，可能没有使用设计 token。`);
  const body=html.replace(/<style[\s\S]*?<\/style>/gi,'');
  const accent=(body.match(/var\(--accent\)/g)||[]).length;
  if(accent>6)warnings.push(`正文里 var(--accent) 出现 ${accent} 次，accent 可能用得过多。`);
  const sections=html.match(/<section\b[^>]*>/gi)||[];
  if(sections.length&&sections.filter(tag=>/data-design-id\s*=|data-od-id\s*=/.test(tag)).length<sections.length)
    warnings.push('有 section 缺少 data-design-id，预览框选会很难对准。');
  if(/\bh[1-3]\s*\{[^}]*font-family\s*:\s*[^;]*(Inter|Roboto|Arial|system-ui)/i.test(html)&&!/var\(--(?:od-)?font-display\)/.test(html))
    warnings.push('标题没有使用 var(--font-display)，可能偏离所选设计系统。');
  if(/border-left\s*:\s*\d+px\s+solid/i.test(html)&&/border-radius\s*:\s*[1-9]/i.test(html))
    warnings.push('圆角卡片加左侧色条是常见套模板写法，请改成全边细线或去掉左边强调。');
  return {blocking,warnings};
}
