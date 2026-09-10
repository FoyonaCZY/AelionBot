import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transform} from 'lightningcss';
import postcss from 'postcss';

test('production CSS defines light-dark fallback flags for the application in both themes',()=>{
  // Vite's production CSS target can lower light-dark() even though Electron
  // supports it. Inline JS colorScheme alone cannot initialize these flags.
  const source=['src/fonts.css','src/style.css','src/theme.css'].map(path=>readFileSync(path,'utf8').replace(/^@import[^;]+;/gm,'')).join('\n');
  const compiled=transform({filename:'app.css',code:Buffer.from(source),minify:true,targets:{chrome:110<<16}}).code.toString();
  const css=postcss.parse(compiled);
  const declarations=(selector:string)=>{const values=new Map<string,string>();css.walkRules(rule=>{if(rule.selector===selector)rule.nodes.forEach(node=>{if(node.type==='decl')values.set(node.prop,node.value);});});return values;};
  const light=declarations(':root'),dark=new Map([...light,...declarations(':root[data-theme=dark]')]);
  for(const [mode,values] of [['light',light],['dark',dark]] as const){
    assert.equal(values.get('color-scheme'),mode);
    assert.equal(values.get(`--lightningcss-${mode}`),'initial');
    assert.equal(values.get(`--lightningcss-${mode==='light'?'dark':'light'}`)?.trim(),'');
    const ink=values.get('--text-ink');assert.ok(ink);
    const resolved=ink.replace(/var\(--lightningcss-(light|dark),([^()]+)\)/g,(_,key,fallback)=>values.get(`--lightningcss-${key}`)==='initial'?fallback:'');
    assert.match(resolved.trim(),/^#[a-f\d]{3,8}$/i,'Text color must resolve to one color, not two concatenated colors');
  }
});
