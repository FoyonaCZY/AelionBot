import { renderCanvasExport } from '../windows/canvas-export-renderer';
import { CanvasExports } from '../core/designer/canvas-export-service';
import { applyDesignFont, designFontText, designHtmlPath } from '../core/designer/design-font-application';
import { exportDesignHtmlBundle } from '../core/designer/design-export';
import { dialog } from 'electron';
import { basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { IpcContext } from './context';

export function registerDesign(ctx: IpcContext) {
  const { handle } = ctx;
  const fontMutationSessions = new Set<string>();
  const fontSession = (id: unknown, write = false) => {
    const session = ctx.designStore.get(String(id));
    ctx.designerFiles.absolute(session, '.', true);
    if (write && (session.activeRunId || ctx.harness.isRunning(session.botId))) throw Error('请停止设计任务后修改字体');
    return session;
  };
  const mutateFonts = async <T>(
    id: unknown,
    action: (session: import('../../shared/types/designer-types').DesignSession, guard: () => void) => Promise<T>,
  ) => {
    const session = fontSession(id, true);
    if (fontMutationSessions.has(session.id)) throw Error('字体正在处理中');
    fontMutationSessions.add(session.id);
    const guard = () => {
      if (fontSession(id, true) !== session) throw Error('设计任务已更改，请重试');
    };
    try {
      const value = await action(session, guard);
      if (value === null) return value;
      guard();
      session.checks = session.checks.map((check) => ({ ...check, status: 'pending' as const }));
      ctx.designStore.touch(session);
      return value;
    } finally {
      fontMutationSessions.delete(session.id);
    }
  };
  handle('listDesignFonts', (input) => ctx.designFonts.list(fontSession(input?.id)));
  handle('searchDesignFonts', (input) => ctx.designFonts.catalog(String(input?.query || '')));
  handle('acquireDesignFont', (input) =>
    mutateFonts(input?.id, (session, guard) =>
      ctx.designFonts.acquire(
        session,
        { fontId: input?.fontId, weights: input?.weights, styles: input?.styles, subsets: input?.subsets },
        undefined,
        guard,
      ),
    ),
  );
  handle('importDesignFonts', (input) =>
    mutateFonts(input?.id, async (session, guard) => {
      const selected = await dialog.showOpenDialog(ctx.window!, {
        title: '导入字体',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '字体', extensions: ['woff2', 'woff', 'ttf', 'otf'] }],
      });
      if (selected.canceled) return null;
      if (selected.filePaths.length > 8) throw Error('一次最多导入 8 个字体文件');
      const imported: import('../../shared/types/design-font-types').DesignFont[] = [];
      for (const path of selected.filePaths) {
        guard();
        imported.push(...(await ctx.designFonts.importFile(session, path, { beforeWrite: guard })));
      }
      return imported;
    }),
  );
  handle('applyDesignFont', (input) =>
    mutateFonts(input?.id, async (session, guard) => {
      guard();
      const result = await applyDesignFont(
        ctx.designerFiles,
        session,
        ctx.designFonts.list(session),
        { fontId: input?.fontId, role: input?.role, path: input?.path },
        guard,
      );
      guard();
      ctx.designStore.userEdit(session.botId, result.path, result.sha256, '应用项目字体');
      return result;
    }),
  );
  handle('checkDesignFonts', async (input) => {
    const session = fontSession(input?.id);
    let text = input?.text;
    if (text !== undefined && (typeof text !== 'string' || text.length > 20000)) throw Error('检测文本最多 20000 字');
    if (!text)
      try {
        text = await designFontText(ctx.designerFiles, session, input?.path);
      } catch {
        if (input?.path) throw Error('无法读取指定 HTML');
        text = 'Aa 0123 中文';
      }
    return ctx.designFonts.check(session, { text, family: input?.family });
  });
  const canvasExports = new CanvasExports({
    getSession: (id) => ctx.designStore.get(id),
    files: ctx.designerFiles,
    fonts: ctx.designFonts,
    render: renderCanvasExport,
    choosePath: async (input) => {
      const result = await dialog.showSaveDialog(ctx.window!, {
        title: input.title,
        defaultPath: input.name,
        filters: [{ name: input.title, extensions: [input.extension] }],
      });
      return result.canceled ? null : result.filePath || null;
    },
  });
  handle('exportDesignFile', (input) => canvasExports.export(input));
  handle('exportDesignProject', async (input) => {
    const session = fontSession(input?.id),
      path = await designHtmlPath(ctx.designerFiles, session, input?.path);
    const target = await dialog.showSaveDialog(ctx.window!, {
      title: '导出设计项目',
      defaultPath: basename(path).replace(/\.html?$/i, '') + '.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (target.canceled || !target.filePath) return null;
    const bytes = await exportDesignHtmlBundle({
      rootDir: session.workspaceDir!,
      htmlPath: ctx.designerFiles.absolute(session, path),
    });
    writeFileSync(target.filePath, bytes);
    return target.filePath;
  });
  handle('designSystem', (id) => ctx.designSystems.detail(String(id)));
  handle('createDesignSession', (input) => ctx.designStore.create(input));
  handle('updateDesignSession', (input) => ctx.designStore.update(input));
  handle('sendDesignMessage', (input) => {
    const session = ctx.designStore.get(String(input?.id)),
      message = String(input?.message || '');
    if (fontMutationSessions.has(session.id)) throw Error('字体正在处理中，请稍后发送');
    if (session.origin.kind === 'bot')
      return ctx.chatPins!.send({
        botId: session.botId,
        message,
        designSessionId: session.id,
        attachmentIds: input.attachmentIds,
      });
    if (session.origin.kind === 'group') {
      const bot = ctx.store.bot(session.botId),
        text = '@' + bot.name + ' ' + message;
      return ctx.groupChats!.send({
        id: session.origin.id,
        message: text,
        designSessionId: session.id,
        attachmentIds: input.attachmentIds,
        mentions: [{ id: bot.id, name: bot.name, color: bot.color, start: 0, end: bot.name.length + 1 }],
      });
    }
    throw Error('请通过原 Bot 协作私聊继续这个设计任务');
  });
  handle('acceptDesignSession', (input) => {
    const session = ctx.designStore.get(String(input?.id));
    if (
      session.revision !== input.revision ||
      session.activeRunId ||
      !session.artifacts.length ||
      !session.checks.some((check) => check.id === 'format' && check.status === 'passed')
    )
      throw Error('请先完成当前设计的文件检查并刷新任务');
    session.status = 'completed';
    ctx.designStore.touch(session);
  });
  handle('listDesignWorkspace', (id) => ctx.designerFiles.list(ctx.designStore.get(String(id)).botId, String(id)));
  handle('importDesignSystem', async () => {
    if (!ctx.window || ctx.window.isDestroyed()) throw Error('窗口不可用');
    const picked = await dialog.showOpenDialog(ctx.window, {
      properties: ['openDirectory'],
      title: '选择包含 DESIGN.md 的设计系统文件夹',
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const system = ctx.designSystems.importFolder(picked.filePaths[0]);
    ctx.changed();
    return {
      id: system.id,
      name: system.name,
      category: system.category,
      description: system.description || '',
      version: system.version,
      bytes: system.bytes,
      colors: system.colors,
      source: system.source,
      license: system.license,
      origin: 'custom' as const,
    };
  });
}
