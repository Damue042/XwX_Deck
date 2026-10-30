import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signManifest, verifyEnvelope } from '../release/update-signature.mjs';
import { publishCandidate } from '../release/candidate-release.mjs';
import { publishRelease } from '../release/cloudflare-publisher.mjs';

const directory=await mkdtemp(join(tmpdir(),'xwx-candidate-publisher-'));
const candidateId='a'.repeat(40), fingerprint='b'.repeat(64), sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const names=[['windows','x64','installer','XwX-Deck-windows-x64-setup.exe'],['windows','x64','portable','XwX-Deck-windows-x64.exe'],['darwin','arm64','disk-image','XwX-Deck-mac-arm64.dmg'],['darwin','x64','disk-image','XwX-Deck-mac-x64.dmg']];
const files=names.map(([platform,arch,kind,name])=>{const bytes=Buffer.from('fixture '+name);return {platform,arch,kind,name,url:`https://download.xwxdeck.com/candidates/${candidateId}/${name}`,size:bytes.length,sha256:sha(bytes)};});
const manifest={schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:'1.0.0',tag:'v1.0.0',candidate:{schemaVersion:1,only:true,commit:candidateId,sourceFingerprint:fingerprint},files};
// Only an ephemeral memory fixture signs these synthetic package bytes.
const pair=generateKeyPairSync('ed25519'), trust={keys:[{id:'fixture',publicKey:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')}]};
const envelope=signManifest(manifest,pair.privateKey,'fixture',{candidateId});
const acceptance={passed:true,candidateOnly:true,commit:candidateId,sourceFingerprint:fingerprint,files:files.map(file=>({name:file.name,size:file.size,sha256:file.sha256,passed:true,commit:candidateId,sourceFingerprint:fingerprint,buildMode:'production-candidate',cargoDefaultFeatures:true,cargoRequestedFeatures:[],signed:'developer-id',notarized:true}))};
let operations=[];
function fixture({conflict=false,corruptDownload=false,readFailure=false}={}) {
  const remote=new Map(); operations=[];
  if(conflict)remote.set(files[0].url,Buffer.from('pre-existing different object'));
  return {uploader:{async put(object){operations.push(object.key);remote.set(object.url,object.bytes??await readFile(object.path));}},
    fetchPublic:async(url,options={})=>{
      assert.ok(url.startsWith(`https://download.xwxdeck.com/candidates/${candidateId}/`));
      assert.equal(options.redirect,'error');
      if(readFailure)return new Response(null,{status:503});
      const bytes=remote.get(url);
      if(!bytes)return new Response(null,{status:404});
      return new Response(options.method==='HEAD'?null:corruptDownload?'changed':bytes,{status:200});
    }};
}
try {
  for(const file of files)await writeFile(join(directory,file.name),Buffer.from('fixture '+file.name));
  assert.throws(()=>verifyEnvelope(envelope,trust),/not a production release/);
  await assert.rejects(publishRelease({directory,envelope,trust,acceptance,store:{}}),/not a production release/);
  let f=fixture();const planned=await publishCandidate({directory,envelope,trust,acceptance,candidateId,...f});
  assert.equal(planned.uploaded,false);assert.equal(operations.length,0);
  const passed=await publishCandidate({directory,envelope,trust,acceptance,candidateId,upload:true,...f});
  assert.equal(passed.stableTouched,false);assert.equal(passed.objectsWritten,5);assert.equal(operations.length,5);
  assert.equal(operations.at(-1),`candidates/${candidateId}/release.json`);
  assert.ok(operations.every(key=>key.startsWith(`candidates/${candidateId}/`)&&!key.includes('stable')));
  assert.equal((await publishCandidate({directory,envelope,trust,acceptance,candidateId,upload:true,...f})).objectsWritten,0);
  for(const options of [{conflict:true},{readFailure:true}]){
    f=fixture(options);await assert.rejects(publishCandidate({directory,envelope,trust,acceptance,candidateId,upload:true,...f}));assert.equal(operations.length,0);
  }
  f=fixture({corruptDownload:true});await assert.rejects(publishCandidate({directory,envelope,trust,acceptance,candidateId,upload:true,...f}),/public bytes differ/);assert.equal(operations.length,1);
  for(const bad of [{...acceptance,passed:false},{...acceptance,sourceFingerprint:'c'.repeat(64)},{...acceptance,files:acceptance.files.map(file=>({...file,buildMode:'manual-acceptance'}))}]){
    f=fixture();await assert.rejects(publishCandidate({directory,envelope,trust,acceptance:bad,candidateId,upload:true,...f}));assert.equal(operations.length,0);
  }
  await writeFile(join(directory,files[3].name),'changed');f=fixture();
  await assert.rejects(publishCandidate({directory,envelope,trust,acceptance,candidateId,upload:true,...f}),/integrity/);assert.equal(operations.length,0);
  console.log('PASS candidate-only plan/upload confinement, production publisher rejection, four-file preflight, source/mode mismatch, conflict preservation, idempotent retry and public-byte failure; in-memory store only, no R2 writes');
} finally {await rm(directory,{recursive:true,force:true});}
