import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateManifest, verifyEnvelope } from './update-signature.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function digest(stream) {
  const hash = createHash('sha256'); let size = 0;
  for await (const bytes of stream) { size += bytes.length; hash.update(bytes); }
  return {size,sha256:hash.digest('hex')};
}

export async function validateCandidatePackages({directory,manifest,acceptance,candidateId}) {
  validateManifest(manifest,{candidateId});
  if (acceptance?.passed !== true || acceptance.candidateOnly !== true || acceptance.commit !== candidateId
      || acceptance.sourceFingerprint !== manifest.candidate.sourceFingerprint || acceptance.files?.length !== 4) {
    throw Error('Exact candidate-package acceptance is required');
  }
  const root = await realpath(directory), packages = [];
  for (const file of manifest.files) {
    const path = resolve(root,file.name), meta = await lstat(path);
    if (!meta.isFile() || meta.isSymbolicLink() || dirname(await realpath(path)) !== root) throw Error('Candidate package must be a regular local file');
    const evidence = acceptance.files.find(entry=>entry.name===file.name);
    if (evidence?.passed !== true || evidence.sha256 !== file.sha256 || evidence.size !== file.size
        || evidence.commit !== candidateId || !/^[a-f0-9]{64}$/.test(evidence.sourceFingerprint ?? '')
        || !['production','production-candidate'].includes(evidence.buildMode)
        || evidence.cargoDefaultFeatures !== true || !Array.isArray(evidence.cargoRequestedFeatures)
        || evidence.cargoRequestedFeatures.length !== 0
        || (file.platform==='darwin' && (evidence.signed!=='developer-id' || evidence.notarized!==true))) {
      throw Error('Candidate artifact requires production-feature and exact-package evidence');
    }
    // Wrangler 4.155.0's remote object API is limited to 300 MiB per object.
    if (file.size > 300 * 1024 * 1024) throw Error('Candidate exceeds the verified Wrangler single-object limit');
    const actual = await digest(createReadStream(path));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw Error('Candidate package integrity mismatch');
    packages.push({file,path,key:`candidates/${candidateId}/${file.name}`});
  }
  return packages;
}

export async function publishCandidate({directory,envelope,trust,acceptance,candidateId,uploader,fetchPublic=fetch,upload=false}) {
  const manifest = verifyEnvelope(envelope,trust,{candidateId});
  const packages = await validateCandidatePackages({directory,manifest,acceptance,candidateId});
  const bytes = Buffer.from(JSON.stringify(envelope,null,2)+'\n');
  const objects = [...packages.map(({file,path,key})=>({key,path,url:file.url,size:file.size,sha256:file.sha256,contentType:'application/octet-stream'})),
    {key:`candidates/${candidateId}/release.json`,bytes,url:`https://download.xwxdeck.com/candidates/${candidateId}/release.json`,size:bytes.length,sha256:sha256(bytes),contentType:'application/json'}];
  const plan = {candidateOnly:true,commit:candidateId,sourceFingerprint:manifest.candidate.sourceFingerprint,
    stableTouched:false,objects:objects.map(({key,url,size,sha256})=>({key,url,size,sha256}))};
  if (!upload) return {...plan,uploaded:false};
  if (!uploader?.put) throw Error('Explicit existing-credential uploader required');
  // Check every public object before the first write. This detects conflicts,
  // but Wrangler offers no conditional-put flag: this is not an atomic CAS.
  const pending = [];
  for (const object of objects) {
    const response = await fetchPublic(object.url,{method:'HEAD',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
    if (response.status===404) { pending.push(object); continue; }
    if (response.status!==200) throw Error('Candidate object existence could not be verified');
    const existing = await fetchPublic(object.url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(180000)});
    if (existing.status!==200) throw Error('Candidate object read failed');
    const actual = await digest(existing.body);
    if (actual.size!==object.size || actual.sha256!==object.sha256) throw Error('Existing candidate object has different bytes; no overwrite permitted');
  }
  for (const object of pending) {
    if (!object.key.startsWith(`candidates/${candidateId}/`)) throw Error('Candidate prefix violation');
    await uploader.put(object);
    const response = await fetchPublic(object.url,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(180000)});
    if (response.status!==200) throw Error('Candidate public download failed');
    const actual = await digest(response.body);
    if (actual.size!==object.size || actual.sha256!==object.sha256) throw Error('Candidate public bytes differ; remaining uploads stopped');
  }
  return {...plan,uploaded:true,publicBytesVerified:true,objectsWritten:pending.length,conditionalPut:false};
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2), option=name=>args.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
  const allowed=['--directory=','--candidate=','--wrangler-cli=','--expected-envelope-sha256='];
  if(args.some(value=>value!=='--upload-candidate'&&!allowed.some(prefix=>value.startsWith(prefix)))) throw Error('Unknown candidate-only argument');
  const directory=resolve(option('--directory')??'release-candidate'), candidateId=option('--candidate');
  if(!/^[a-f0-9]{40}$/.test(candidateId??'')) throw Error('Exact candidate commit required');
  const raw=await readFile(resolve(directory,'release.json')), envelope=JSON.parse(raw);
  if(!raw.equals(Buffer.from(JSON.stringify(envelope,null,2)+'\n'))) throw Error('Signed envelope formatting differs from the reviewed canonical bytes');
  const trust=JSON.parse(await readFile(new URL('../../assets/update-trust.json',import.meta.url),'utf8'));
  const acceptance=JSON.parse(await readFile(resolve(directory,'candidate-acceptance.json'),'utf8'));
  const upload=args.includes('--upload-candidate'); let uploader;
  if(upload) {
    if(option('--expected-envelope-sha256')!==sha256(raw)) throw Error('Reviewed signed-envelope SHA required before upload');
    const cli=resolve(option('--wrangler-cli')??'');
    if(basename(cli)!=='wrangler.js') throw Error('Existing official Wrangler CLI required');
    const pkg=JSON.parse(await readFile(resolve(dirname(cli),'../package.json'),'utf8'));
    if(pkg.name!=='wrangler'||pkg.version!=='4.155.0') throw Error('Review this Wrangler version before candidate upload');
    uploader={async put(object) {
      let path=object.path;
      if(object.bytes) {
        // The reviewed local release.json has exactly the canonical bytes.
        path=resolve(directory,'release.json');
        if(sha256(await readFile(path))!==object.sha256) throw Error('Signed envelope changed before upload');
      } else {
        const actual=await digest(createReadStream(path));
        if(actual.size!==object.size||actual.sha256!==object.sha256) throw Error('Package changed before upload');
      }
      const run=spawnSync(process.execPath,[cli,'r2','object','put','xwx-deck-downloads/'+object.key,'--file',path,'--remote','--content-type',object.contentType,'--cache-control','no-store'],{stdio:'inherit',timeout:180000});
      if(run.status!==0) throw Error('Wrangler candidate upload failed; no other source or credential fallback attempted');
    }};
  }
  console.log(JSON.stringify(await publishCandidate({directory,envelope,trust,acceptance,candidateId,uploader,upload}),null,2));
}
