import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

import type { JsonValue } from '@aelionsdk/core';

import {
  migrateDiffusionCheckpoint,
  migrateWebAvProject,
  type DiffusionAssetBinding,
  type MigrationDiagnostic,
  type MigrationResult,
  type WebAvAssetBinding,
  type WebAvProjectSnapshot,
} from './migration.js';

export type MigrationSource = 'webav' | 'diffusion';

export interface MigrateProjectFileOptions {
  readonly source: MigrationSource;
  readonly inputPath: string;
  readonly assetsPath?: string;
  readonly outputPath?: string;
  readonly reportPath?: string;
  /** Reject migrations with unsupported rendering semantics. Defaults to true. */
  readonly strict?: boolean;
  /** Generate and validate the project without writing it. */
  readonly dryRun?: boolean;
}

export interface ProjectMigrationFileReport {
  readonly reportVersion: '1.0.0';
  readonly source: MigrationSource;
  readonly inputPath: string;
  readonly assetsPath?: string;
  readonly outputPath?: string;
  readonly reportPath: string;
  readonly strict: boolean;
  readonly dryRun: boolean;
  readonly status: 'passed' | 'lossy' | 'failed';
  readonly projectId: string;
  readonly projectBytes: number;
  readonly projectSha256: string;
  readonly diagnosticSummary: Readonly<Record<'info' | 'warning' | 'error', number>>;
  readonly diagnostics: readonly MigrationDiagnostic[];
  readonly entityMap: Readonly<Record<string, string>>;
}

function parseJson(source: string, path: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError(`${path} is not valid JSON`, { cause: error });
  }
}

function object(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must contain a JSON array`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return parseJson(await readFile(path, 'utf8'), path);
}

async function atomicWrite(path: string, data: string): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid.toString()}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, 'utf8');
  await rename(temporary, absolute);
}

function defaultOutputPath(inputPath: string): string {
  const absolute = resolve(inputPath);
  const extension = extname(absolute);
  const stem = basename(absolute, extension);
  return resolve(dirname(absolute), `${stem}.aelion.json`);
}

function defaultReportPath(inputPath: string): string {
  const absolute = resolve(inputPath);
  const extension = extname(absolute);
  const stem = basename(absolute, extension);
  return resolve(dirname(absolute), `${stem}.migration-report.json`);
}

function assetArray(value: unknown, path: string): readonly unknown[] {
  if (Array.isArray(value)) return array(value, path);
  const container = object(value, path);
  return array(container.assets, `${path}.assets`);
}

function migrate(source: MigrationSource, input: unknown, assets: unknown): MigrationResult {
  if (source === 'webav') {
    const snapshot = object(input, 'input');
    const withAssets =
      assets === undefined
        ? snapshot
        : {
            ...snapshot,
            assets: assetArray(assets, 'assets') as readonly WebAvAssetBinding[],
          };
    return migrateWebAvProject(withAssets as unknown as WebAvProjectSnapshot, { strict: false });
  }
  return migrateDiffusionCheckpoint(input, {
    strict: false,
    assets: assets === undefined ? [] : (assetArray(assets, 'assets') as readonly DiffusionAssetBinding[]),
  });
}

/**
 * Migrates a serialized WebAV snapshot or Diffusion Studio Core checkpoint.
 *
 * The report is always written before returning. Strict failures never write a
 * project file, while `strict: false` makes an explicitly lossy project
 * available together with the full loss report.
 */
export async function migrateProjectFile(options: MigrateProjectFileOptions): Promise<ProjectMigrationFileReport> {
  const inputPath = resolve(options.inputPath);
  const assetsPath = options.assetsPath === undefined ? undefined : resolve(options.assetsPath);
  const outputPath = options.outputPath === undefined ? defaultOutputPath(inputPath) : resolve(options.outputPath);
  const reportPath = options.reportPath === undefined ? defaultReportPath(inputPath) : resolve(options.reportPath);
  const strict = options.strict ?? true;
  const dryRun = options.dryRun ?? false;
  const [input, assets] = await Promise.all([
    readJson(inputPath),
    assetsPath === undefined ? Promise.resolve(undefined) : readJson(assetsPath),
  ]);
  const result = migrate(options.source, input, assets);
  const projectSource = `${JSON.stringify(result.project, null, 2)}\n`;
  const projectBytes = Buffer.byteLength(projectSource);
  const projectSha256 = createHash('sha256').update(projectSource).digest('hex');
  const diagnosticSummary = result.diagnostics.reduce(
    (summary, diagnostic) => {
      summary[diagnostic.severity] += 1;
      return summary;
    },
    { info: 0, warning: 0, error: 0 },
  );
  const hasErrors = diagnosticSummary.error > 0;
  const status = hasErrors ? (strict ? 'failed' : 'lossy') : 'passed';
  if (!dryRun && status !== 'failed') await atomicWrite(outputPath, projectSource);

  const report: ProjectMigrationFileReport = {
    reportVersion: '1.0.0',
    source: options.source,
    inputPath,
    ...(assetsPath === undefined ? {} : { assetsPath }),
    ...(!dryRun && status !== 'failed' ? { outputPath } : {}),
    reportPath,
    strict,
    dryRun,
    status,
    projectId: result.project.projectId,
    projectBytes,
    projectSha256,
    diagnosticSummary,
    diagnostics: result.diagnostics,
    entityMap: result.entityMap,
  };
  await atomicWrite(reportPath, `${JSON.stringify(report as unknown as JsonValue, null, 2)}\n`);
  return report;
}
