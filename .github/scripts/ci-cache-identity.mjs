import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFile, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = value => value.replace(/\r\n/g, '\n');
const modes = new Set(['quality-debug', 'isolated-release']);

export function dependencyManifest(manifest) {
  let inPackage = false, versions = 0;
  const lines = normalize(manifest).split('\n').map(line => {
    if (/^\s*\[/.test(line)) inPackage = /^\s*\[package\]\s*(?:#.*)?$/.test(line);
    if (inPackage && /^\s*version\s*=/.test(line)) {
      assert.match(line, /^\s*version\s*=\s*"[^"\\]+"\s*(?:#.*)?$/);
      versions++;
      return 'version = "<application-version>"';
    }
    return line;
  });
  assert.equal(versions, 1, 'Cache identity requires one explicit package version');
  return lines.join('\n');
}

export function cacheIdentity({os, arch, rustc, manifest, lock, mode, flags = '', target = ''}) {
  assert.ok(modes.has(mode), 'Unknown CI build mode');
  for (const part of [os, arch]) assert.match(part ?? '', /^[A-Za-z0-9_-]+$/);
  assert.match(rustc, /^rustc \d+\.\d+/);
  assert.ok(lock.trim(), 'Cargo.lock must not be empty');
  // Cargo always rebuilds current source after restore. Only dependency-compatible
  // caches may cross an application version or lockfile change, never build modes.
  const toolchain = hash(normalize(rustc)).slice(0, 20);
  const configuration = hash(JSON.stringify([dependencyManifest(manifest), flags, target])).slice(0, 20);
  const prefix = `${os}-${arch}-xwx-ci-v2-${mode}-${toolchain}-${configuration}-`;
  return {key: prefix + hash(normalize(lock)), restoreKey: prefix, mode, toolchain, configuration};
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 1, 'Usage: ci-cache-identity.mjs <quality-debug|isolated-release>');
  const root = resolve(import.meta.dirname, '../..');
  const identity = cacheIdentity({
    os: process.env.RUNNER_OS,
    arch: process.env.RUNNER_ARCH,
    rustc: execFileSync('rustc', ['-vV'], {encoding:'utf8'}),
    manifest: await readFile(resolve(root, 'src-native/Cargo.toml'), 'utf8'),
    lock: await readFile(resolve(root, 'src-native/Cargo.lock'), 'utf8'),
    mode: args[0],
    flags: JSON.stringify([process.env.RUSTFLAGS ?? '', process.env.CARGO_ENCODED_RUSTFLAGS ?? '']),
    target: process.env.CARGO_BUILD_TARGET ?? '',
  });
  assert.ok(process.env.GITHUB_OUTPUT, 'GitHub output file is required');
  await appendFile(process.env.GITHUB_OUTPUT, `key=${identity.key}\nrestore-key=${identity.restoreKey}\n`);
  console.log(JSON.stringify(identity));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
