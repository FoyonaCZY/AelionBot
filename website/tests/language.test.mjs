import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSiteLanguage} from '../src/locale.mjs';
import {renderBlogDocument} from '../blog/render.mjs';
import {blogLabels,blogText} from '../src/blog/labels.mjs';

test('English is the first visit default; explicit links override saved language',()=>{
  assert.equal(resolveSiteLanguage(),'en');
  assert.equal(resolveSiteLanguage('?lang=invalid','invalid'),'en');
  assert.equal(resolveSiteLanguage('','zh-CN'),'zh-CN');
  assert.equal(resolveSiteLanguage('?lang=en','zh-CN'),'en');
  assert.equal(resolveSiteLanguage('?lang=zh-TW','en'),'zh-TW');
});

test('blog shell renders in English without JavaScript and offers Chinese',()=>{
  const html=renderBlogDocument({template:'<title>__BLOG_TITLE__</title>__BLOG_CONTENT__',site:{origin:'https://aelion.chat',repository:'https://github.com/FoyonaCZY/AelionBot',navigation:[{label:'博客',href:'/blog/'}]},logo:'/logo.svg',posts:[]});
  assert.match(html,/<title>Blog — AelionBot<\/title>/);
  assert.match(html,/Latest stories/);assert.match(html,/value="zh-CN"/);
  for(const key of Object.keys(blogLabels))for(const language of ['en','zh-CN','zh-TW'])assert.ok(blogText(key,language,3).length>0);
});
