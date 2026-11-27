#!/usr/bin/env node

import { migrateProjectFile, type MigrationSource } from './migrate-cli-lib.js';

function option(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function required(value: string | undefined, description: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${description} is required`);
  return value;
}

function migrationSource(value: string | undefined): MigrationSource {
  if (value === 'webav' || value === 'diffusion') return value;
  throw new TypeError('--from must be webav or diffusion');
}

function strictMode(): boolean {
  if (flag('--no-strict') || option('--strict') === 'false') return false;
  return true;
}

async function main(): Promise<void> {
  const positionalSource = process.argv[2];
  const fromOption = option('--from');
  const source = migrationSource(fromOption ?? positionalSource);
  const inputPath = required(option('--input') ?? (fromOption === undefined ? process.argv[3] : undefined), '--input');
  const assetsPath = option('--assets');
  const outputPath = option('--out');
  const reportPath = option('--report');
  const report = await migrateProjectFile({
    source,
    inputPath,
    ...(assetsPath === undefined ? {} : { assetsPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(reportPath === undefined ? {} : { reportPath }),
    strict: strictMode(),
    dryRun: flag('--dry-run'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'failed') process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${
      error instanceof Error ? error.message : String(error)
    }\nUsage: aelion-migrate --from <webav|diffusion> --input project.json [--assets assets.json] [--out project.aelion.json] [--report report.json] [--dry-run] [--strict=false]\n`,
  );
  process.exitCode = 1;
});
