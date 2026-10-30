import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyEnvelope } from './update-signature.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
async function digest(stream) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of stream) { hash.update(chunk); size += chunk.length; }
  return {sha256: hash.digest('hex'), size};
}
export async function publishRelease({directory, envelope, trust, acceptance, store, fetchPublic = fetch}) {
  const manifest = verifyEnvelope(envelope, trust);
  if (!acceptance?.passed || acceptance.version !== manifest.version || !/^[a-f0-9]{40}$/.test(acceptance.commit ?? '')) {
    throw Error('Exact-package release acceptance is required');
  }
  // Validate every local package and its acceptance before the first write.
  const packages = [];
  for (const file of manifest.files) {
    const path = resolve(directory, file.name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Release package must be a regular file');
    const evidence = acceptance.files?.find(entry => entry.name === file.name);
    if (evidence?.sha256 !== file.sha256 || evidence.passed !== true) throw Error('Missing exact-package acceptance');
    const actual = await digest(createReadStream(path));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw Error('Local package integrity mismatch');
    packages.push({file, path, key: `releases/${manifest.tag}/${file.name}`});
  }
  const stableKey = 'updates/stable/release.json';
  const prior = await store.get(stableKey);
  if (prior) {
    if (!prior.etag) throw Error('Stable metadata lacks a conditional-write identity');
    const old = verifyEnvelope(JSON.parse(prior.bytes), trust);
    const version = value => value.split('.').map(Number);
    const a = version(old.version), b = version(manifest.version);
    const order = a.reduce((result, n, i) => result || Math.sign(n - b[i]), 0);
    if (order >= 0) throw Error('Stable release must advance; no same-version overwrite or downgrade');
  }
  for (const {file, path, key} of packages) {
    const existing = await store.head(key);
    if (existing && (existing.sha256 !== file.sha256 || existing.size !== file.size)) throw Error('Immutable package already exists with different bytes');
    if (!existing) await store.put(key, {path, sha256: file.sha256, size: file.size,
      contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable', ifNoneMatch: '*'});
    const response = await fetchPublic(file.url, {redirect: 'follow', signal: AbortSignal.timeout(180000)});
    if (response.status !== 200 || new URL(response.url || file.url).protocol !== 'https:') throw Error('Public package verification failed');
    const downloaded = await digest(response.body);
    if (downloaded.size !== file.size || downloaded.sha256 !== file.sha256) throw Error('Public package integrity mismatch');
  }
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n');
  const versionedKey = `releases/${manifest.tag}/release.json`;
  const existing = await store.get(versionedKey);
  if (existing && !existing.bytes.equals(bytes)) throw Error('Immutable version manifest already differs');
  if (!existing) await store.put(versionedKey, {bytes, sha256: sha(bytes), size: bytes.length,
    contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable', ifNoneMatch: '*'});
  // The only mutable pointer is written last, with a compare-and-swap guard.
  await store.put(stableKey, {bytes, sha256: sha(bytes), size: bytes.length,
    contentType: 'application/json', cacheControl: 'no-store', ...(prior ? {ifMatch: prior.etag} : {ifNoneMatch: '*'})});
  const visible = await fetchPublic('https://xwxdeck.com/updates/stable/release.json', {
    redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(30000)
  });
  if (visible.status !== 200) throw Error('Stable pointer written; public endpoint not yet verified; inspect before retrying');
  const publicBytes = Buffer.from(await visible.arrayBuffer());
  if (!publicBytes.equals(bytes)) throw Error('Stable pointer written; public bytes differ; inspect cache before retrying');
  verifyEnvelope(JSON.parse(publicBytes), trust);
  return {passed: true, version: manifest.version, commit: acceptance.commit,
    verifiedPackages: packages.length, stableKey, metadataPublishedLast: true, publicEndpointVerified: true};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--publish')) throw Error('Explicit --publish required; no uploads performed');
  const directory = resolve(process.argv[2] ?? 'release-assets');
  const [envelope, trust, acceptance] = await Promise.all([
    readFile(resolve(directory, 'release.json'), 'utf8').then(JSON.parse),
    readFile(new URL('../../assets/update-trust.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(resolve(directory, 'release-acceptance.json'), 'utf8').then(JSON.parse)
  ]);
  const { createR2Store } = await import('./r2-store.mjs');
  console.log(JSON.stringify(await publishRelease({directory, envelope, trust, acceptance, store: createR2Store()}), null, 2));
}
