import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { inTempDir, tempDir } from './helpers';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import type { Completion, ModelClient, ToolDefinition } from '../electron/core/model/model';
import type { Embedder } from '../electron/core/memory/memory-embedder';
import type { WireMessage } from '../shared/types/core';
import { KNOWLEDGE_FILE_LIMIT } from '../shared/types/knowledge-types';
import { documentKind, extractSections, type PdfAssetReader } from '../electron/core/knowledge/knowledge-extract';
import { runIndexJob } from '../electron/core/knowledge/knowledge-indexer';
import { scanSources } from '../electron/core/knowledge/knowledge-scan';
import { KnowledgeService, type IndexRunner } from '../electron/core/knowledge/knowledge-service';
import { KnowledgeStore } from '../electron/core/knowledge/knowledge-store';
import { chunkSections, textWeight } from '../electron/core/knowledge/knowledge-text';

const pdfAssets: PdfAssetReader = async (folder, name) =>
  new Uint8Array(readFileSync(resolve('node_modules/pdfjs-dist', folder, name)));

/** A one-page-per-line PDF in the standard Helvetica font. */
function pdf(pages: string[][]) {
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((lines, index) => {
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join(' ')} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
const office = (files: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))));

/** Vectors by topic: texts about the same thing point the same way, whatever their words. */
function topicEmbedder(topics: Record<string, RegExp>): Embedder & { calls: string[][] } {
  const names = Object.keys(topics);
  return {
    model: 'test-model',
    calls: [],
    ready: () => true,
    async embed(texts: string[]) {
      this.calls.push(texts);
      return texts.map((text) => {
        const vector = new Float32Array(names.length + 1);
        names.forEach((name, index) => {
          if (topics[name].test(text)) vector[index] = 1;
        });
        if (!vector.some(Boolean)) vector[names.length] = 1;
        const norm = Math.hypot(...vector);
        return vector.map((value) => value / norm);
      });
    },
  };
}
/** Indexes in place, as the indexing thread would. */
function inPlaceRunner(dbPath: string): IndexRunner & { passes: number; read: number } {
  let store: KnowledgeStore | undefined;
  return {
    passes: 0,
    read: 0,
    async run(job, progress, signal) {
      store ||= new KnowledgeStore(dbPath);
      this.passes++;
      const outcome = await runIndexJob(store, job, { progress, pdfAssets }, signal);
      this.read += outcome.read;
      return outcome;
    },
    close() {
      store?.close();
      store = undefined;
    },
  };
}
function service(t: test.TestContext, options: { embedder?: Embedder; recheckMs?: number } = {}) {
  let changes = 0;
  // Closed before its folder is removed: the index and the app state are open files in it.
  const f = inTempDir(t, (dir) => {
    const store = new Store(join(dir, 'data')),
      dbPath = join(dir, 'data', 'knowledge.sqlite'),
      runner = inPlaceRunner(dbPath),
      knowledge = new KnowledgeService({ store, dbPath, runner, changed: () => changes++, ...options });
    return {
      dir,
      docs: join(dir, 'docs'),
      store,
      knowledge,
      runner,
      close() {
        void knowledge.close();
        store.close();
      },
    };
  });
  mkdirSync(f.docs, { recursive: true });
  const write = (name: string, text: string | Buffer) => {
    const path = join(f.docs, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  return { ...f, write, bot: f.store.data.bots[0], changes: () => changes };
}

test('passages follow headings, stay near their size and repeat a little of what came before', () => {
  const paragraph = (label: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${label}第 ${index + 1} 句讲的是同一件事情的一个方面。`).join('');
  const chunks = chunkSections([
    { heading: ['手册', '安装'], line: 3, text: `${paragraph('安装', 12)}\n\n${paragraph('配置', 12)}` },
    { heading: ['手册', '排错'], line: 40, text: paragraph('排错', 30) },
    { heading: ['手册', '附录'], line: 80, text: '很短的一节。' },
  ]);
  assert.ok(chunks.length >= 4, String(chunks.length));
  assert.equal(chunks[0].heading, '手册 › 安装');
  assert.equal(chunks[0].line, 3);
  for (const chunk of chunks) assert.ok(textWeight(chunk.text) <= 360 * 1.5, String(textWeight(chunk.text)));
  const troubleshooting = chunks.filter((chunk) => chunk.heading === '手册 › 排错');
  assert.ok(troubleshooting.length >= 2);
  // The second passage of a long section starts with the end of the first.
  const carried = troubleshooting[1].text.split('。')[0];
  assert.ok(troubleshooting[0].text.includes(carried), carried);
  assert.ok(chunks.some((chunk) => chunk.text.includes('很短的一节')));
  assert.deepEqual(
    chunkSections([{ heading: ['手册'], text: paragraph('甲', 40) }]),
    chunkSections([{ heading: ['手册'], text: paragraph('甲', 40) }]),
  );
});

test('passages carry the page they are on, and a worksheet is never mixed with the next', () => {
  const pages = chunkSections([
    { heading: [], page: 1, unit: 'page', text: 'Short first page.' },
    { heading: [], page: 2, unit: 'page', text: 'Short second page.' },
    { heading: [], page: 3, unit: 'page', text: 'word '.repeat(700) },
  ]);
  assert.equal(pages[0].location, '第 1–2 页');
  assert.equal(pages[1].location, '第 3 页');
  const sheets = chunkSections([
    { heading: ['一月'], label: '工作表「一月」', text: '苹果 | 3' },
    { heading: ['二月'], label: '工作表「二月」', text: '香蕉 | 5' },
  ]);
  assert.deepEqual(
    sheets.map((chunk) => chunk.location),
    ['工作表「一月」', '工作表「二月」'],
  );
  // Written in two parts so the publication audit does not take this fixture for a real key.
  const keyHeader = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
  assert.equal(chunkSections([{ heading: [], text: keyHeader + '\nabc' }]).length, 0);
});

test('text is read from Markdown, HTML, Office files, PDF and older Chinese encodings', async () => {
  assert.equal(documentKind('notes/Plan.MD'), 'markdown');
  assert.equal(documentKind('a/pnpm-lock.yaml'), undefined);
  assert.equal(documentKind('photo.png'), undefined);
  const markdown = await extractSections(
    'markdown',
    Buffer.from('intro\n\n# 部署\n\n## 回滚\n\n先停服务。\n\n```sh\n# not a heading\n```\n\n# 监控\n\n看面板。\n'),
  );
  assert.deepEqual(
    markdown.map((section) => section.heading.join('/')),
    ['', '部署/回滚', '监控'],
  );
  assert.match(markdown[1].text, /# not a heading/);
  // Short sections share a passage; each brings its heading, and the passage starts where the text does.
  const joined = chunkSections(markdown);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].line, 1);
  assert.match(joined[0].text, /^intro\n\n部署 › 回滚\n先停服务。[\s\S]*\n\n监控\n看面板。$/);

  const html = await extractSections(
    'html',
    Buffer.from(
      '<html><head><title>手册</title><style>p{color:red}</style></head><body><p>前言</p><h1>安装</h1><p>运行 <b>setup</b>。</p><script>alert(1)</script><h2>升级</h2><ul><li>备份</li><li>替换</li></ul></body></html>',
    ),
  );
  assert.deepEqual(
    html.map((section) => section.heading.join('/')),
    ['手册', '安装', '安装/升级'],
  );
  assert.match(html[1].text, /运行 setup。/);
  assert.doesNotMatch(JSON.stringify(html), /alert|color:red/);

  const docx = await extractSections(
    'docx',
    office({
      'word/styles.xml':
        '<w:styles><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style></w:styles>',
      'word/document.xml':
        '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>报销制度</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">出差 </w:t></w:r><w:r><w:t>&lt;三天&gt;内报销。</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>上限</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>',
    }),
  );
  assert.deepEqual(docx[0].heading, ['报销制度']);
  assert.equal(docx[0].text, '出差 <三天>内报销。\n\n项目 | 上限');

  const pptx = await extractSections(
    'pptx',
    office({
      'ppt/presentation.xml':
        '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>结尾</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>开场</a:t></a:r></a:p></p:sld>',
    }),
  );
  assert.deepEqual(
    pptx.map((section) => [section.page, section.text]),
    [
      [1, '开场'],
      [2, '结尾'],
    ],
  );

  const xlsx = await extractSections(
    'xlsx',
    office({
      'xl/workbook.xml': '<workbook><sheets><sheet name="价格" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml':
        '<sst><si><t>型号</t></si><si><t>单价</t></si><si><r><t>甲</t></r><r><t>型</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>129.5</v></c><c r="C2"/></row></sheetData></worksheet>',
    }),
  );
  assert.equal(xlsx[0].label, '工作表「价格」');
  assert.equal(xlsx[0].text, '型号 | 单价\n甲型 | 129.5');

  const pages = await extractSections(
    'pdf',
    pdf([['Quarterly revenue grew twelve percent.', 'Churn fell.'], ['The second page covers hiring.']]),
    { pdfAssets },
  );
  assert.deepEqual(
    pages.map((section) => section.page),
    [1, 2],
  );
  assert.match(pages[0].text, /Quarterly revenue grew twelve percent\. Churn fell\./);
  assert.match(pages[1].text, /second page covers hiring/);

  // "知识库检索" in GBK.
  const gbk = Buffer.from([0xd6, 0xaa, 0xca, 0xb6, 0xbf, 0xe2, 0xbc, 0xec, 0xcb, 0xf7]);
  assert.equal((await extractSections('text', gbk))[0].text, '知识库检索');
  await assert.rejects(extractSections('text', Buffer.from([0x61, 0x00, 0x62])), { code: 'knowledge.not_text' });
  await assert.rejects(extractSections('docx', Buffer.from('not a zip')), { code: 'knowledge.file_damaged' });
});

test('a scan honours .gitignore, leaves tooling and hidden files out, and stops at the limit', async (t) => {
  const dir = tempDir(t),
    write = (name: string, text = 'text') => {
      mkdirSync(join(dir, name, '..'), { recursive: true });
      writeFileSync(join(dir, name), text);
    };
  write('a.md');
  write('b.txt');
  write('image.png');
  write('.gitignore', 'drafts/\n*.log.txt\n');
  write('drafts/secret.md');
  write('run.log.txt');
  write('node_modules/pkg/readme.md');
  write('.obsidian/workspace.json');
  write('.hidden.md');
  write('sub/.gitignore', 'local.md\n');
  write('sub/local.md');
  write('sub/keep.md');
  write('big.txt', 'x'.repeat(2 * 1024 * 1024 + 1));
  const names = (paths: string[]) => paths.map((path) => path.slice(dir.length + 1).replace(/\\/g, '/'));
  const scan = await scanSources([{ path: dir, kind: 'folder' }], 100);
  assert.deepEqual(names(scan.files.map((file) => file.path)), ['a.md', 'b.txt', 'sub/keep.md']);
  assert.deepEqual(
    scan.skipped.map((issue) => [names([issue.path])[0], issue.reason]),
    [['big.txt', 'too_large']],
  );
  assert.equal(scan.truncated, false);

  const limited = await scanSources([{ path: dir, kind: 'folder' }], 2);
  assert.equal(limited.files.length, 2);
  assert.equal(limited.truncated, true);

  const mixed = await scanSources(
    [
      { path: join(dir, 'a.md'), kind: 'file' },
      { path: join(dir, 'image.png'), kind: 'file' },
      { path: join(dir, 'gone'), kind: 'folder' },
      { path: dir, kind: 'folder' },
    ],
    100,
  );
  assert.equal(mixed.files.filter((file) => file.path.endsWith('a.md')).length, 1, 'a file is indexed once');
  assert.deepEqual(mixed.missing, [join(dir, 'gone')]);
  assert.ok(mixed.skipped.some((issue) => issue.path.endsWith('image.png') && issue.reason === 'unsupported'));
});

test('the index follows the files: new ones are added, changed ones re-read, removed ones dropped', async (t) => {
  const f = service(t);
  const guide = f.write('guide.md', '# 发布流程\n\n每周四下午发版，发版前要跑回归测试。\n');
  f.write('notes/retro.md', '# 复盘\n\n上次事故的原因是配置没有同步。\n');
  f.write('broken.docx', 'not really a document');
  const id = f.knowledge.save({ name: '团队文档', sources: [{ path: f.docs, kind: 'folder' }] });
  await f.knowledge.idle();
  let view = f.knowledge.view().bases[0];
  assert.equal(view.state, 'idle');
  assert.equal(view.files, 2);
  assert.equal(view.issues, 1);
  assert.ok(view.indexedAt);
  assert.deepEqual(f.knowledge.issues(id), [{ path: join(f.docs, 'broken.docx'), reason: 'file_damaged' }]);
  assert.equal(f.runner.read, 3, 'the damaged file was read too');
  const find = async (query: string) => (await f.knowledge.search(f.bot.id, { query })).results;
  assert.equal((await find('什么时候发版'))[0].file, guide);
  assert.equal((await find('什么时候发版'))[0].title, '发布流程');

  // Nothing changed: nothing is read again.
  f.knowledge.reindex(id);
  await f.knowledge.idle();
  assert.equal(f.runner.read, 6, 'a requested re-index reads every file again');
  const before = f.runner.read;
  f.knowledge.save({ id, name: '团队文档', description: '流程和复盘', sources: [{ path: f.docs, kind: 'folder' }] });
  await f.knowledge.idle();
  assert.equal(f.runner.read, before, 'renaming or describing a knowledge base reads nothing');

  // Changed, added and removed files.
  writeFileSync(guide, '# 发布流程\n\n改为每周二上午发版。\n');
  utimesSync(guide, new Date(), new Date(Date.now() + 5000));
  const added = f.write('oncall.txt', '值班表：本周由小林值班，电话在通讯录里。');
  rmSync(join(f.docs, 'notes'), { recursive: true });
  f.knowledge.save({
    id,
    name: '团队文档',
    sources: [
      { path: f.docs, kind: 'folder' },
      { path: join(f.dir, 'unplugged'), kind: 'folder' },
    ],
  });
  await f.knowledge.idle();
  view = f.knowledge.view().bases[0];
  assert.equal(view.files, 2);
  assert.deepEqual(view.missing, [join(f.dir, 'unplugged')]);
  assert.equal(f.runner.read, before + 2);
  assert.match((await find('发版'))[0].text, /每周二上午/);
  assert.equal((await find('谁值班'))[0].file, added);
  assert.equal((await find('事故 配置 同步')).length, 0);

  f.knowledge.remove(id);
  assert.equal(f.knowledge.view().bases.length, 0);
  assert.equal(f.knowledge.offers(f.bot.id), false);
  await assert.rejects(f.knowledge.search(f.bot.id, { query: '发版' }), { code: 'knowledge.unavailable' });
});

test('a source that is away keeps what was read from it', async (t) => {
  const f = service(t),
    drive = join(f.dir, 'drive');
  mkdirSync(drive);
  writeFileSync(join(drive, 'contract.md'), '合同约定的交付日期是三月一日。');
  f.knowledge.save({ name: '合同', sources: [{ path: drive, kind: 'folder' }] });
  await f.knowledge.idle();
  rmSync(drive, { recursive: true });
  f.knowledge.reindex(f.knowledge.list()[0].id);
  await f.knowledge.idle();
  assert.equal(f.knowledge.view().bases[0].files, 1);
  assert.equal((await f.knowledge.search(f.bot.id, { query: '交付日期' })).results.length, 1);
});

test('search ranks by words and by meaning, and keeps to what the Bot may see', async (t) => {
  const embedder = topicEmbedder({ pay: /工资|薪|发薪|salary/i, travel: /出差|差旅|机票/ });
  const f = service(t, { embedder });
  f.write('hr/payroll.md', '# 薪酬\n\n每月十号发放上月薪水，遇节假日提前。\n');
  f.write('hr/travel.md', '# 差旅\n\n机票需提前七天预订，超标部分自付。\n');
  f.write('eng/build.md', '# 构建\n\n运行 pnpm run build 生成安装包。\n');
  f.write('eng/build-copy.md', '# 构建\n\n运行 pnpm run build 生成安装包。\n');
  const other = f.store.createBot('另一位', '');
  const hr = f.knowledge.save({
    name: '人事',
    description: '制度',
    sources: [{ path: join(f.docs, 'hr'), kind: 'folder' }],
  });
  f.knowledge.save({
    name: '工程',
    sources: [{ path: join(f.docs, 'eng'), kind: 'folder' }],
    botIds: [other.id],
  });
  await f.knowledge.idle();
  while (await f.knowledge.embedBatch()) {
    /* until every passage has a vector */
  }
  assert.equal(f.knowledge.view().semantic, true);

  // No word in common with the document: found by meaning.
  const salary = await f.knowledge.search(f.bot.id, { query: '工资什么时候到账' });
  assert.equal(salary.semantic, true);
  assert.match(salary.results[0].file, /payroll\.md$/);
  assert.equal(salary.results[0].base, '人事');
  assert.deepEqual(salary.searched, ['人事']);
  assert.ok(!salary.results.some((hit) => /travel/.test(hit.file)), 'unrelated passages stay out');

  // The first Bot may not search the engineering base; the other may search both.
  assert.equal((await f.knowledge.search(f.bot.id, { query: 'pnpm build 安装包' })).results.length, 0);
  const build = await f.knowledge.search(other.id, { query: 'pnpm build 安装包' });
  assert.equal(build.results.length, 1, 'two copies of the same text are returned once');
  assert.deepEqual(build.searched, ['人事', '工程']);
  assert.deepEqual((await f.knowledge.search(other.id, { query: '机票', base: '人事' })).searched, ['人事']);
  await assert.rejects(f.knowledge.search(f.bot.id, { query: '机票', base: '工程' }), {
    code: 'knowledge.base_not_found',
  });

  assert.match(f.knowledge.prompt(f.bot.id), /^知识库.*\n- 人事：制度$/s);
  assert.match(f.knowledge.prompt(other.id), /- 人事：制度\n- 工程$/);
  f.knowledge.save({ id: hr, name: '人事', sources: [{ path: join(f.docs, 'hr'), kind: 'folder' }], botIds: [] });
  assert.equal(f.knowledge.offers(f.bot.id), false);
  assert.equal(f.knowledge.prompt(f.bot.id), '');
});

test('without the local model search goes by words, and a changed passage loses its vector', async (t) => {
  let ready = false;
  const embedder = { ...topicEmbedder({ a: /alpha/ }), ready: () => ready };
  const f = service(t, { embedder });
  const path = f.write('a.md', 'alpha release notes for the first milestone\n');
  f.write('b.md', 'beta checklist for the second milestone\n');
  f.knowledge.save({ name: 'Notes', sources: [{ path: f.docs, kind: 'folder' }] });
  await f.knowledge.idle();
  assert.equal(await f.knowledge.embedBatch(), 0);
  const words = await f.knowledge.search(f.bot.id, { query: 'beta checklist' });
  assert.equal(words.semantic, false);
  assert.match(words.results[0].file, /b\.md$/);
  ready = true;
  assert.equal(await f.knowledge.embedBatch(), 2);
  assert.equal(await f.knowledge.embedBatch(), 0);
  const embedded = embedder.calls.length;
  // One file changes: only its passage is embedded again.
  writeFileSync(path, 'alpha release notes, now with a changelog\n');
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  f.knowledge.reindex(f.knowledge.list()[0].id);
  await f.knowledge.idle();
  assert.equal(await f.knowledge.embedBatch(), 1);
  assert.equal(embedder.calls.length, embedded + 1);
});

test('knowledge bases are validated, saved with the app state and re-checked when a search finds them stale', async (t) => {
  const f = service(t, { recheckMs: 0 });
  const source = [{ path: f.docs, kind: 'folder' as const }];
  assert.throws(() => f.knowledge.save({ name: ' ', sources: source }), { code: 'knowledge.name_invalid' });
  assert.throws(() => f.knowledge.save({ name: '空', sources: [] }), { code: 'knowledge.sources_required' });
  assert.throws(() => f.knowledge.save({ name: '相对', sources: [{ path: 'docs', kind: 'folder' }] }), {
    code: 'knowledge.sources_required',
  });
  f.write('a.md', '第一版内容。');
  const id = f.knowledge.save({ name: '资料', sources: source, botIds: ['no-such-bot', f.bot.id] });
  assert.throws(() => f.knowledge.save({ name: '资料', sources: source }), { code: 'knowledge.name_taken' });
  assert.throws(() => f.knowledge.reindex('missing'), { code: 'knowledge.not_found' });
  assert.deepEqual(f.store.data.knowledgeBases?.[0].botIds, [f.bot.id]);
  assert.equal(f.store.data.knowledgeBases?.[0].id, id);
  await f.knowledge.idle();
  assert.ok(f.changes() > 0);
  // A file appears without anyone asking for a re-index; the search that follows starts a look.
  f.write('b.md', '后来加的文件，写着预算是五十万。');
  const passes = f.runner.passes;
  await f.knowledge.search(f.bot.id, { query: '预算' });
  await f.knowledge.idle();
  assert.equal(f.runner.passes, passes + 1);
  assert.equal((await f.knowledge.search(f.bot.id, { query: '预算' })).results.length, 1);
  assert.equal(KNOWLEDGE_FILE_LIMIT, 5000);
});

test('a Bot gets knowledge_search and the list of knowledge bases only when it has one', async (t) => {
  const f = service(t);
  f.write('faq.md', '# 退货\n\n七天内可以无理由退货，运费由买家承担。\n');
  f.store.data.model.model = 'test';
  f.store.data.model.contextTokens = 64000;
  const seen: Array<{ tools: string[]; system: string }> = [];
  let step = 0;
  const model = {
    complete: async (messages: WireMessage[], tools: ToolDefinition[]): Promise<Completion> => {
      seen.push({
        tools: tools.map((tool) => tool.function.name),
        system: messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n'),
      });
      if (tools.some((tool) => tool.function.name === 'knowledge_search') && step++ === 0)
        return {
          content: '',
          finishReason: 'tool_calls',
          calls: [
            {
              id: randomUUID(),
              type: 'function',
              function: { name: 'knowledge_search', arguments: JSON.stringify({ query: '退货运费谁出' }) },
            },
          ],
        };
      return { content: '好的。', calls: [], finishReason: 'stop' };
    },
  } as unknown as ModelClient;
  const harness = new Harness(f.store, {} as never, model, () => {});
  harness.setKnowledge(f.knowledge);
  t.after(() => harness.disposeTools());

  await harness.run(f.bot.id, '你好');
  assert.ok(!seen[0].tools.includes('knowledge_search'));
  assert.doesNotMatch(seen[0].system, /知识库/);

  f.knowledge.save({ name: '客服手册', description: '售后规则', sources: [{ path: f.docs, kind: 'folder' }] });
  await f.knowledge.idle();
  seen.length = 0;
  await harness.run(f.bot.id, '退货运费谁出？');
  assert.ok(seen[0].tools.includes('knowledge_search'));
  assert.match(seen[0].system, /- 客服手册：售后规则/);
  const result = f.store.data.messages.find(
    (message) => message.role === 'tool' && message.tool === 'knowledge_search',
  );
  assert.equal(result?.status, 'done', result?.content || '');
  assert.match(result!.content, /运费由买家承担/);
  assert.match(result!.content, /faq\.md/);
  assert.equal(f.store.data.runs.at(-1)?.status, 'completed', f.store.data.runs.at(-1)?.error || '');
});
