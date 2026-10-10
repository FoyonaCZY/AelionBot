import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { RunRecord, WireMessage, ModelConfig } from '../../../shared/types/core';
import type { DesignArtifact, DesignOrigin, DesignSession, DesignTaskKind } from '../../../shared/types/designer-types';
import { lineChanges, recordDesignChange } from '../../../shared/designer/design-changes';
import { primaryDesignArtifact } from '../../../shared/preview/designer-canvas';
import { aspectDimensions } from '../../../shared/types/image-types';
import type { HarnessRunOptions } from '../agent/peer-runtime-types';
import type { Store } from '../storage/store';
import type { ModelClient } from '../model/model';
import type { ArtifactService } from '../attachments/artifacts';
import type { Attachments } from '../attachments/attachments';
import type { Interactions } from '../agent/interactions';
import type { AgentPreviews } from '../preview/agent-previews';
import { TemporarilyUnavailableTool } from '../tools/tool-availability';
import { parsePatch } from '../tools/multi-patch';
import { hostedGeneratedImages } from '../tools/hosted-tools';
import { generateModelImage, imageExtension, imageMediaType, storeImageRoutes } from '../image/image-generation';
import { imageJobFromArgs, imageReferences } from '../image/image-tool';
import { ImageGenerationError } from '../image/image-errors';
import type { DesignStore } from './design-store';
import type { DesignSystems } from './design-systems';
import type { DesignerFiles } from './designer-files';
import type { DesignCraft } from './design-craft';
import type { DesignFonts } from './design-fonts';
import { DESIGN_ENTRY_TOOLS, DESIGN_TOOLS } from './designer-tools';
import { designerDeck, type DeckSlide } from './designer-deck';
import { designerPlaybook, designerPlaybookCraft, designerPlaybookName } from './designer-playbooks';
import { lintDesignHtml, designFindingNote } from './design-artifact-lint';
import { parseDesignTokens, checkDesignBrand, repairDesignBrand, brandCheckLabel } from './design-brand';
import { renderDesignPdf } from './design-pdf';
import { applyDesignFont, designFontText, designHtmlPath } from './design-font-application';
import { prepareDesignHtml, exportDesignHtmlBundle } from './design-export';
import { designModePrompt } from './designer-prompt';

export type DesignWorkExtras = {
  fonts?: DesignFonts;
  pdf?: { render(html: string): Promise<Buffer> };
  craft?: DesignCraft;
  imageModel?: (botId: string) => { config: ModelConfig; key: string } | undefined;
  /** Resolves a host tool path the way the host tools do, relative to the run's workspace. */
  resolvePath?: (path: unknown, workspace?: string) => string;
};

/** What a design tool may ask of the general agent running it. */
export interface DesignToolHost {
  /** Runs another callable tool through the shared, permission-checked pipeline. */
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
  callable(name: string): boolean;
  /** Finite background tasks of this run that have not finished. */
  pending(): unknown[];
}

interface RunDesign {
  origin?: DesignOrigin;
  notes: string[];
  previewed: Set<string>;
  mutated: boolean;
  published: boolean;
  /** Bytes of a file before a host write in progress, keyed by absolute path. */
  before: Map<string, Buffer | null>;
  craft: Map<string, WireMessage | undefined>;
  reference: Map<string, WireMessage>;
}

const HOST_WRITES = new Set(['file_write', 'file_patch', 'apply_patch', 'host_file_write', 'host_file_patch']);
const artifactKind = (path: string): DesignArtifact['kind'] =>
  path.endsWith('.pptx') ? 'pptx' : /\.html?$/i.test(path) ? 'html' : path.endsWith('.pdf') ? 'pdf' : 'other';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function imageAssetName(value: unknown, extension: string) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'generated';
  const base =
    raw
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^[.]+/, '')
      .slice(0, 60) || 'generated';
  return `assets/${base}.${extension}`;
}
/** Editable text in at least one real slide, within bounded inflation. */
function editableDeck(bytes: Buffer) {
  let inflated = 0,
    oversized = false;
  const zip = unzipSync(bytes, {
    filter: (file) => {
      if (file.name !== '[Content_Types].xml' && !/^ppt\/slides\/slide\d+\.xml$/.test(file.name)) return false;
      inflated += file.originalSize;
      if (file.originalSize > 2 * 1024 * 1024 || inflated > 20 * 1024 * 1024) {
        oversized = true;
        return false;
      }
      return true;
    },
  });
  if (oversized) return 'oversized' as const;
  const slides = Object.entries(zip).filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  return Boolean(
    zip['[Content_Types].xml'] &&
    slides.length &&
    slides.some(([, data]) => /<a:t[ >]/.test(Buffer.from(data).toString('utf8'))),
  );
}
function recoverableArtifact(path: string, bytes: Buffer) {
  if (/\.html?$/i.test(path)) return /<(?:html|main|body|section)\b/i.test(bytes.toString('utf8'));
  if (path.endsWith('.pdf')) return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (!/\.pptx$/i.test(path)) return false;
  try {
    return editableDeck(bytes) === true;
  } catch {
    return false;
  }
}

/**
 * Design work as a capability of the general agent. A run is bound to at most one design task at a time: its
 * files live in the task's local folder, its design system and craft rules join the prompt prefix, and every
 * HTML write is linted and shown on the canvas. Nothing here gates completion: publishing is a delivery action.
 */
export class DesignWork {
  private runs = new Map<string, RunDesign>();
  previews?: AgentPreviews;
  constructor(
    private store: Store,
    readonly designs: DesignStore,
    private systems: DesignSystems,
    private files: DesignerFiles,
    private artifacts: ArtifactService,
    private attachments: Attachments,
    private interactions: Interactions,
    private model: ModelClient,
    private extras: DesignWorkExtras = {},
  ) {}

  /** Prepares a run; binds it to the requested or carried-over design task. */
  begin(run: RunRecord, options: HarnessRunOptions, carry?: RunRecord) {
    let origin: DesignOrigin | undefined;
    try {
      origin = this.designs.origin(run.botId, options);
    } catch {
      origin = undefined;
    }
    this.runs.set(run.id, {
      origin,
      notes: [],
      previewed: new Set(),
      mutated: false,
      published: false,
      before: new Map(),
      craft: new Map(),
      reference: new Map(),
    });
    const id = options.designSessionId || carry?.designSessionId;
    if (!id || !origin) return;
    let session: DesignSession;
    try {
      session = this.designs.get(id, run.botId, origin);
    } catch (error) {
      // A task requested by the user must exist here; one merely carried from an earlier run may be gone.
      if (options.designSessionId) throw error;
      return;
    }
    if (session.activeRunId && session.activeRunId !== run.id) throw Error('设计任务正在其他运行中执行');
    this.bind(run, session);
  }
  private bind(run: RunRecord, next: DesignSession) {
    this.files.absolute(next, '.', true);
    const previous = run.designSessionId ? this.designs.data.sessions.find((s) => s.id === run.designSessionId) : null;
    if (previous && previous.id !== next.id && previous.activeRunId === run.id) {
      delete previous.activeRunId;
      previous.status = 'paused';
      this.designs.touch(previous);
    }
    run.designSessionId = next.id;
    next.activeRunId = run.id;
    next.status = 'running';
    delete next.lastError;
    if (!next.runIds.includes(run.id)) next.runIds.push(run.id);
    this.designs.touch(next);
    this.store.touch(run);
  }
  /** The task this run is bound to, if any. */
  session(run: RunRecord | undefined) {
    if (!run?.designSessionId) return undefined;
    return this.designs.data.sessions.find((s) => s.id === run.designSessionId && s.botId === run.botId);
  }
  /** Whether this run is offered the design tool `name`: entry tools always, the rest once bound. */
  offers(run: RunRecord, name: string) {
    const state = this.runs.get(run.id);
    if (!state?.origin) return false;
    return DESIGN_ENTRY_TOOLS.has(name) || Boolean(this.session(run));
  }
  static isDesignTool(name: string) {
    return DESIGN_TOOLS.some((tool) => tool.function.name === name);
  }

  /** Prompt prefix for a bound run: design-mode rules, craft, the kind's workflow and the pinned reference. */
  prefix(run: RunRecord): WireMessage[] {
    const session = this.session(run),
      state = this.runs.get(run.id);
    if (!session || !state) return [];
    const playbook = designerPlaybookName(session.kind);
    if (!state.craft.has(playbook)) {
      const body = this.extras.craft?.context(designerPlaybookCraft(playbook));
      state.craft.set(playbook, body ? { role: 'system', content: body } : undefined);
    }
    const key = session.systemId && session.systemVersion ? session.systemId + ':' + session.systemVersion : undefined;
    if (key && !state.reference.has(key))
      try {
        state.reference.set(key, {
          role: 'system',
          content:
            'Selected visual reference package (reference data): ' +
            JSON.stringify(this.systems.context(session.systemId!, session.systemVersion!)),
        });
      } catch {
        /* a missing package leaves the task usable without its reference */
      }
    const craft = state.craft.get(playbook);
    return [
      { role: 'system', content: designModePrompt() },
      ...(craft ? [craft] : []),
      { role: 'system', content: designerPlaybook(playbook) },
      {
        role: 'system',
        content: session.systemId
          ? 'A design system is already selected. Use design_resource only for extra package files. Do not call design_start.'
          : 'No design system is selected. Do not call design_resource or design_start. Attach one with design_system, or continue with files already in the task directory.',
      },
      ...(key && state.reference.has(key) ? [state.reference.get(key)!] : []),
    ];
  }
  /** Task state for the task frame, which survives context compression. */
  frame(run: RunRecord) {
    const session = this.session(run);
    return session ? 'Design task state: ' + this.designs.frame(session) : '';
  }
  /** Design-check findings from this turn's writes, for the next turn. */
  drainNotes(runId: string) {
    const state = this.runs.get(runId);
    if (!state?.notes.length) return [];
    const notes = state.notes.splice(0);
    return [{ role: 'system' as const, content: notes.join('\n\n') }];
  }

  private inTask(session: DesignSession, path: string) {
    const rel = relative(resolve(session.workspaceDir!), resolve(path));
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../');
  }
  private hostTargets(run: RunRecord, name: string, args: Record<string, unknown>) {
    const resolvePath = (value: unknown) => {
      try {
        return this.extras.resolvePath
          ? this.extras.resolvePath(value, run.workspaceDir || undefined)
          : isAbsolute(String(value))
            ? resolve(String(value))
            : undefined;
      } catch {
        return undefined;
      }
    };
    if (name === 'apply_patch') {
      if (args.location === 'vm') return [];
      try {
        return parsePatch(args.patch)
          .flatMap((file) => [file.path, ...(file.moveTo ? [file.moveTo] : [])])
          .map(resolvePath)
          .filter((path): path is string => Boolean(path));
      } catch {
        return [];
      }
    }
    const path = resolvePath(args.path);
    return path ? [path] : [];
  }
  /** Keeps saved preview edits from being overwritten and remembers what a host write replaces. */
  beforeTool(run: RunRecord | undefined, name: string, args: Record<string, unknown>) {
    const session = this.session(run),
      state = run && this.runs.get(run.id);
    if (!session || !state || !HOST_WRITES.has(name) || session.location !== 'host' || args.location === 'vm') return;
    for (const path of this.hostTargets(run!, name, args)) {
      if (!this.inTask(session, path)) continue;
      if (
        (name === 'file_write' || name === 'host_file_write') &&
        session.userEdits.length &&
        /\.(html?|css)$/i.test(path) &&
        existsSync(path)
      )
        throw new TemporarilyUnavailableTool(
          '用户已在预览中保存过修改。请先 file_read，再用 file_patch 做局部更新，不要整文件覆盖。',
        );
      try {
        state.before.set(path, existsSync(path) && statSync(path).size <= 8 * 1024 * 1024 ? readFileSync(path) : null);
      } catch {
        state.before.set(path, null);
      }
    }
  }
  /** After a successful host write inside the task: records the change, lints HTML and shows it on the canvas. */
  async afterTool(run: RunRecord | undefined, name: string, args: Record<string, unknown>, failed: boolean) {
    const session = this.session(run),
      state = run && this.runs.get(run.id);
    if (!session || !state || !HOST_WRITES.has(name)) return;
    for (const path of this.hostTargets(run!, name, args)) {
      if (!this.inTask(session, path)) continue;
      const previous = state.before.get(path);
      state.before.delete(path);
      if (failed || !existsSync(path)) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      if (previous && previous.equals(bytes)) continue;
      state.mutated = true;
      const virtual = this.files.virtual(session, path);
      session.changes = recordDesignChange(
        session.changes,
        run!.id,
        virtual,
        lineChanges(previous || undefined, bytes),
      );
      this.designs.touch(session);
      if (/\.html?$/i.test(path)) {
        this.lint(session, state, virtual, bytes.toString('utf8'));
        await this.showLive(run!, virtual);
      }
    }
  }
  private lint(session: DesignSession, state: RunDesign, virtual: string, html: string) {
    const findings = lintDesignHtml(html);
    session.findings = [
      ...(session.findings || []).filter((entry) => entry.path !== virtual),
      ...(findings.length ? [{ path: virtual, findings }] : []),
    ];
    this.designs.touch(session);
    const note = designFindingNote(virtual, findings);
    if (note) state.notes.push(note);
  }
  /** Lints a file written by a design tool itself and shows it. */
  private async checkWritten(run: RunRecord, session: DesignSession, path: string) {
    const state = this.runs.get(run.id);
    if (!state || !/\.html?$/i.test(path)) return;
    let html: string;
    try {
      html = readFileSync(this.files.absolute(session, path), 'utf8');
    } catch {
      return;
    }
    const virtual = this.files.virtual(session, path);
    this.lint(session, state, virtual, html);
    await this.showLive(run, virtual);
  }
  /** Queues the written page for the canvas once per file and run; a preview failure never fails the write. */
  private async showLive(run: RunRecord, virtual: string) {
    const state = this.runs.get(run.id);
    if (!state || state.origin?.kind === 'peer' || !this.previews || state.previewed.has(virtual)) return;
    state.previewed.add(virtual);
    try {
      await this.previews.open(
        run.botId,
        run.id,
        { path: virtual, placement: 'side', location: 'host', reason: '文件已写入，在画布展示当前稿' },
        new AbortController().signal,
      );
    } catch {
      /* the canvas card still lists the file */
    }
  }

  /** Executes a design_* tool for a run of the general agent. */
  async invoke(
    run: RunRecord,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    host: DesignToolHost,
  ): Promise<unknown> {
    const state = this.runs.get(run.id);
    if (!state?.origin) throw new TemporarilyUnavailableTool('这个会话不能使用设计工具');
    const botId = run.botId,
      origin = state.origin;
    const permission = (path: string, reason: string, overwrite = true) =>
      this.interactions.permission(botId, run.id, { operation: 'write_file', path, reason, overwrite }, signal);
    if (name === 'design_tasks')
      return this.designs
        .activeFor(botId, origin)
        .map((s) => ({ id: s.id, title: s.title, kind: s.kind, status: s.status }));
    // The user's font library: usable before any task is bound, so a Bot can stock fonts the way Settings does.
    if (name === 'design_font_library') {
      const fonts = this.extras.fonts;
      if (!fonts) throw Error('字体库未就绪');
      const action = String(args.action);
      if (action === 'list') return { library: fonts.librarySummary() };
      if (action === 'search') return { fonts: await fonts.catalog(String(args.query || '')) };
      if (action !== 'download') throw Error('字体库操作无效');
      await permission(fonts.libraryRoot, String(args.reason || '下载字体到字体库'));
      signal.throwIfAborted();
      const font = await fonts.libraryDownload(
        {
          fontId: String(args.fontId || ''),
          weights: args.weights as number[] | undefined,
          styles: args.styles as ('normal' | 'italic')[] | undefined,
          subsets: args.subsets as string[] | undefined,
        },
        signal,
      );
      return {
        font: { id: font.id, family: font.family, weights: font.weights, styles: font.styles, subsets: font.subsets },
        next: '在设计任务里用 design_fonts acquire（fontId 用这个 id 或 Fontsource ID）离线复制进项目。',
      };
    }
    let session = this.session(run);
    if (name === 'design_start') {
      if (session) {
        if (!session.systemId && args.systemId) {
          this.designs.setSystem(session, String(args.systemId));
          return { task: this.designs.frame(session), attached: true };
        }
        throw Error(
          session.systemId
            ? '本次运行已绑定任务，请直接继续当前任务，不要再调用 design_start'
            : '本次运行已绑定任务且未选择设计系统。请调用 design_system，不要再调用 design_start。',
        );
      }
      const requested = args.systemId === undefined ? undefined : String(args.systemId) || undefined,
        input = {
          botId,
          origin,
          kind: args.kind as DesignTaskKind,
          brief: String(args.brief),
          title: String(args.title),
        };
      const created = this.designs.create({ ...input, systemId: requested });
      this.bind(run, this.designs.get(created.id));
      return { task: this.designs.frame(this.session(run)!) };
    }
    if (name === 'design_use') {
      if (session && session.id !== args.id) throw Error('本次运行已有任务，不能跨任务写入');
      const next = this.designs.get(String(args.id), botId, origin);
      if (next.activeRunId && next.activeRunId !== run.id) throw Error('设计任务正在其他运行中执行');
      this.bind(run, next);
      return { task: this.designs.frame(next) };
    }
    if (name === 'design_skill') return designerPlaybook(String(args.name));
    if (!session) throw new TemporarilyUnavailableTool('请先用 design_start 创建设计任务或用 design_use 继续已有任务');
    const live = session;
    const guard = () => {
      signal.throwIfAborted();
      if (this.session(run) !== live) throw Error('设计任务已更改，请重新读取');
    };
    const outputRevision = (path: string) => {
      const target = this.files.absolute(live, path);
      if (!existsSync(target)) return null;
      if (statSync(target).size > 128 * 1024 * 1024) throw Error('已有导出文件过大，请另选文件名');
      return sha256(readFileSync(target));
    };
    if (name === 'design_system') {
      this.designs.setSystem(live, args.systemId === undefined || args.systemId === '' ? null : String(args.systemId));
      return { task: this.designs.frame(live) };
    }
    if (name === 'design_file_create') {
      const path = this.files.absolute(live, String(args.path));
      if (host.callable('file_write'))
        return host.invoke('file_write', {
          path,
          content: args.content,
          overwrite: false,
        });
      if (existsSync(path)) throw Error('文件已存在；请先读取再用 file_patch 修改');
      await permission(path, String(args.reason), false);
      guard();
      const result = this.files.write(live, String(args.path), Buffer.from(String(args.content)), null);
      state.mutated = true;
      await this.checkWritten(run, live, String(args.path));
      return result;
    }
    if (name === 'design_asset_save') {
      const [attachment] = this.attachments.forBot(botId, [args.attachmentId]),
        path = 'assets/' + attachment.id + '-' + attachment.name.replace(/[^\p{L}\p{N}._-]/gu, '_');
      await permission(this.files.absolute(live, path), '保存用户提供的设计附件', false);
      guard();
      const saved = this.files.preserve(live, path, this.attachments.bytes(attachment.id));
      state.mutated = true;
      return { ...saved, relativePath: path };
    }
    if (name === 'design_spec') {
      if (String(args.spec).length > 12000 || (args.constraints as string[]).some((v) => v.length > 800))
        throw Error('设计约定过长');
      await permission(this.files.absolute(live, 'DESIGN.md'), '保存本任务的设计约定');
      guard();
      this.files.write(
        live,
        'DESIGN.md',
        Buffer.from(String(args.spec) + '\n\n' + (args.constraints as string[]).map((c) => '- ' + c).join('\n')),
      );
      live.designSpec = String(args.spec);
      live.constraints = args.constraints as string[];
      live.stage = 'build';
      this.designs.touch(live);
      return { saved: true, revision: live.revision };
    }
    if (name === 'design_resource') {
      if (!live.systemId || !live.systemVersion)
        return {
          selected: false,
          next: '当前任务没有选择设计系统。不要再调用本工具或 design_start。用 design_system 选择一套，或继续使用任务目录里已有的文件。',
        };
      if (args.action === 'read')
        return {
          path: args.path,
          content: this.systems
            .read(live.systemId, String(args.path), live.systemVersion)
            .toString('utf8')
            .slice(0, 60000),
        };
      const system = this.systems.get(live.systemId, live.systemVersion),
        base = '.design-system/' + system.version + '/' + system.id;
      await permission(this.files.absolute(live, base), '准备当前任务的设计系统参考');
      for (const file of system.files) {
        guard();
        this.files.preserve(live, base + '/' + file.path, this.systems.read(system.id, file.path, system.version));
      }
      return { path: base, version: system.version, files: system.files.length };
    }
    if (name === 'design_fonts') {
      const fonts = this.extras.fonts;
      if (!fonts) throw Error('项目字体库未就绪');
      const action = String(args.action);
      if (action === 'list')
        return {
          fonts: fonts.list(live),
          // The user's font library (Settings → Design → Fonts); acquire copies a family from it offline.
          library: fonts.librarySummary(),
          cssPath: 'assets/fonts/fonts.css',
        };
      if (action === 'search') return { fonts: await fonts.catalog(String(args.query || '')) };
      if (action === 'check') {
        const text =
          typeof args.text === 'string'
            ? args.text
            : await designFontText(this.files, live, args.path ? String(args.path) : undefined);
        return fonts.check(live, { text, family: typeof args.family === 'string' ? args.family : undefined });
      }
      if (!['acquire', 'import'].includes(action)) throw Error('字体操作无效');
      const importPath = action === 'import' ? this.files.absolute(live, String(args.path || '')) : undefined;
      if (importPath)
        await this.interactions.permission(
          botId,
          run.id,
          { operation: 'read_file', path: importPath, reason: String(args.reason || '导入用户提供的项目字体') },
          signal,
        );
      await permission(this.files.absolute(live, 'assets/fonts'), String(args.reason || '准备项目字体'));
      signal.throwIfAborted();
      const added =
        action === 'import'
          ? await fonts.importFile(live, importPath!, { beforeWrite: guard })
          : await fonts.acquire(
              live,
              {
                fontId: String(args.fontId || ''),
                weights: args.weights as number[] | undefined,
                styles: args.styles as ('normal' | 'italic')[] | undefined,
                subsets: args.subsets as string[] | undefined,
              },
              signal,
              guard,
            );
      state.mutated = true;
      this.designs.touch(live);
      return {
        fonts: added,
        cssPath: 'assets/fonts/fonts.css',
        next: '用 design_font_apply 应用字体，或引用本地 fonts.css 并使用返回的 family。',
      };
    }
    if (name === 'design_font_apply') {
      if (!this.extras.fonts) throw Error('项目字体库未就绪');
      const path = await designHtmlPath(this.files, live, args.path ? String(args.path) : undefined);
      await permission(this.files.absolute(live, path), String(args.reason));
      signal.throwIfAborted();
      const result = await applyDesignFont(
        this.files,
        live,
        this.extras.fonts.list(live),
        { fontId: String(args.fontId), role: args.role as 'body' | 'display' | 'mono', path },
        guard,
      );
      state.mutated = true;
      await this.checkWritten(run, live, path);
      return result;
    }
    if (name === 'design_export_project') {
      const path = await designHtmlPath(this.files, live, String(args.path)),
        output = String(args.output || path.replace(/\.html?$/i, '.zip'));
      if (!/\.zip$/i.test(output)) throw Error('项目导出文件必须为 ZIP');
      const expected = outputRevision(output);
      await permission(this.files.absolute(live, output), String(args.reason));
      signal.throwIfAborted();
      const bytes = await exportDesignHtmlBundle({
        rootDir: live.workspaceDir!,
        htmlPath: this.files.absolute(live, path),
        signal,
      });
      guard();
      const result = this.files.write(live, output, bytes, expected);
      state.mutated = true;
      return { path: result.path, bytes: bytes.length };
    }
    if (name === 'design_export_pdf') {
      if (!this.extras.pdf) throw Error('当前环境无法导出 PDF');
      const source = this.files.virtual(live, String(args.path));
      if (!/\.html?$/i.test(source)) throw Error('只能从 HTML 预览导出 PDF');
      const html = (await this.artifacts.read(botId, source)).toString('utf8');
      const output = String(args.output || source.replace(/\.html?$/i, '.pdf'));
      if (!/\.pdf$/i.test(output)) throw Error('PDF 导出文件必须使用 .pdf 扩展名');
      const expected = outputRevision(output);
      await permission(this.files.absolute(live, output), String(args.reason || '导出 PDF'));
      signal.throwIfAborted();
      const ready = await prepareDesignHtml({
        rootDir: live.workspaceDir!,
        htmlPath: this.files.absolute(live, source),
        html,
        signal,
      });
      signal.throwIfAborted();
      const pdf = await renderDesignPdf(ready, (document) => this.extras.pdf!.render(document));
      guard();
      this.files.write(live, output, pdf, expected);
      state.mutated = true;
      return { path: this.files.virtual(live, output), bytes: pdf.length };
    }
    if (name === 'design_deck') {
      if (live.kind !== 'ppt') throw Error('此工具用于演示任务');
      const base = String(args.path).replace(/\.(pptx|html)$/i, ''),
        deck = designerDeck(String(args.title), args.slides as DeckSlide[], args as any);
      for (const [ext, bytes] of Object.entries(deck)) {
        const path = base + '.' + ext;
        await permission(this.files.absolute(live, path), '生成用户要求的可编辑演示与预览');
        guard();
        this.files.write(live, path, bytes);
      }
      state.mutated = true;
      await this.checkWritten(run, live, base + '.html');
      return { files: [base + '.pptx', base + '.html'], slides: (args.slides as unknown[]).length };
    }
    if (name === 'design_image') {
      const access = this.extras.imageModel?.(botId);
      const job = imageJobFromArgs(args, access?.config || {}, (ids) =>
        imageReferences(this.attachments.forBot(botId, ids), (id) => this.attachments.bytes(id)),
      );
      // Permission is asked once, before any provider call, using the name the provider will actually produce.
      await permission(
        this.files.absolute(live, imageAssetName(args.filename, 'png')),
        String(args.reason || '生成设计插图'),
      );
      signal.throwIfAborted();
      let bytes: Buffer,
        protocol = 'responses-images';
      if (access) {
        const result = await generateModelImage({
          model: this.model,
          config: access.config,
          key: access.key,
          job,
          signal,
          botId,
          runId: run.id,
          routes: storeImageRoutes(this.store),
        });
        bytes = result.bytes;
        protocol = result.protocol;
      } else {
        // No dedicated image model: the Bot's own chat model may be a Responses provider with hosted generation.
        const result = await this.model.complete(
          [
            {
              role: 'user',
              content:
                'Generate one image for this local design task. Do not claim success without image bytes.\nPrompt: ' +
                job.prompt,
            },
          ],
          [],
          signal,
          () => {},
          { botId, runId: run.id, purpose: 'design-image', maxOutputTokens: 1024 },
        );
        const images = hostedGeneratedImages(result.native?.data);
        if (!images.length)
          throw new ImageGenerationError('open-settings', {
            detail: '生图未返回图像。请为这个 Bot 配置生图模型，或确认当前 Responses Provider 已开启托管图片生成。',
          });
        bytes = images[0];
      }
      guard();
      const mediaType = imageMediaType(bytes),
        path = imageAssetName(args.filename, imageExtension(mediaType));
      this.files.write(live, path, bytes);
      state.mutated = true;
      const { width, height } = aspectDimensions(job.aspect);
      return {
        path: this.files.virtual(live, path),
        relativePath: path,
        bytes: bytes.length,
        mediaType,
        protocol,
        ...(job.aspect ? { aspect: job.aspect, width, height } : {}),
      };
    }
    if (name === 'design_check') {
      live.stage = 'verify';
      const evidence = run.executions?.find(
        (e) => e.id === args.executionId && e.status === 'succeeded' && e.tool === 'view_image',
      );
      const message =
        evidence && this.store.runMessages(run.id).find((m) => m.executionId === evidence.id && m.screenshotId);
      if (!message) throw Error('没有找到本次运行的实际页面截图');
      live.checks = live.checks.filter((c) => c.id !== 'visual');
      live.checks.push({
        id: 'visual',
        label: '实际页面截图检查',
        status: 'passed',
        executionId: evidence!.id,
        detail: String(args.note).slice(0, 1000),
      });
      this.designs.touch(live);
      return { recorded: true };
    }
    if (name === 'design_publish') return this.publish(run, live, state, args.paths as string[], signal, host);
    throw new TemporarilyUnavailableTool('未知的设计工具：' + name);
  }

  /** Verifies the real files and attaches them. Lint findings are warnings; only fake deliverables are refused. */
  private async publish(
    run: RunRecord,
    session: DesignSession,
    state: RunDesign,
    paths: string[],
    signal: AbortSignal,
    host: DesignToolHost,
  ) {
    const botId = run.botId;
    session.stage = 'verify';
    this.designs.touch(session);
    if (host.pending().length) throw Error('仍有任务进程在运行，请先检查完成状态；预览服务请声明 purpose:service');
    const verified: DesignArtifact[] = [],
      warnings: string[] = [];
    for (const inputPath of paths) {
      const path = this.files.virtual(session, inputPath);
      if (!path.startsWith(session.workspacePath + '/') || path.includes('/.design-system/'))
        throw Error('只能交付当前设计任务的产物');
      let bytes = await this.artifacts.read(botId, path, 25 * 1024 * 1024);
      if (!bytes.length) throw Error('产物为空：' + path);
      const kind = artifactKind(path);
      if (kind === 'html') {
        let html = bytes.toString('utf8');
        if (!/<(?:html|main|body|section)\b/i.test(html)) throw Error('HTML 产物缺少页面内容');
        const findings = lintDesignHtml(html);
        warnings.push(...findings.map((finding) => `${finding.level} ${finding.id}：${finding.message}`));
        session.findings = [
          ...(session.findings || []).filter((entry) => entry.path !== path),
          ...(findings.length ? [{ path, findings }] : []),
        ];
        if (session.systemId && session.systemVersion)
          try {
            const tokens = parseDesignTokens(
              this.systems.read(session.systemId, 'tokens.css', session.systemVersion).toString('utf8'),
            );
            const locked = session.userEdits.some((edit) => edit.path === path);
            const repaired = repairDesignBrand(html, tokens);
            if (repaired.changed && !locked) {
              this.files.write(session, path, Buffer.from(repaired.html), sha256(bytes));
              html = repaired.html;
              bytes = Buffer.from(html);
            }
            const check = checkDesignBrand(html, tokens);
            session.checks = session.checks.filter((c) => c.id !== 'brand');
            session.checks.push({
              id: 'brand',
              label: brandCheckLabel(check.aligned),
              status: check.aligned ? 'passed' : 'failed',
              detail: check.issues.join(' ') || undefined,
            });
          } catch {
            /* brand alignment is advisory */
          }
      }
      if (kind === 'pptx') {
        const deck = editableDeck(bytes);
        if (deck === 'oversized') throw Error('PPT 内容超过检查大小限制');
        if (!deck) throw Error('PPTX 必须包含可编辑文字和实际幻灯片');
      }
      verified.push({
        path,
        name: path.split('/').at(-1)!,
        kind,
        revision: sha256(bytes),
        bytes: bytes.length,
        verifiedAt: new Date().toISOString(),
      });
    }
    if (!verified.some((a) => a.kind === (session.kind === 'ppt' ? 'pptx' : 'html')))
      throw Error(session.kind === 'ppt' ? '演示任务需要交付一个 PPTX' : '这个任务需要交付一个 HTML 页面');
    if (session.kind === 'clone') {
      const notesFile = this.files.absolute(session, 'NOTES.md');
      if (!existsSync(notesFile) || !/https?:\/\//i.test(readFileSync(notesFile, 'utf8')))
        warnings.push('NOTES.md 未写明复刻来源网址。');
      else {
        const notesPath = this.files.virtual(session, 'NOTES.md'),
          notes = readFileSync(notesFile);
        if (!verified.some((a) => a.path === notesPath))
          verified.push({
            path: notesPath,
            name: 'NOTES.md',
            kind: 'other',
            revision: sha256(notes),
            bytes: notes.length,
            verifiedAt: new Date().toISOString(),
          });
      }
    }
    const uniqueWarnings = [...new Set(warnings)];
    session.artifacts = verified;
    session.checks = session.checks.filter((c) => c.id !== 'format' && c.id !== 'lint');
    session.checks.push({ id: 'format', label: '产物文件与格式', status: 'passed' });
    if (uniqueWarnings.length)
      session.checks.push({ id: 'lint', label: '静态设计检查', status: 'passed', detail: uniqueWarnings.join(' ') });
    session.stage = 'delivery';
    state.published = true;
    this.designs.touch(session);
    // Attach like message_attach does, without asking to read files this run already wrote.
    const files = await this.attachments.prepare(
      botId,
      verified.map((a) => ({ path: a.path })),
      signal,
    );
    const delivered = new Set(
      this.store.data.messages
        .filter((m) => m.botId === botId && m.role === 'assistant' && m.runId && m.runId !== run.id)
        .flatMap((m) => m.attachments || [])
        .map((file) => file.id),
    );
    const fresh = files.filter((file) => !delivered.has(file.id));
    if (fresh.length) {
      run.attachments = this.attachments.forBot(botId, [
        ...new Set([...(run.attachments || []), ...fresh].map((file) => file.id)),
      ]);
      this.store.touch(run);
    }
    await this.artifacts.collect(botId, run.id);
    const main = verified.find((a) => a.kind === 'html') || verified[0];
    state.previewed.delete(main.path);
    await this.showLive(run, main.path);
    return {
      published: true,
      artifacts: verified,
      warnings: uniqueWarnings,
      brand: session.checks.find((c) => c.id === 'brand'),
      visualVerified: session.checks.some((c) => c.id === 'visual' && c.status === 'passed'),
      next: '文件已附在本次回复中。简要说明这一版做了什么，请用户在画布上查看并提出修改意见。',
    };
  }

  /** Releases the run's binding; a draft that was written but not published still shows on the delivery card. */
  async finish(run: RunRecord) {
    const state = this.runs.get(run.id);
    this.runs.delete(run.id);
    const session = this.session(run);
    if (!session) return;
    if (session.activeRunId === run.id) delete session.activeRunId;
    if (run.status === 'completed')
      session.status = state?.published || session.artifacts.length || state?.mutated ? 'review' : 'awaiting-input';
    else if (run.status === 'failed') {
      session.status = 'failed';
      session.lastError = run.error;
    } else session.status = 'paused';
    if (state?.mutated && !state.published) await this.recover(run, session).catch(() => {});
    this.designs.touch(session);
  }
  private async recover(run: RunRecord, session: DesignSession) {
    const since = Date.parse(run.startedAt) - 2000,
      known = new Map(session.artifacts.map((a) => [a.path, a])),
      recovered: string[] = [];
    for (const file of await this.files.list(run.botId, session.id)) {
      if (!primaryDesignArtifact(session.kind, file.path) || Date.parse(file.modifiedAt) < since) continue;
      try {
        const bytes = await this.artifacts.read(run.botId, file.path, 25 * 1024 * 1024);
        if (!recoverableArtifact(file.path, bytes)) continue;
        known.set(file.path, {
          path: file.path,
          name: file.name,
          kind: artifactKind(file.path),
          revision: sha256(bytes),
          bytes: file.size,
          verifiedAt: file.modifiedAt,
        });
        recovered.push(file.path);
      } catch {
        /* an unreadable draft is left out */
      }
    }
    if (!recovered.length) return;
    session.artifacts = [...known.values()];
    session.checks = session.checks.map((check) => (check.id === 'format' ? { ...check, status: 'pending' } : check));
  }
}
