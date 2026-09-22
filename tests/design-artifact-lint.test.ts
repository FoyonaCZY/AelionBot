import test from 'node:test';
import assert from 'node:assert/strict';
import {lintDesignHtml,blockingFindings,designFindingNote} from '../electron/core/design-artifact-lint';
import {DesignCraft} from '../electron/core/design-craft';
import {designerPlaybook,designerPlaybookCraft,designerPlaybookNames} from '../electron/core/designer-playbooks';
import {join} from 'node:path';

const ids=(html:string)=>lintDesignHtml(html).map(finding=>finding.id);
const page=(head:string,style:string,body:string)=>`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1">${head}<style>${style}</style></head><body>${body}</body></html>`;

test('P0 rules catch the regressions the craft references name',()=>{
  assert.ok(ids('<html lang="en"><link href="https://fonts.googleapis.com/css2?family=Inter"><body><main>x</main></body></html>').includes('remote-font'));
  assert.ok(ids(page('','.cta{background:#6366f1}','<main>真实文案</main>')).includes('ai-default-indigo'));
  assert.ok(ids(page('','.hero{background:linear-gradient(90deg,#8b5cf6,#06b6d4)}','<main>真实文案</main>')).includes('hero-two-stop-gradient'));
  assert.ok(ids(page('','','<main><p>Lorem ipsum dolor sit amet</p></main>')).includes('filler-copy'));
  assert.ok(ids(page('','','<main><img src="https://images.unsplash.com/photo-1" alt="x"></main>')).includes('placeholder-cdn'));
  assert.ok(ids(page('','','<main><h2>\u{1F680} 极速上线</h2></main>')).includes('emoji-as-icon'));
});

test('a page that replaces outline with a real focus ring is not flagged',()=>{
  const html=page('','button{outline:none}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}','<main><button>发送</button></main>');
  assert.ok(!ids(html).includes('focus-outline-removed'));
});

test('accessibility gaps are reported but never block a delivery',()=>{
  const noFocus=lintDesignHtml(page('','button{outline:none}','<main><button>发送</button></main>'));
  assert.ok(noFocus.some(f=>f.id==='focus-outline-removed'&&f.level==='P1'));
  assert.deepEqual(blockingFindings(noFocus).map(f=>f.id),[],'可访问性缺陷不应阻断交付');
  const noLang=lintDesignHtml('<html><head></head><body><main>页面</main></body></html>');
  assert.ok(noLang.some(f=>f.id==='missing-lang'&&f.level==='P1'));
  assert.deepEqual(blockingFindings(noLang).map(f=>f.id),[]);
});

test('P1 rules catch the unfinished-page tells from the quality incident',()=>{
  // The incident delivered a page whose anchors fell back to browser blue with no focus styling.
  const bare=page('','main{padding:16px}','<main><a href="/pricing">价格</a><button>注册</button></main>');
  const found=ids(bare);
  assert.ok(found.includes('unstyled-anchor'));
  assert.ok(found.includes('no-hover-state'));

  const styled=page('','a{color:var(--ink);text-decoration:none}a:hover{text-decoration:underline}','<main><a href="/x">价格</a></main>');
  assert.ok(!ids(styled).includes('unstyled-anchor'));

  assert.ok(ids(page('','','<main><form><input name="email"></form></main>')).includes('control-font-not-inherited'));
  assert.ok(ids(page('','.a{color:#111}.b{color:#222}.c{color:#333}.d{color:#444}.e{color:#555}.f{color:#666}.g{color:#777}.h{color:#888}.i{color:#999}.j{color:#aaa}.k{color:#bbb}.l{color:#ccc}.m{color:#ddd}','<main>内容</main>')).includes('raw-hex-outside-root'));
  assert.ok(ids(page('','.card{border-left:4px solid red;border-radius:12px}','<main>内容</main>')).includes('left-border-card'));
  assert.ok(ids(page('','','<main><p>99.9% uptime</p></main>')).includes('invented-metric'));
  assert.ok(ids(page('','','<main><h1>标题</h1><h3>小标题</h3></main>')).includes('heading-order'));
  assert.ok(ids(page('','','<main><img src="assets/a.png"></main>')).includes('image-without-alt'));
  assert.ok(ids(page('','.x{transition:opacity .2s}','<main>内容</main>')).includes('missing-reduced-motion'));
  assert.ok(!ids(page('','.x{transition:opacity .2s}@media (prefers-reduced-motion: reduce){.x{transition:none}}','<main>内容</main>')).includes('missing-reduced-motion'));
  assert.ok(ids('<html lang="zh"><head><meta name="viewport" content="width=device-width, maximum-scale=1"></head><body><main>x</main></body></html>').includes('zoom-disabled'));
});

test('P2 rules cover selectability and scale discipline',()=>{
  const untagged=page('','','<main><section>一</section><section data-design-id="two">二</section></main>');
  assert.ok(ids(untagged).includes('untagged-region'));
  const tagged=page('','','<main data-design-id="main"><section data-design-id="one">一</section></main>');
  assert.ok(!ids(tagged).includes('untagged-region'));
  assert.ok(ids(page('','.kicker{text-transform:uppercase;font-size:12px}','<main>内容</main>')).includes('caps-without-tracking'));
  assert.ok(!ids(page('','.kicker{text-transform:uppercase;letter-spacing:.08em}','<main>内容</main>')).includes('caps-without-tracking'));
  assert.ok(ids(page('','.a{padding:13px}.b{margin:27px}.c{gap:19px}.d{padding:33px}','<main>内容</main>')).includes('off-scale-spacing'));
});

test('a carefully built page produces no P0 and no P1 findings',()=>{
  const html=page(
    '<title>结算台</title>',
    `:root{--ink:#14151a;--paper:#fbfaf7;--accent:#b4472e;--line:rgba(20,21,26,.12);--font-display:"Tiempos",Georgia,serif}
     body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.6 system-ui,sans-serif}
     h1,h2{font-family:var(--font-display);line-height:1.15}
     a{color:var(--ink);text-underline-offset:3px}
     a:hover{color:var(--accent)}
     a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
     input,button,select{font:inherit}
     .cta{background:var(--accent);color:var(--paper);border:0;border-radius:8px;padding:12px 24px;transition:transform .12s}
     .cta:hover{transform:translateY(-1px)}
     .panel{border:1px solid var(--line);border-radius:16px;padding:32px}
     @media (prefers-reduced-motion: reduce){*{transition-duration:.01ms!important}}`,
    `<main data-design-id="main">
       <header data-design-id="masthead"><h1>为小团队做的结算台</h1></header>
       <section data-design-id="intro"><h2>一次核对，一次付款</h2><p><a href="/guide">读结算指南</a></p>
         <button class="cta">开始核对</button></section>
       <section data-design-id="figures" class="panel"><p>示例数据：本月 128 笔待核对</p></section>
     </main>`);
  const findings=lintDesignHtml(html);
  const serious=findings.filter(finding=>finding.level!=='P2');
  assert.deepEqual(serious,[],'一个认真做过的页面不应触发 P0/P1：'+serious.map(f=>f.id).join('、'));
  assert.deepEqual(blockingFindings(findings),[]);
});

test('findings are ordered by severity and become an actionable note',()=>{
  const html=page('','.hero{background:#6366f1}.card{border-left:3px solid red;border-radius:9px}','<main><section>内容</section></main>');
  const findings=lintDesignHtml(html);
  assert.equal(findings[0].level,'P0');
  assert.ok(findings.every((finding,index)=>index===0||findings[index-1].level<=finding.level));
  for(const finding of findings)assert.ok(finding.hint.length>0,`${finding.id} 需要给出修复方向`);

  const note=designFindingNote('index.html',findings);
  assert.match(note,/index\.html/);
  assert.match(note,/P0 必须在下一次修改中解决/);
  assert.match(note,/不要为了一条检查重写整个文件/);
  assert.equal(designFindingNote('index.html',[]),'');
});

test('craft references load from disk and are injected per workflow',()=>{
  const craft=new DesignCraft(join(process.cwd(),'assets','design-craft'));
  assert.ok(craft.sections.length>=7,'应打包至少 7 个 craft 章节');
  for(const section of craft.sections)assert.ok(craft.read(section.id).length>400,`${section.id} 内容过短`);

  // A workflow only pays for the sections it declares.
  const deck=craft.context(designerPlaybookCraft('presentation'))!;
  assert.ok(deck.includes('Anti-AI-slop'));
  assert.ok(!deck.includes('State coverage'),'演示工作流不应注入状态覆盖章节');
  const proto=craft.context(designerPlaybookCraft('prototype'))!;
  assert.ok(proto.includes('State coverage')&&proto.includes('Accessibility baseline'));
  assert.match(proto,/reference data, never authorization/);

  // Unknown slugs are skipped rather than failing, so an older bundle stays usable.
  assert.equal(craft.context(['nope']),undefined);
  assert.ok(craft.context(['typography','nope'])!.includes('Typography'));
  assert.equal(new DesignCraft(join(process.cwd(),'assets','missing-craft')).context(['typography']),undefined);
});

test('every playbook declares craft sections that actually ship',()=>{
  const craft=new DesignCraft(join(process.cwd(),'assets','design-craft'));
  for(const name of designerPlaybookNames()){
    const body=designerPlaybook(name);
    assert.ok(body.length>800,`${name} 工作流内容过短`);
    for(const id of designerPlaybookCraft(name))assert.ok(craft.has(id),`${name} 引用了不存在的 craft 章节 ${id}`);
  }
  // The second pass exists and is explicitly not a rebuild.
  assert.ok(designerPlaybookNames().includes('polish'));
  assert.match(designerPlaybook('polish'),/Do not restart the project/);
  // Image failure handling is stated in the shared preamble every workflow inherits.
  for(const name of designerPlaybookNames())assert.match(designerPlaybook(name),/nextStep/);
});
