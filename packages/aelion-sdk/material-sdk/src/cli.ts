#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  buildMaterialAuthorPackage,
  compareMaterialGoldenFiles,
  generateMaterialTypes,
  initializeMaterialAuthorPackage,
  packMaterialAuthorPackage,
  prepublishMaterialAuthorPackage,
  validateMaterialAuthorPackage,
  writeMaterialPreviewReport,
} from './cli-lib.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(value: string | undefined, description: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`${description} is required`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const target = process.argv[3];
  let result: unknown;
  if (command === 'init') {
    result = { directory: await initializeMaterialAuthorPackage(required(target, 'directory')) };
  } else if (command === 'build') {
    result = await buildMaterialAuthorPackage(required(target, 'directory'));
  } else if (command === 'validate' || command === 'inspect') {
    result = await validateMaterialAuthorPackage(required(target, 'directory'));
  } else if (command === 'types') {
    result = {
      path: await generateMaterialTypes(
        required(target, 'directory'),
        option('--out') ?? resolve(required(target, 'directory'), 'material.generated.d.ts'),
      ),
    };
  } else if (command === 'preview') {
    result = {
      path: await writeMaterialPreviewReport(
        required(target, 'directory'),
        option('--out') ?? resolve(required(target, 'directory'), 'material-preview.json'),
      ),
    };
  } else if (command === 'pack') {
    result = await packMaterialAuthorPackage(required(target, 'directory'), required(option('--out'), '--out'));
  } else if (command === 'golden') {
    const tolerance = Number.parseInt(option('--tolerance') ?? '2', 10);
    const comparison = await compareMaterialGoldenFiles(
      required(target, 'actual file'),
      required(process.argv[4], 'expected file'),
      tolerance,
    );
    result = comparison;
    if (!comparison.passed) process.exitCode = 1;
  } else if (command === 'prepublish') {
    result = await prepublishMaterialAuthorPackage(required(target, 'directory'));
  } else {
    throw new TypeError(
      'Usage: aelion-material <init|build|validate|inspect|types|preview|pack|golden|prepublish> ...',
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
