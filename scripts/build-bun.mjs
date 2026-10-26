#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const ALL_TARGETS = [
  { id: 'linux-x64', bunTarget: 'bun-linux-x64', outfile: 'miniplayer-linux-x64' },
  { id: 'linux-arm64', bunTarget: 'bun-linux-arm64', outfile: 'miniplayer-linux-arm64' },
  { id: 'darwin-arm64', bunTarget: 'bun-darwin-arm64', outfile: 'miniplayer-darwin-arm64' },
  { id: 'darwin-x64', bunTarget: 'bun-darwin-x64', outfile: 'miniplayer-darwin-x64' },
  { id: 'windows-x64', bunTarget: 'bun-windows-x64', outfile: 'miniplayer-windows-x64.exe' },
];

export function findBun() {
  if (process.env.BUN && existsSync(process.env.BUN)) {
    return process.env.BUN;
  }
  const defaultHomeBun = join(homedir(), '.bun', 'bin', 'bun');
  if (existsSync(defaultHomeBun)) {
    return defaultHomeBun;
  }
  const which = spawnSync('which', ['bun'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  throw new Error('bun executable not found. Please install bun or set BUN=/path/to/bun.');
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

export function resolveBuildMetadata() {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
  const pkgVersion = pkg.version || '0.0.0';

  let version = pkgVersion;
  let isTagged = false;
  let isDirty = false;
  let gitSha = runGit(['rev-parse', '--short', 'HEAD']) || '';

  if (process.env.RELEASE_TAG) {
    version = process.env.RELEASE_TAG.replace(/^v/, '');
    isTagged = true;
    isDirty = false;
  } else {
    const status = runGit(['status', '--porcelain']);
    isDirty = status !== undefined && status.length > 0;
    const exactTag = runGit(['describe', '--tags', '--exact-match', 'HEAD']);
    isTagged = exactTag === `v${version}` && !isDirty;
  }

  return { version, gitSha, isDirty, isTagged };
}

export async function buildTargets(options = {}) {
  const bun = options.bun || findBun();
  const outdir = resolve(options.outdir || join(rootDir, 'dist'));
  mkdirSync(outdir, { recursive: true });

  const metadata = options.metadata || resolveBuildMetadata();
  const selectedTargets = options.targets || ALL_TARGETS;

  console.log(`Building miniplayer v${metadata.version} (sha: ${metadata.gitSha || 'none'}, dirty: ${metadata.isDirty}, tagged: ${metadata.isTagged})`);
  console.log(`Output directory: ${outdir}`);
  console.log(`Using bun: ${bun}`);

  const defines = [
    `--define`, `__BUILD_VERSION__="${metadata.version}"`,
    `--define`, `__BUILD_GIT_SHA__="${metadata.gitSha}"`,
    `--define`, `__BUILD_GIT_DIRTY__=${metadata.isDirty}`,
    `--define`, `__BUILD_IS_TAGGED__=${metadata.isTagged}`,
  ];

  const builtFiles = [];

  for (const target of selectedTargets) {
    const targetOutfile = join(outdir, target.outfile);
    console.log(`\nCompiling ${target.id} -> ${target.outfile}...`);
    const args = [
      'build',
      '--compile',
      `--target=${target.bunTarget}`,
      ...defines,
      'bin/miniplayer.js',
      `--outfile=${targetOutfile}`,
    ];

    execFileSync(bun, args, {
      cwd: rootDir,
      stdio: 'inherit',
      timeout: 120000,
    });

    if (!existsSync(targetOutfile)) {
      throw new Error(`Expected output binary not found: ${targetOutfile}`);
    }

    const stat = statSync(targetOutfile);
    builtFiles.push({
      target: target.id,
      name: target.outfile,
      path: targetOutfile,
      size: stat.size,
    });
  }

  // Generate SHA256SUMS for all binaries in outdir (or the built ones)
  const checksums = [];
  for (const item of builtFiles.sort((a, b) => a.name.localeCompare(b.name))) {
    const data = readFileSync(item.path);
    const hash = createHash('sha256').update(data).digest('hex');
    checksums.push(`${hash}  ${item.name}`);
    item.sha256 = hash;
  }

  const shaFilePath = join(outdir, 'SHA256SUMS');
  writeFileSync(shaFilePath, checksums.join('\n') + '\n', 'utf8');
  console.log(`\nWrote ${checksums.length} checksums to ${shaFilePath}`);

  console.log('\nBuild Summary:');
  for (const item of builtFiles) {
    const sizeMb = (item.size / (1024 * 1024)).toFixed(2);
    console.log(`  ${item.name.padEnd(30)} ${sizeMb.padStart(7)} MB  (${item.sha256.slice(0, 16)}...)`);
  }

  return builtFiles;
}

// CLI entry point if executed directly
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  let outdir = join(rootDir, 'dist');
  let requestedTargets = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outdir' && args[i + 1]) {
      outdir = args[++i];
    } else if (args[i] === '--target' && args[i + 1]) {
      const targetId = args[++i];
      const match = ALL_TARGETS.find(t => t.id === targetId || t.bunTarget === targetId);
      if (!match) {
        console.error(`Unknown target: ${targetId}. Valid targets: ${ALL_TARGETS.map(t => t.id).join(', ')}`);
        process.exit(1);
      }
      requestedTargets = [match];
    }
  }

  try {
    await buildTargets({
      outdir,
      targets: requestedTargets || ALL_TARGETS,
    });
  } catch (err) {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  }
}
