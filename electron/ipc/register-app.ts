import { runtimeSettings } from '../core/agent/runtime-policy';
import { normalizeUserProfile } from '../../shared/chat/user-profile';
import { app, dialog, shell, nativeTheme } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { UPDATE_REPOSITORY } from '../core/app/windows-updater';
import { externalWebUrl } from '../../shared/preview/external-links';
import type { IpcContext } from './context';

export function registerApp(ctx: IpcContext) {
  const { handle } = ctx;
  handle('saveAppearanceSettings', ctx.saveAppearance);
  handle('saveUserProfile', (value) => {
    ctx.store.data.userProfile = normalizeUserProfile(value);
    ctx.store.save();
    ctx.greetings?.cancelAll();
    ctx.changed();
    void ctx.greetings?.greetEmpty();
  });
  handle('saveRuntimeSettings', (value) => {
    ctx.store.data.runtime = runtimeSettings(value);
    ctx.store.save();
    ctx.changed();
  });
  handle('snapshot', ctx.snapshot);
  handle('openExternalUrl', (value) => {
    const url = externalWebUrl(value);
    if (!url) throw new Error('只能在浏览器中打开有效的 HTTP 或 HTTPS 链接');
    return shell.openExternal(url);
  });
  handle('updateState', () => ctx.appUpdates!.snapshot());
  handle('checkForUpdates', () => ctx.appUpdates!.check());
  handle('downloadUpdate', () => ctx.appUpdates!.download());
  handle('cancelUpdateDownload', () => ctx.appUpdates!.cancel());
  handle('installUpdate', () => ctx.appUpdates!.install());
  handle('openUpdateRelease', () => shell.openExternal(`https://github.com/${UPDATE_REPOSITORY}/releases/latest`));
  handle('prepareDiagnostics', () => ctx.diagnostics!.prepare());
  handle('exportDiagnostics', async (id) => {
    const report = ctx.diagnostics!.archive(id),
      target = await dialog.showSaveDialog(ctx.window!, {
        title: '导出诊断日志',
        defaultPath: join(app.getPath('downloads'), report.fileName),
        filters: [{ name: '诊断包', extensions: ['zip'] }],
      });
    if (target.canceled || !target.filePath) return null;
    await writeFile(target.filePath, report.bytes, { mode: 0o600 });
    return target.filePath;
  });
  handle('openDiagnosticIssue', (id) => shell.openExternal(ctx.diagnostics!.issueUrl(id, UPDATE_REPOSITORY)));
  handle('setWindowDimmed', (enabled, color) => {
    if (
      typeof enabled !== 'boolean' ||
      (color !== undefined && (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)))
    )
      throw new Error('无效窗口状态');
    ctx.appearanceDimmed = enabled;
    const background =
        color ||
        (enabled
          ? nativeTheme.shouldUseDarkColors
            ? '#161418'
            : '#b9b9b9'
          : nativeTheme.shouldUseDarkColors
            ? '#25232a'
            : '#f7f7f7'),
      brightness = [1, 3, 5].reduce((sum, index) => sum + parseInt(background.slice(index, index + 2), 16), 0) / 3;
    if (process.platform !== 'darwin')
      ctx.window?.setTitleBarOverlay({
        color: background,
        symbolColor: brightness < 128 ? '#f2f2f2' : '#555555',
        height: 38,
      });
  });
  handle('openData', () => shell.openPath(ctx.dataDir));
}
