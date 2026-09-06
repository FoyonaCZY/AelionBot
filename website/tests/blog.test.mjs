import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {parsePost,loadPosts,renderMarkdown} from '../blog/content.mjs';
import {renderBlogDocument} from '../blog/render.mjs';
import {writeBlogPages} from '../blog/publish.mjs';

const fixtureRoot=resolve('.local/blog-tests');mkdirSync(fixtureRoot,{recursive:true});
const site={origin:'https://aelion.chat',repository:'https://github.com/FoyonaCZY/AelionBot',navigation:[{label:'博客',href:'/blog/',external:false}]};
const template='<html><title>__BLOG_TITLE__</title><meta name="description" content="__BLOG_DESCRIPTION__"><meta name="robots" content="__BLOG_ROBOTS__"><link rel="canonical" href="__BLOG_CANONICAL__"><body>__BLOG_CONTENT__</body></html>';
const article=(extra='draft: false',body='## 开始\n\n一篇技术笔记。')=>`---\ntitle: 测试文章\ndescription: 关于实现的笔记\ndate: "2026-09-06"\n${extra}\n---\n${body}`;
function temporary(t){const directory=mkdtempSync(join(fixtureRoot,'case-'));t.after(()=>{const target=resolve(directory);assert.ok(target.startsWith(fixtureRoot+sep));rmSync(target,{recursive:true,force:true});});return directory;}

test('publication is explicit, and local draft preview does not imply publication',()=>{
  assert.equal(parsePost(article('draft: true'),'draft.md'),null);
  assert.equal(parsePost(article(''),'draft.md'),null);
  const preview=parsePost(article('draft: true'),'draft.md',{includeDrafts:true});assert.equal(preview.draft,true);
  assert.throws(()=>parsePost(article('draft: "false"'),'draft.md'),/draft/);
  assert.equal(parsePost(article(),'published.md').url,'/blog/published/');
});

test('invalid dates, paths, missing metadata and duplicate public routes stop a build',t=>{
  assert.throws(()=>parsePost(article().replace('2026-09-06','2026-02-30'),'bad.md'),/date/);
  assert.throws(()=>parsePost(article('draft: false\nslug: ../escape'),'bad.md'),/slug/);
  assert.throws(()=>parsePost(article().replace('title: 测试文章','title: ""'),'bad.md'),/title/);
  assert.throws(()=>parsePost(article('draft: false',''),'bad.md'),/正文/);
  const directory=temporary(t);writeFileSync(join(directory,'first.md'),article('draft: false\nslug: same'));writeFileSync(join(directory,'second.md'),article('draft: false\nslug: same'));
  assert.throws(()=>loadPosts(directory),/slug 重复/);
});

test('public entries are sorted by date and carry author, tags and reading metadata',t=>{
  const directory=temporary(t);
  writeFileSync(join(directory,'older.md'),article('draft: false\nauthor: Foyona\ntags: [Agent, Agent, 开发]').replace('2026-09-06','2026-08-06'));
  writeFileSync(join(directory,'newer.md'),article());writeFileSync(join(directory,'draft.md'),article('draft: true','DRAFT_BODY_NOT_FOR_SITE'));
  const posts=loadPosts(directory);assert.deepEqual(posts.map(post=>post.slug),['newer','older']);
  assert.deepEqual(posts[1].tags,['Agent','开发']);assert.equal(posts[1].author,'Foyona');assert.ok(posts[0].readingMinutes>=1);
});

test('Markdown supports highlighted code, tables and unique heading anchors while escaping raw HTML',()=>{
  const result=renderMarkdown('## One\n\n## One\n\n## One-2\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n```javascript\nconst answer = 42;\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))');
  assert.deepEqual(result.toc.map(item=>item.id),['one','one-2','one-2-2']);
  assert.match(result.html,/<table>/);assert.match(result.html,/hljs-number/);assert.match(result.html,/data-copy-code/);
  assert.doesNotMatch(result.html,/<script>/);assert.doesNotMatch(result.html,/href="javascript:/);
  assert.match(renderMarkdown('```unknown-language\n<tag> & value\n```').html,/&lt;tag&gt; &amp; value/);
});

test('metadata is escaped, and a draft requested as a public article renders a noindex 404',()=>{
  const post=parsePost(article('draft: false\nslug: escape'),'escape.md');post.title='A <script> & "quote"';
  const html=renderBlogDocument({template,site,logo:'/logo.svg',posts:[post],post});
  assert.match(html,/<title>A &lt;script&gt; &amp; &quot;quote&quot;/);assert.match(html,/https:\/\/aelion.chat\/blog\/escape\//);
  const draft={...post,draft:true,title:'DRAFT_TITLE_NOT_FOR_SITE'};
  const hidden=renderBlogDocument({template,site,logo:'/logo.svg',posts:[draft],post:draft});
  assert.doesNotMatch(hidden,/DRAFT_TITLE_NOT_FOR_SITE/);assert.match(hidden,/noindex/);
  const preview=renderBlogDocument({template,site,logo:'/logo.svg',posts:[],post:draft,preview:true});assert.match(preview,/本地草稿预览/);assert.match(preview,/noindex/);
});

test('the publishing output includes permanent article URLs and sitemap, with no draft output',t=>{
  const output=temporary(t),post=parsePost(article('draft: false\nslug: first-note'),'first.md');
  const draft=parsePost(article('draft: true\nslug: unpublished','DRAFT_BODY_NOT_FOR_SITE'),'draft.md',{includeDrafts:true});
  assert.equal(writeBlogPages({output,template,site,logo:'/logo.svg',posts:[draft,post]}),1);
  assert.ok(existsSync(join(output,'blog/first-note/index.html')));assert.equal(existsSync(join(output,'blog/unpublished')),false);
  const index=readFileSync(join(output,'blog/index.html'),'utf8');assert.match(index,/\/blog\/first-note\//);assert.doesNotMatch(index,/unpublished|DRAFT_BODY_NOT_FOR_SITE/);
  const sitemap=readFileSync(join(output,'sitemap.xml'),'utf8');assert.match(sitemap,/https:\/\/aelion.chat\/blog\/first-note\//);assert.doesNotMatch(sitemap,/unpublished/);
  assert.match(readFileSync(join(output,'404.html'),'utf8'),/noindex/);
});
