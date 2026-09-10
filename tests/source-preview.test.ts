import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceLanguage,sourceTextFile} from '../src/source-language';
import {highlightMessageCode} from '../src/code-highlight';
test('source previews identify languages from file names without guessing plain text',()=>{
  for(const [name,language] of [['build_atlas.py','python'],['src/main.rs','rust'],['C:\\work\\app.go','go'],['Dockerfile','dockerfile'],['README.md','markdown']])assert.equal(sourceLanguage(name),language);
  assert.equal(sourceLanguage('notes.txt'),'');assert.equal(sourceTextFile('.gitignore'),true);assert.equal(sourceTextFile('clip.mp4'),false);
});
test('highlighting escapes source markup and preserves multiline code',()=>{
  const result=highlightMessageCode('from pathlib import Path\nprint("<script>alert(1)</script>")','python',120000);
  assert.match(result.html!,/hljs-keyword/);assert.doesNotMatch(result.html!,/<script>/);assert.match(result.html!,/&lt;script&gt;/);assert.match(result.html!,/\n/);
  assert.equal(highlightMessageCode('x'.repeat(120001),'python',120000).html,undefined);
  assert.equal(highlightMessageCode('<b>plain</b>','').html,undefined);
});
