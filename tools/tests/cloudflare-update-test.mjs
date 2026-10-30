import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signManifest, verifyEnvelope } from '../release/update-signature.mjs';
import { publishRelease } from '../release/cloudflare-publisher.mjs';

// Test credentials live only in process memory and are never stored.
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const raw = publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64');
const trust = {keys: [{id: 'fixture', publicKey: raw}]};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['XwX-Deck-windows-x64-setup.exe', 'XwX-Deck-windows-x64.exe', 'XwX-Deck-mac-arm64.dmg', 'XwX-Deck-mac-x64.dmg'];
const files = names.map((name, i) => { const data = Buffer.from('synthetic-'+name); return {name, platform: i<2?'windows':'darwin', arch: i===2?'arm64':'x64', kind: i===0?'installer':i===1?'portable':'disk-image', url:'https://download.xwxdeck.com/releases/v1.0.0/'+name, size:data.length, sha256:sha(data)}; });
const manifest = {schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:'1.0.0',tag:'v1.0.0',files};
const envelope = signManifest(manifest, privateKey, 'fixture');
assert.deepEqual(verifyEnvelope(envelope, trust), manifest);
assert.throws(()=>verifyEnvelope({...envelope, payload:Buffer.from('{}').toString('base64')},trust),/signature/);
assert.throws(()=>verifyEnvelope({...envelope,keyId:'other'},trust),/Untrusted/);
assert.throws(()=>verifyEnvelope(envelope,{keys:[]}),/Untrusted/);
assert.throws(()=>verifyEnvelope(manifest,trust));
const directory = await mkdtemp(join(tmpdir(),'xwx-cf-release-'));
const acceptance = {passed:true,version:'1.0.0',commit:'a'.repeat(40),files:files.map(file=>({name:file.name,sha256:file.sha256,passed:true}))};
try {
  for (const file of files) await writeFile(join(directory,file.name),Buffer.from('synthetic-'+file.name));
  function fixture({conflict=false, corruptDownload=false, uploadFailure=false, prior=null, stalePointer=false}={}) {
    const writes=[];
    return {writes,store:{async get(key){return key==='updates/stable/release.json'?prior:null;},async head(){return conflict?{sha256:'0'.repeat(64),size:1}:null;},async put(key){writes.push(key);if(uploadFailure)throw Error('fixture upload failure');}},
      fetchPublic:async url=>new Response(url.includes('/updates/stable/')
        ? (stalePointer?'stale':JSON.stringify(envelope,null,2)+'\n')
        : corruptDownload?'bad':await readFile(join(directory,new URL(url).pathname.split('/').at(-1))))};
  }
  let f=fixture(); const result=await publishRelease({directory,envelope,trust,acceptance,...f});
  assert.equal(result.verifiedPackages,4);assert.equal(f.writes.at(-1),'updates/stable/release.json');assert.equal(f.writes.length,6);
  assert.equal(result.publicEndpointVerified,true);
  for (const options of [{conflict:true},{corruptDownload:true},{uploadFailure:true}]) {
    f=fixture(options);await assert.rejects(publishRelease({directory,envelope,trust,acceptance,...f}));assert.ok(!f.writes.includes('updates/stable/release.json'));
  }
  f=fixture();await assert.rejects(publishRelease({directory,envelope,trust,acceptance:{...acceptance,passed:false},...f}));assert.equal(f.writes.length,0);
  f=fixture({prior:{bytes:Buffer.from(JSON.stringify(envelope)),etag:'fixture'}});await assert.rejects(publishRelease({directory,envelope,trust,acceptance,...f}),/advance/);assert.equal(f.writes.length,0);
  f=fixture({stalePointer:true});await assert.rejects(publishRelease({directory,envelope,trust,acceptance,...f}),/public bytes differ/);assert.equal(f.writes.at(-1),'updates/stable/release.json');
  await writeFile(join(directory,names[3]),'changed');f=fixture();await assert.rejects(publishRelease({directory,envelope,trust,acceptance,...f}),/integrity/);assert.equal(f.writes.length,0);
  console.log('PASS Ed25519 valid/tampered/unknown/unsigned rejection; all local packages preflight; immutable conflict; upload/download failure; no downgrade; stable pointer written last (synthetic in-memory store, no real upload)');
} finally {await rm(directory,{recursive:true,force:true});}
