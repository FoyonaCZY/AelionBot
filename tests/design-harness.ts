import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type test from 'node:test';
import { tempDir } from './helpers';
import { Store } from '../electron/core/storage/store';
import { DesignStore } from '../electron/core/designer/design-store';
import { DesignSystems } from '../electron/core/designer/design-systems';
import { DesignerFiles } from '../electron/core/designer/designer-files';
import { DesignWork, type DesignWorkExtras } from '../electron/core/designer/design-work';
import { ArtifactService } from '../electron/core/attachments/artifacts';
import { Attachments } from '../electron/core/attachments/attachments';
import { HostComputer } from '../electron/core/host/host';
import { Harness } from '../electron/core/agent/harness';
import { AgentPreviews } from '../electron/core/preview/agent-previews';
import type { DesignTaskKind } from '../shared/types/designer-types';
import type { HarnessRunOptions } from '../electron/core/agent/peer-runtime-types';

export const call = (name: string, args: unknown) => ({
  id: randomUUID(),
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** A one-package design system catalog ("sample") with the given tokens.css. */
function sampleCatalog(root: string, version = 'a'.repeat(40), tokens = ':root {--accent:red;}') {
  const dir = join(root, 'catalog-' + version);
  mkdirSync(join(dir, 'sample'), { recursive: true });
  const texts = {
    'DESIGN.md': '# Sample\nUse a restrained type scale.',
    'tokens.css': tokens,
    'components.html': '<main>Reference</main>',
  };
  const files = Object.entries(texts).map(([path, body]) => {
    writeFileSync(join(dir, 'sample', path), body);
    return { path, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  });
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      sourceCommit: version,
      sourceUrl: 'https://example.test',
      systems: [
        {
          id: 'sample',
          name: 'Sample',
          category: 'Product',
          description: 'Test fixture',
          version,
          bytes: files.reduce((n, f) => n + f.bytes, 0),
          colors: ['#123456'],
          source: 'https://example.test',
          license: 'Apache-2.0',
          files,
        },
      ],
    }),
  );
  return dir;
}

/** One model turn: the calls to make, then (with no calls) the final answer. */
export type Turn = { calls?: ReturnType<typeof call>[]; content?: string; native?: unknown };
interface ModelRequest {
  messages: any[];
  tools: string[];
}
type Script = (turn: number, requests: ModelRequest[]) => Turn;

/**
 * A general Bot with local design work wired as in the app: a real Harness, HostComputer and DesignWork, a stopped
 * work computer, and a scripted model. The task starts unbound unless a run passes its id as designSessionId.
 */
export function designHarness(
  t: test.TestContext,
  options: {
    kind?: DesignTaskKind;
    /** A sample design system catalog; the task is created with it selected. */
    catalog?: { tokens?: string };
    extras?: (context: { root: string; files: DesignerFiles; store: Store }) => DesignWorkExtras;
    /** Throw from it to deny a permission. */
    permission?: (details: any) => void | Promise<void>;
  } = {},
) {
  const root = tempDir(t, 'aelion-design-work-');
  const store = new Store(join(root, 'data'));
  const bot = store.data.bots[0];
  store.data.model.model = 'fixture';
  const base = join(root, 'default');
  const systems = options.catalog
    ? new DesignSystems(sampleCatalog(root, undefined, options.catalog.tokens))
    : ({ get: () => ({}), list: () => [], context: () => ({}) } as any);
  const designs = new DesignStore(
    store,
    systems,
    () => {},
    () => base,
  );
  const task = designs.create({
    botId: bot.id,
    kind: options.kind || 'prototype',
    brief: 'Create a usable design',
    ...(options.catalog ? { systemId: 'sample' } : {}),
  });
  const files = new DesignerFiles(store, designs);
  let vmCalls = 0;
  // A stopped work computer: its state can be read, nothing on it can run.
  const vm = new Proxy({ state: { status: 'stopped' } } as any, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'then') return undefined;
      vmCalls++;
      return () => {
        throw Error('design work must not use the work computer');
      };
    },
  });
  const artifacts = new ArtifactService(store, vm);
  artifacts.designerFiles = files;
  const attachments = new Attachments(store, vm, artifacts);
  const permissions: any[] = [];
  const interactions = {
    permission: async (_bot: string, _run: string, details: any) => {
      permissions.push(details);
      await options.permission?.(details);
    },
    pendingQuestions: () => [],
    cancelQuestions: () => {},
    hasAnswers: () => false,
    consumeAnswers: () => [],
    snapshot: () => [],
  };
  const host = new HostComputer({ dataDir: store.dir, projectDir: root, homeDir: root }, interactions as any);
  const requests: ModelRequest[] = [];
  let script: Script = () => ({ content: 'Done.' });
  const model = {
    complete: async (messages: any[], tools: any[]) => {
      requests.push({ messages: structuredClone(messages), tools: (tools || []).map((tool) => tool.function.name) });
      const turn = script(requests.length - 1, requests);
      return {
        content: turn.content ?? (turn.calls?.length ? 'Working' : 'Done.'),
        calls: turn.calls || [],
        finishReason: 'stop',
        ...(turn.native ? { native: turn.native } : {}),
      };
    },
  };
  const harness = new Harness(
    store,
    vm,
    model as any,
    () => {},
    undefined,
    (botId, runId) => artifacts.collect(botId, runId),
    undefined,
    host,
    interactions as any,
    undefined,
    attachments,
  );
  const previews = new AgentPreviews(store, artifacts, attachments, () => {}, host);
  const design = new DesignWork(
    store,
    designs,
    systems,
    files,
    artifacts,
    attachments,
    interactions as any,
    model as any,
    {
      resolvePath: (path, workspace) => host.resolveFilePath(path, workspace),
      ...options.extras?.({ root, files, store }),
    },
  );
  harness.setPreviewGateway(previews);
  harness.setDesignWork(design);
  t.after(() => {
    harness.disposeTools();
    host.dispose();
  });
  return {
    root,
    store,
    bot,
    systems,
    designs,
    task,
    files,
    artifacts,
    attachments,
    host,
    harness,
    design,
    previews,
    permissions,
    requests,
    vmCalls: () => vmCalls,
    /** Absolute path of a file in the task folder. */
    path: (name: string) => join(task.workspaceDir!, name),
    /** The task as stored now. */
    current: () => designs.get(task.id),
    /** Everything the model saw and the run reported, for matching tool results and errors. */
    transcript: () =>
      JSON.stringify(requests.map((r) => r.messages)) +
      '\n' +
      (store.data.runs.at(-1)?.error || '') +
      '\n' +
      store.data.messages
        .filter((m) => m.runId === store.data.runs.at(-1)?.id)
        .map((m) => m.content)
        .join('\n'),
    /** Runs one request with the scripted turns; returns the run record. */
    async run(input: string, turns: Turn[] | Script, runOptions: HarnessRunOptions = {}) {
      requests.length = 0;
      script = Array.isArray(turns) ? (turn) => turns[turn] || { content: 'Done.' } : turns;
      await harness.run(bot.id, input, runOptions);
      return store.data.runs.at(-1)!;
    },
    /** Runs bound to the fixture task. */
    async runTask(input: string, turns: Turn[] | Script, runOptions: HarnessRunOptions = {}) {
      return this.run(input, turns, { designSessionId: task.id, ...runOptions });
    },
  };
}
