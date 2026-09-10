import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import ini from 'highlight.js/lib/languages/ini';
import markdown from 'highlight.js/lib/languages/markdown';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import makefile from 'highlight.js/lib/languages/makefile';

for(const [name,grammar] of Object.entries({bash,css,diff,javascript,json,powershell,python,sql,typescript,xml,yaml,c,cpp,csharp,go,java,rust,ruby,php,ini,markdown,dockerfile,makefile}))hljs.registerLanguage(name,grammar);
hljs.registerAliases(['jsx'],{languageName:'javascript'});
hljs.registerAliases(['tsx'],{languageName:'typescript'});

export function highlightMessageCode(code:string,language='',maxCharacters=30_000):{label:string;html?:string}{
  const name=language.toLowerCase(),grammar=hljs.getLanguage(name);
  const label=grammar?.name||language||'纯文本';
  // Avoid guessing languages or repeatedly parsing very large streaming blocks.
  if(!grammar||code.length>Math.min(maxCharacters,120_000))return {label};
  try{return {label,html:hljs.highlight(code,{language:name,ignoreIllegals:true}).value};}
  catch{return {label};}
}
