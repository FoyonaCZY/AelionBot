import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { HostDesktop, blockedApp, covered, hostKeys } from '../electron/core/host/desktop/host-desktop';
import type {
  DesktopCapture,
  DesktopDriver,
  DesktopStatus,
  DesktopWindow,
  InputStep,
  MenuResult,
} from '../electron/core/host/desktop/desktop-helper';
import type { HostComputerSettings } from '../shared/types/permission-types';
import { AppError } from '../shared/errors';

const OWN = 'C:\\Program Files\\AelionBot\\AelionBot.exe';
const windowOf = (id: number, exe: string, extra: Partial<DesktopWindow> = {}): DesktopWindow => ({
  id,
  title: 'Window ' + id,
  className: 'Test',
  pid: id,
  exe,
  name: exe
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(exe|app)$/, ''),
  minimized: false,
  foreground: false,
  elevated: false,
  x: 100,
  y: 50,
  width: 800,
  height: 600,
  ...extra,
});
interface Options {
  /** False for a system host Computer Use does not support. */
  supported?: boolean;
  platform?: string;
  ownExe?: string;
  quietLaunch?: boolean;
  status?: Partial<DesktopStatus>;
  menu?: (path: string[]) => MenuResult;
}
function setup(t: Parameters<typeof tempDir>[0], options: Options = {}) {
  // Front to back, as the system lists them.
  const windows = new Map<number, DesktopWindow>([
    [1, windowOf(1, 'C:\\Apps\\Notes\\Notes.exe')],
    [2, windowOf(2, 'C:\\Program Files\\WindowsApps\\Terminal\\WindowsTerminal.exe')],
    [3, windowOf(3, 'C:\\Apps\\Admin\\Admin.exe', { elevated: true })],
    [4, windowOf(4, OWN)],
  ]);
  type Entry = { op: string; window?: number; steps?: InputStep[]; value?: string; front?: boolean; at?: object };
  const log: Entry[] = [],
    asked: string[] = [],
    escapes: number[] = [],
    cue = { shown: 0, ended: 0 },
    // Controls with no action of their own, and whether the window scrolls without the pointer.
    plain = new Set<number>(),
    quirks = { scrolls: true, blank: false, failInput: -1 },
    status: DesktopStatus = { elevated: false, display: [0, 0, 1920, 1080], ...options.status };
  let settings: HostComputerSettings = { enabled: true },
    answer: 'allow' | 'deny' | Promise<void> = 'allow',
    front: DesktopWindow | null = null,
    changes = 0;
  const running = new Set<string>(['run-1', 'run-2', 'run-3']);
  const driver: DesktopDriver = {
    quietLaunch: options.quietLaunch === true,
    status: async () => {
      log.push({ op: 'status' });
      return status;
    },
    listWindows: async () => [...windows.values()],
    listApps: async () => [
      { name: 'Notes', id: 'notes.app' },
      { name: 'Notes Beta', id: 'notes.beta' },
      { name: 'Paint', id: 'paint.app' },
      { name: 'Pages', id: '/Applications/Pages.app' },
    ],
    launch: async (id) => {
      log.push({ op: 'launch:' + id });
      front = windows.get(1)!;
      if (id.startsWith('/')) windows.set(9, windowOf(9, id));
    },
    window: async (id) => {
      const window = windows.get(id);
      if (!window) throw new AppError('computer.host_window_gone', 'gone');
      return window;
    },
    foreground: async () => front,
    capture: async (id, _file, { text, front }): Promise<DesktopCapture> => {
      if (!front && quirks.blank) throw new AppError('computer.host_blank', 'blank');
      log.push({ op: 'capture', window: id, front });
      // An 800-pixel-wide window shown at half size: image pixels are half of screen pixels.
      return {
        ...windows.get(id)!,
        originX: 100,
        originY: 50,
        scale: 0.5,
        imageWidth: 400,
        imageHeight: 300,
        ...(text
          ? {
              text: '0 Button "OK" [10,20 40x20]\n1 Edit "Name" [10,60 200x20]\n',
              elements: [
                [10, 20, 40, 20],
                [10, 60, 200, 20],
              ],
            }
          : {}),
      };
    },
    input: async (id, steps) => {
      if (log.filter((item) => item.op === 'input').length === quirks.failInput)
        throw new AppError('computer.host_obscured', 'covered');
      log.push({ op: 'input', window: id, steps });
    },
    press: async (id, element, count) => {
      if (plain.has(element)) throw new AppError('computer.host_unsupported', 'no action');
      log.push({ op: `press:${element}x${count}`, window: id });
    },
    scroll: async (id, at) => {
      if (!quirks.scrolls) throw new AppError('computer.host_unsupported', 'no scrolling');
      log.push({ op: 'scroll', window: id, at });
    },
    setValue: async (id, element, value) => void log.push({ op: 'set_value:' + element, window: id, value }),
    ...(options.menu
      ? {
          menu: async (id: number, path: string[]) => {
            log.push({ op: 'menu:' + path.join('>'), window: id });
            return options.menu!(path);
          },
        }
      : {}),
    requestPermission: async (kind) => void log.push({ op: 'request:' + kind }),
    dispose: () => void log.push({ op: 'dispose' }),
  };
  const desktop = new HostDesktop({
    driver: options.supported === false ? undefined : driver,
    imageDir: tempDir(t, 'aelion-host-desktop-'),
    settings: { read: () => settings, write: (next) => void (settings = next) },
    requestAccess: async (_botId, runId) => {
      asked.push(runId);
      if (answer === 'deny') throw new AppError('permission.denied', 'denied');
      if (answer !== 'allow') await answer;
    },
    running: (runId) => running.has(runId),
    changed: () => void changes++,
    presence: {
      foreground: async () => void cue.shown++,
      end: () => void cue.ended++,
      passEscape: async (work) => {
        escapes.push(ops().length);
        return work();
      },
    },
    platform: options.platform ?? 'win32',
    ownExe: options.ownExe ?? OWN,
    sleep: async () => {},
  });
  /** What reached the desktop, in order; reading the status does not. */
  const ops = () => log.filter((item) => item.op !== 'status' && item.op !== 'dispose');
  return {
    desktop,
    log,
    ops,
    names: () => ops().map((item) => item.op),
    windows,
    asked,
    escapes,
    cue,
    plain,
    quirks,
    status,
    running,
    changes: () => changes,
    signal: new AbortController().signal,
    settings: () => settings,
    set: (value: Partial<{ answer: typeof answer; settings: HostComputerSettings }>) => {
      if (value.answer) answer = value.answer;
      if (value.settings) settings = value.settings;
    },
  };
}
const inputs = (entries: Array<{ op: string; steps?: InputStep[] }>) =>
  entries.filter((item) => item.op === 'input').map((item) => item.steps!);

test('terminals and the app itself are never operable, and system-wide shortcuts are refused', () => {
  assert.ok(blockedApp('C:\\Windows\\System32\\cmd.exe', OWN));
  assert.ok(blockedApp('C:\\Program Files\\PowerShell\\7\\PWSH.EXE', OWN));
  assert.ok(blockedApp('C:\\X\\WindowsTerminal.exe', OWN));
  assert.ok(blockedApp(OWN.toUpperCase(), OWN));
  assert.equal(blockedApp('C:\\Windows\\notepad.exe', OWN), undefined);
  // On macOS a window names the app bundle, and the app's own executable is inside its bundle.
  const mac = '/Applications/AelionBot.app/Contents/MacOS/AelionBot';
  assert.ok(blockedApp('/Applications/AelionBot.app', mac));
  assert.ok(blockedApp('/System/Applications/Utilities/Terminal.app', mac));
  assert.ok(blockedApp('/Applications/iTerm.app', mac));
  assert.ok(blockedApp('/System/Applications/Utilities/Script Editor.app', mac));
  assert.equal(blockedApp('/Applications/Aelion.app', mac), undefined);
  assert.equal(blockedApp('/System/Applications/Notes.app', mac), undefined);
  assert.deepEqual(hostKeys('ctrl+shift+s', 'win32'), [0x11, 0x10, 0x53]);
  assert.deepEqual(hostKeys('F5', 'win32'), [0x74]);
  assert.deepEqual(hostKeys('ALT+F4', 'win32'), [0x12, 0x73]);
  for (const chord of ['WIN+R', 'CMD+C', 'ALT+TAB', 'CTRL+ESC', 'CTRL+ALT+DELETE'])
    assert.throws(() => hostKeys(chord, 'win32'), { code: 'computer.key_blocked' });
  assert.throws(() => hostKeys('CTRL+CTRL', 'win32'));
  assert.throws(() => hostKeys('CTRL+CONTROL', 'win32'));
  assert.throws(() => hostKeys('CTRL+$(x)', 'win32'));
  // The Mac's own modifier is a key like any other there; what leaves the app is still refused.
  assert.deepEqual(hostKeys('CMD+S', 'darwin'), [0x5b, 0x53]);
  assert.deepEqual(hostKeys('command+option+i', 'darwin'), [0x5b, 0x12, 0x49]);
  assert.deepEqual(hostKeys('CMD+Q', 'darwin'), [0x5b, 0x51]);
  for (const chord of ['CMD+TAB', 'CMD+SPACE', 'CMD+OPTION+ESC', 'CTRL+CMD+Q', 'CMD+SHIFT+Q', 'CTRL+LEFT'])
    assert.throws(() => hostKeys(chord, 'darwin'), { code: 'computer.key_blocked' });
});
test('a window counts as covered only when the ones in front leave nothing of it showing', () => {
  const target = { x: 100, y: 100, width: 800, height: 600 },
    display = [0, 0, 1920, 1080];
  assert.equal(covered(target, [], display), false);
  assert.equal(covered(target, [{ x: 0, y: 0, width: 1920, height: 1080 }], display), true);
  // Two windows that cover it between them.
  const left = { x: 0, y: 0, width: 500, height: 1080 },
    right = { x: 500, y: 0, width: 1000, height: 1080 };
  assert.equal(covered(target, [left, right], display), true);
  assert.equal(covered(target, [left], display), false);
  // A corner still shows.
  assert.equal(covered(target, [left, { x: 500, y: 0, width: 1000, height: 650 }], display), false);
  // A few pixels of border are not something showing.
  assert.equal(covered(target, [{ x: 104, y: 100, width: 800, height: 600 }], display), true);
  // The part that hangs off the desktop cannot show either.
  const hanging = { x: 1500, y: 100, width: 800, height: 600 };
  assert.equal(covered(hanging, [{ x: 1400, y: 0, width: 520, height: 1080 }], display), true);
  assert.equal(covered(hanging, [{ x: 1400, y: 0, width: 520, height: 1080 }]), false);
});
test('a task asks once before its first action, whatever it does afterwards', async (t) => {
  const { desktop, names, asked, cue, signal } = setup(t);
  const run = (input: Parameters<HostDesktop['execute']>[2]) => desktop.execute('bot', 'run-1', input, signal);
  // Listing windows already shows the Bot what is open, so it counts as entering.
  await run({ action: 'list_windows' });
  assert.deepEqual(asked, ['run-1']);
  await run({ action: 'list_apps' });
  const seen = await run({ action: 'get_window_state', window: 1 });
  await run({ action: 'click', window: 1, observationId: seen.screenshot!.id, x: 10, y: 10 });
  await run({ action: 'launch_app', app: 'paint' });
  assert.deepEqual(asked, ['run-1']);
  assert.ok(names().includes('launch:paint.app'));
  // The next task asks again.
  desktop.release('run-1');
  assert.equal(cue.ended, 1);
  await desktop.execute('bot', 'run-2', { action: 'list_apps' }, signal);
  assert.deepEqual(asked, ['run-1', 'run-2']);
});
test('the computer is held while the user decides, and looking at a window shows no cue', async (t) => {
  const { desktop, ops, names, cue, signal, set } = setup(t);
  let allow!: () => void;
  set({ answer: new Promise<void>((resolve) => (allow = resolve)) });
  const waiting = desktop.execute('bot', 'run-1', { action: 'get_window_state', window: 1 }, signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(desktop.current, { botId: 'bot', runId: 'run-1' });
  assert.equal(ops().length, 0);
  await assert.rejects(() => desktop.execute('other', 'run-2', { action: 'list_apps' }, signal), {
    code: 'computer.in_use_elsewhere',
  });
  allow();
  await waiting;
  assert.deepEqual(names(), ['capture']);
  // The window was read where it is: nothing came to the front, so there is nothing to warn the user about.
  assert.equal(ops()[0].front, false);
  assert.equal(cue.shown, 0);
});
test('a refusal holds for the whole task and frees the computer for others', async (t) => {
  const { desktop, ops, asked, cue, signal, set } = setup(t);
  const observe = (runId: string) => desktop.execute('bot', runId, { action: 'get_window_state', window: 1 }, signal);
  set({ answer: 'deny' });
  await assert.rejects(() => observe('run-1'), { code: 'permission.denied' });
  await assert.rejects(() => observe('run-1'), { code: 'permission.denied' });
  await assert.rejects(() => desktop.execute('bot', 'run-1', { action: 'list_windows' }, signal), {
    code: 'permission.denied',
  });
  assert.deepEqual(asked, ['run-1']);
  assert.equal(ops().length, 0);
  assert.equal(cue.shown, 0);
  assert.equal(desktop.current, undefined);
  set({ answer: 'allow' });
  await observe('run-2');
  assert.deepEqual(asked, ['run-1', 'run-2']);
  // Once the refused task has ended, a later one with the same id would be asked afresh.
  desktop.release('run-1');
  desktop.release('run-2');
  await observe('run-1');
  assert.deepEqual(asked, ['run-1', 'run-2', 'run-1']);
});
test('a click at coordinates is bound to the latest observation and takes the window to the front under the cue', async (t) => {
  const { desktop, ops, cue, signal } = setup(t);
  const click = (observationId: string | undefined, x: number, y: number) =>
    desktop.execute('bot', 'run-1', { action: 'click', window: 1, observationId, x, y, button: 'right' }, signal);
  await assert.rejects(() => click(undefined, 1, 1), { code: 'computer.observation_stale' });
  const seen = await desktop.execute('bot', 'run-1', { action: 'get_window_state', window: 1 }, signal);
  assert.deepEqual(seen.screenshot && [seen.screenshot.width, seen.screenshot.height], [400, 300]);
  await assert.rejects(() => click('old', 1, 1), { code: 'computer.observation_stale' });
  await assert.rejects(() => click(seen.screenshot!.id, 400, 1));
  assert.equal(inputs(ops()).length, 0);
  assert.equal(cue.shown, 0);
  const clicked = await click(seen.screenshot!.id, 200, 100);
  // Image (200, 100) at half scale from origin (100, 50) is screen (500, 250).
  assert.deepEqual(inputs(ops())[0].slice(0, 3), [
    { t: 'move', x: 500, y: 250 },
    { t: 'down', button: 2, n: 1 },
    { t: 'sleep', ms: 40 },
  ]);
  assert.equal(cue.shown, 1);
  // The window is in front now, so what follows the click is read from the screen.
  assert.deepEqual(
    ops().map((item) => [item.op, item.front]),
    [
      ['capture', false],
      ['input', undefined],
      ['capture', true],
    ],
  );
  assert.notEqual(clicked.screenshot!.id, seen.screenshot!.id);
  await assert.rejects(() => click(seen.screenshot!.id, 1, 1), { code: 'computer.observation_stale' });
});
test('what a control can do for itself happens in the background, and the rest falls back to real input', async (t) => {
  const { desktop, ops, names, log, cue, plain, quirks, signal } = setup(t);
  const run = (input: Parameters<HostDesktop['execute']>[2]) => desktop.execute('bot', 'run-1', input, signal);
  let seen = await run({ action: 'get_window_state', window: 1, includeText: true });
  const act = async (input: Omit<Parameters<HostDesktop['execute']>[2], 'window' | 'observationId'>) => {
    log.length = 0;
    seen = await run({ ...input, window: 1, observationId: seen.screenshot!.id, includeText: true } as Parameters<
      HostDesktop['execute']
    >[2]);
    return ops().map((item) => [item.op, item.front]);
  };
  // Pressing a button, setting a value and scrolling leave the window where it is: no cue, no real input.
  assert.deepEqual(await act({ action: 'click', element: 0 }), [
    ['press:0x1', undefined],
    ['capture', false],
  ]);
  assert.deepEqual(await act({ action: 'click', element: 0, count: 2 }), [
    ['press:0x2', undefined],
    ['capture', false],
  ]);
  assert.deepEqual(await act({ action: 'set_value', element: 1, value: 'Ada' }), [
    ['set_value:1', undefined],
    ['capture', false],
  ]);
  await act({ action: 'scroll', element: 1, direction: 'down', amount: 4 });
  // Element 1 is centred at image (110, 70): screen (320, 190). Down is a negative wheel.
  assert.deepEqual(ops()[0], { op: 'scroll', window: 1, at: { x: 320, y: 190, dx: 0, dy: -4, element: 1 } });
  await act({ action: 'scroll', x: 200, y: 150, direction: 'up' });
  assert.deepEqual(ops()[0].at, { x: 500, y: 350, dx: 0, dy: 3 });
  // Waiting is the Bot's own time, not something the desktop is asked to do.
  assert.deepEqual(await act({ action: 'wait', milliseconds: 500 }), [['capture', false]]);
  assert.equal(cue.shown, 0);
  // A text field has no press of its own, a right click none either, and this window does not scroll by itself.
  plain.add(1);
  assert.deepEqual(await act({ action: 'click', element: 1 }), [
    ['input', undefined],
    ['capture', true],
  ]);
  assert.deepEqual(inputs(ops())[0][0], { t: 'move', x: 320, y: 190 });
  assert.equal(cue.shown, 1);
  await act({ action: 'click', element: 0, button: 'right' });
  assert.deepEqual(names(), ['input', 'capture']);
  quirks.scrolls = false;
  await act({ action: 'scroll', element: 0, direction: 'down' });
  assert.deepEqual(inputs(ops())[0], [
    { t: 'move', x: 160, y: 110 },
    { t: 'wheel', dx: 0, dy: -3 },
  ]);
  assert.equal(cue.shown, 3);
  // Typing and keys are real input by nature.
  assert.deepEqual(await act({ action: 'type_text', text: 'hi' }), [
    ['input', undefined],
    ['capture', true],
  ]);
  // A failure that is not "this control cannot" is the Bot's to hear about, not a reason to click instead.
  plain.clear();
  const { desktop: other, signal: otherSignal } = setup(t);
  const first = await other.execute('bot', 'run-1', { action: 'get_window_state', window: 1 }, otherSignal);
  await assert.rejects(
    () =>
      other.execute(
        'bot',
        'run-1',
        { action: 'click', window: 1, observationId: first.screenshot!.id, element: 7 },
        otherSignal,
      ),
    { code: 'computer.host_element_stale' },
  );
});
test('a window that has no current picture of its own is brought to the front to be seen', async (t) => {
  const { desktop, ops, windows, cue, quirks, signal } = setup(t);
  const look = async (window: number) => {
    const before = ops().length;
    await desktop.execute('bot', 'run-1', { action: 'get_window_state', window }, signal);
    return ops()
      .slice(before)
      .map((item) => item.front);
  };
  // A browser-based app stops drawing while other windows cover it: its own picture would be an old one.
  windows.clear();
  windows.set(5, windowOf(5, 'C:\\Apps\\Cover\\Cover.exe', { x: 0, y: 0, width: 1920, height: 1080 }));
  windows.set(6, windowOf(6, 'C:\\Apps\\Browser\\Browser.exe', { pausesWhenCovered: true }));
  windows.set(7, windowOf(7, 'C:\\Apps\\Native\\Native.exe'));
  assert.deepEqual(await look(6), [true]);
  assert.equal(cue.shown, 1);
  // An app that keeps drawing is read where it is, covered or not.
  assert.deepEqual(await look(7), [false]);
  // Partly showing, the browser keeps drawing too.
  windows.get(5)!.width = 500;
  assert.deepEqual(await look(6), [false]);
  // Minimized, it has nothing to show; in front, it is showing.
  windows.get(6)!.minimized = true;
  assert.deepEqual(await look(6), [true]);
  windows.get(6)!.minimized = false;
  windows.get(5)!.width = 1920;
  windows.get(6)!.foreground = true;
  assert.deepEqual(await look(6), [false]);
  assert.equal(cue.shown, 2);
  // A window that gives no picture of itself at all is read from the screen instead.
  quirks.blank = true;
  assert.deepEqual(await look(7), [true]);
  assert.equal(cue.shown, 3);
});
test('terminal, own and elevated windows stay out of reach after the task was allowed', async (t) => {
  const { desktop, ops, asked, signal } = setup(t);
  const observe = (window: number) => desktop.execute('bot', 'run-1', { action: 'get_window_state', window }, signal);
  await assert.rejects(() => observe(2), { code: 'computer.app_blocked' });
  await assert.rejects(() => observe(4), { code: 'computer.app_blocked' });
  await assert.rejects(() => observe(3), { code: 'computer.app_elevated' });
  assert.equal(ops().length, 0);
  assert.deepEqual(asked, ['run-1']);
  const listed = await desktop.execute('bot', 'run-1', { action: 'list_windows' }, signal);
  assert.deepEqual(
    listed.windows!.map((window) => [window.window, Boolean(window.unavailable)]),
    [
      [1, false],
      [2, true],
      [3, false],
    ],
  );
});
test('one task holds the computer at a time, and nothing runs while the feature is off', async (t) => {
  const { desktop, asked, signal, running, set } = setup(t);
  const observe = (botId: string, runId: string) =>
    desktop.execute(botId, runId, { action: 'get_window_state', window: 1 }, signal);
  await observe('bot', 'run-1');
  assert.deepEqual(desktop.current, { botId: 'bot', runId: 'run-1' });
  await assert.rejects(() => observe('other', 'run-2'), { code: 'computer.in_use_elsewhere' });
  assert.deepEqual(asked, ['run-1']);
  // A holder that is no longer running gives the computer up.
  running.delete('run-1');
  await observe('other', 'run-2');
  assert.equal(desktop.current?.runId, 'run-2');
  desktop.release('run-2');
  assert.equal(desktop.current, undefined);
  set({ settings: { enabled: false } });
  assert.equal(desktop.enabled, false);
  await assert.rejects(() => desktop.execute('bot', 'run-3', { action: 'list_windows' }, signal), {
    code: 'computer.host_disabled',
  });
  assert.deepEqual(asked, ['run-1', 'run-2']);
  // A system without a driver does not offer the feature, whatever the setting says.
  const unsupported = setup(t, { supported: false }).desktop;
  assert.deepEqual([unsupported.available, unsupported.enabled], [false, false]);
});
test('a batch plans every step first, runs them in order with one screenshot, and names the step that failed', async (t) => {
  const { desktop, log, ops, names, escapes, cue, plain, quirks, signal } = setup(t);
  const seen = await desktop.execute(
    'bot',
    'run-1',
    { action: 'get_window_state', window: 1, includeText: true },
    signal,
  );
  assert.match(seen.text!, /Button "OK"/);
  const batch = (actions: NonNullable<Parameters<HostDesktop['execute']>[2]['actions']>, observationId: string) =>
    desktop.execute('bot', 'run-1', { action: 'batch', window: 1, observationId, actions }, signal);
  log.length = 0;
  plain.add(1);
  const done = await batch(
    [
      { action: 'click', element: 1 },
      { action: 'type_text', text: '你好' },
      { action: 'set_value', element: 0, value: 'v' },
      { action: 'click', element: 0 },
      { action: 'press_key', key: 'ESC' },
    ],
    seen.screenshot!.id,
  );
  // Each step goes the quietest way it can; one that used real input leaves the window in front for the screenshot.
  assert.deepEqual(names(), ['input', 'input', 'set_value:0', 'press:0x1', 'input', 'capture']);
  assert.equal(ops().at(-1)!.front, true);
  // Element 1 is centred at image (110, 70): screen (320, 190).
  assert.deepEqual(inputs(ops())[0][0], { t: 'move', x: 320, y: 190 });
  assert.deepEqual(inputs(ops())[1], [{ t: 'text', text: '你好' }]);
  assert.deepEqual(inputs(ops())[2], [{ t: 'key', keys: [0x1b] }]);
  // Only the step that presses Escape is let past the cancel key.
  assert.deepEqual(escapes, [4]);
  assert.equal(cue.shown, 3);
  log.length = 0;
  await assert.rejects(() =>
    batch(
      [
        { action: 'click', x: 1, y: 1 },
        { action: 'press_key', key: 'WIN+R' },
      ],
      done.screenshot!.id,
    ),
  );
  await assert.rejects(() => batch([{ action: 'get_window_state' }], done.screenshot!.id));
  await assert.rejects(() => batch([{ action: 'select_menu', menu: 'File > Save' }], done.screenshot!.id));
  assert.equal(ops().length, 0);
  quirks.failInput = 1;
  await assert.rejects(
    () =>
      batch(
        [
          { action: 'click', x: 1, y: 1 },
          { action: 'click', x: 2, y: 2 },
          { action: 'type_text', text: 'never' },
        ],
        done.screenshot!.id,
      ),
    (error: AppError) => error.code === 'computer.host_obscured' && error.message.includes('第 2 步'),
  );
  assert.equal(inputs(ops()).length, 1);
});
test('launching works with the window that came to the front', async (t) => {
  const { desktop, ops, names, asked, cue, signal } = setup(t);
  const launch = (app: string) => desktop.execute('bot', 'run-1', { action: 'launch_app', app }, signal);
  await assert.rejects(() => launch('nope'), { code: 'computer.app_not_found' });
  await assert.rejects(() => launch('not'), { code: 'computer.app_ambiguous' });
  assert.equal(cue.shown, 0);
  const opened = await launch('notes');
  // Windows gives a new app the foreground, so starting one goes under the cue like any real input.
  assert.equal(cue.shown, 1);
  assert.deepEqual(names(), ['launch:notes.app', 'capture']);
  assert.equal(ops().at(-1)!.front, true);
  assert.equal(opened.window?.window, 1);
  assert.deepEqual(asked, ['run-1']);
});
test('on macOS an app starts behind the one in use, and its menu bar is reached by path', async (t) => {
  const bar: Record<string, string[]> = { '': ['File', 'Edit'], File: ['New', 'Export'], 'File>Export': ['PDF…'] };
  const { desktop, ops, names, cue, signal } = setup(t, {
    platform: 'darwin',
    ownExe: '/Applications/AelionBot.app/Contents/MacOS/AelionBot',
    quietLaunch: true,
    status: { accessibility: true, screenRecording: true },
    menu: (path) => {
      const at = path.slice(0, -1),
        items = bar[at.join('>')] || [];
      if (!items.includes(path.at(-1)!)) return { pressed: false, at, items };
      const inside = bar[path.join('>')];
      return inside ? { pressed: false, submenu: true, at: path, items: inside } : { pressed: true, at: path };
    },
  });
  const run = (input: Parameters<HostDesktop['execute']>[2]) => desktop.execute('bot', 'run-1', input, signal);
  const opened = await run({ action: 'launch_app', app: 'pages' });
  // The new window is the one whose app is the bundle that was opened; nothing came to the front.
  assert.deepEqual(names(), ['launch:/Applications/Pages.app', 'capture']);
  assert.deepEqual([opened.window?.window, ops().at(-1)!.front, cue.shown], [9, false, 0]);
  await run({ action: 'select_menu', window: 9, menu: 'File > Export > PDF…' });
  assert.deepEqual(names().slice(2), ['menu:File>Export>PDF…', 'capture']);
  assert.equal(cue.shown, 0);
  // A path that stops short or goes astray answers with what is there, so the Bot can choose.
  await assert.rejects(
    () => run({ action: 'select_menu', window: 9, menu: 'File > Export' }),
    (error: AppError) => error.code === 'computer.menu_incomplete' && error.message.includes('PDF…'),
  );
  await assert.rejects(
    () => run({ action: 'select_menu', window: 9, menu: 'File > Print' }),
    (error: AppError) => error.code === 'computer.menu_not_found' && error.message.includes('New、Export'),
  );
  await assert.rejects(() => run({ action: 'select_menu', window: 9 }));
  // The Mac's own modifier reaches the app.
  const seen = await run({ action: 'get_window_state', window: 9 });
  await run({ action: 'press_key', window: 9, observationId: seen.screenshot!.id, key: 'CMD+S' });
  assert.deepEqual(inputs(ops()).at(-1), [{ t: 'key', keys: [0x5b, 0x53] }]);
  // Without a menu bar outside the window there is no such action.
  const windows = setup(t);
  await assert.rejects(() =>
    windows.desktop.execute('bot', 'run-1', { action: 'select_menu', window: 1, menu: 'File' }, windows.signal),
  );
});
test('on macOS nothing is attempted, and the user is not asked, until the system has granted its permissions', async (t) => {
  const { desktop, names, asked, status, changes, signal } = setup(t, {
    platform: 'darwin',
    status: { accessibility: false, screenRecording: true },
  });
  const look = () => desktop.execute('bot', 'run-1', { action: 'get_window_state', window: 1 }, signal);
  assert.equal(desktop.view().permissions, undefined);
  await assert.rejects(
    look,
    (error: AppError) => error.code === 'computer.host_permission' && /辅助功能/.test(error.message),
  );
  assert.deepEqual(asked, []);
  assert.deepEqual(names(), []);
  assert.equal(desktop.current, undefined);
  // The settings page shows what is missing, and hears about it once.
  assert.deepEqual(desktop.view().permissions, { accessibility: false, screenRecording: true });
  assert.equal(changes(), 1);
  // Asking for a grant has the system prompt for it; the answer is read again afterwards.
  await desktop.checkPermissions('accessibility');
  assert.deepEqual(names(), ['request:accessibility']);
  assert.equal(changes(), 1);
  status.accessibility = true;
  await desktop.checkPermissions();
  assert.deepEqual(desktop.view().permissions, { accessibility: true, screenRecording: true });
  assert.equal(changes(), 2);
  await look();
  assert.deepEqual(asked, ['run-1']);
  // Windows has no such grants to show.
  const windows = setup(t);
  await windows.desktop.checkPermissions();
  await windows.desktop.execute('bot', 'run-1', { action: 'list_apps' }, windows.signal);
  assert.equal(windows.desktop.view().permissions, undefined);
});
