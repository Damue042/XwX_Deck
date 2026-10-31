// Manual downloads only. This tool never writes updater package names or feeds.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,lstat,mkdir,realpath,open,unlink} from 'node:fs/promises';
import {resolve,dirname,basename,extname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyEnvelope} from './update-signature.mjs';
import {validateCandidatePackages} from './candidate-release.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const definitions={windows:['XwX-Deck-windows-x64-setup.exe','windows','x64','installer'],portable:['XwX-Deck-windows-x64.exe','windows','x64','portable'],mac:['XwX-Deck-mac-arm64.dmg','darwin','arm64','disk-image']};
const cacheControl='public, max-age=31536000, immutable';
const hex64=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=message=>{throw Error(message);};
export function validateStaticDownloads(config){
  if(config?.schemaVersion!==1||!/^\d+\.\d+\.\d+$/.test(config.version??'')||!/^\w{40}$/.test(config.sourceCommit??'')||!/^[a-f0-9]{40}$/.test(config.sourceCommit)||!hex64(config.candidateEnvelopeSha256)||!Array.isArray(config.files)||config.files.length!==3)fail('Invalid static download identities');
  const base=`https://download.xwxdeck.com/releases/v${config.version}`,seen=new Set();
  const files=config.files.map(file=>{
    const def=definitions[file.target];
    if(!def||seen.has(file.target)||file.name!==def[0]||file.platform!==def[1]||file.arch!==def[2]||file.kind!==def[3]||!hex64(file.sha256)||!hex64(file.sourceFingerprint)||!Number.isSafeInteger(file.size)||file.size<1||file.size>300*1024*1024)fail('Invalid static artifact');
    seen.add(file.target);const extension=extname(file.name),staticName=file.name.slice(0,-extension.length)+'-'+file.sha256+extension,checksumName=staticName+'.sha256';
    return Object.freeze({...file,staticName,url:base+'/'+staticName,checksumName,checksumUrl:base+'/'+checksumName});
  });
  const checksumsName=`static-downloads-${config.sourceCommit}-checksums.txt`;
  return Object.freeze({...config,files:Object.freeze(files),checksumsName,checksumsUrl:base+'/'+checksumsName,downloads:Object.freeze(Object.fromEntries(files.map(f=>[f.target,f.url])))});
}
async function digest(stream){const h=createHash('sha256');let size=0;for await(const b of stream){size+=b.length;h.update(b);}return{size,sha256:h.digest('hex')};}
async function regular(path){const m=await lstat(path);if(!m.isFile()||m.isSymbolicLink()||dirname(await realpath(path))!==await realpath(dirname(path)))fail('Expected regular local file');return m;}
async function projectedRealPath(path){try{return await realpath(path);}catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(path);if(parent===path)throw error;return resolve(await projectedRealPath(parent),basename(path));}}
function comparisonPath(path){const value=path.replaceAll('\\','/').replace(/^\/\/\?\/UNC\//i,'//').replace(/^\/\/\?\//,'');return process.platform==='win32'?value.toLowerCase():value;}
function objectsFor(config,directory){
  const objects=[];const add=(name,downloadName,bytes,expected)=>objects.push({name,path:resolve(directory,name),key:`releases/v${config.version}/${name}`,url:`https://download.xwxdeck.com/releases/v${config.version}/${name}`,downloadName,contentType:bytes?'text/plain; charset=utf-8':'application/octet-stream',cacheControl,...(bytes?{bytes,size:bytes.length,sha256:sha(bytes)}:expected)});
  for(const file of config.files){add(file.staticName,file.name,null,{size:file.size,sha256:file.sha256});add(file.checksumName,file.name+'.sha256',Buffer.from(`${file.sha256}  ${file.name}\n`));}
  add(config.checksumsName,'checksums.txt',Buffer.from(config.files.map(f=>`${f.sha256}  ${f.name}\n`).join('')));
  return objects;
}
function publicPlan(config,objects){return{schemaVersion:1,version:config.version,sourceCommit:config.sourceCommit,candidateEnvelopeSha256:config.candidateEnvelopeSha256,staticDownloadsOnly:true,conditionalPut:false,cas:false,singleWriterRequired:true,standardUpdaterNamesWritten:false,updateManifestWritten:false,stableTouched:false,objects:objects.map(({bytes,...v})=>v)};}
async function verifyLocal(objects){for(const object of objects){const meta=await regular(object.path);if(meta.size!==object.size)fail('Local static object size mismatch');const got=await digest(createReadStream(object.path));if(got.sha256!==object.sha256)fail('Local static object hash mismatch');}}
function verifyStaticEvidence(config,raw,evidence,trust){
  if(sha(raw)!==config.candidateEnvelopeSha256)fail('Reviewed candidate envelope changed');const manifest=verifyEnvelope(JSON.parse(raw),trust,{candidateId:config.sourceCommit});if(manifest.version!==config.version||manifest.tag!=='v'+config.version)fail('Static version differs from signed candidate version');
  if(evidence?.passed!==true||evidence.candidateOnly!==true||evidence.commit!==config.sourceCommit||evidence.sourceFingerprint!==manifest.candidate.sourceFingerprint||evidence.files?.length!==3)fail('Invalid candidate source evidence');
  for(const file of config.files){const signed=manifest.files.find(f=>f.name===file.name),entry=evidence.files.find(f=>f.name===file.name);if(signed?.size!==file.size||signed.sha256!==file.sha256||entry?.passed!==true||entry.sha256!==file.sha256||entry.size!==file.size||entry.commit!==config.sourceCommit||entry.sourceFingerprint!==file.sourceFingerprint||entry.buildMode!=='production'||entry.cargoDefaultFeatures!==true||!Array.isArray(entry.cargoRequestedFeatures)||entry.cargoRequestedFeatures.length||(file.platform==='darwin'&&(entry.signed!=='developer-id'||entry.notarized!==true)))fail('Static config differs from final production package evidence');}
  return manifest;
}
export async function prepareStaticDownloads({config:input,sourceDirectory,directory,trust}){
  const config=validateStaticDownloads(input),source=await realpath(sourceDirectory);await regular(resolve(source,'release.json'));await regular(resolve(source,'candidate-acceptance.json'));const raw=await readFile(resolve(source,'release.json')),evidenceRaw=await readFile(resolve(source,'candidate-acceptance.json')),evidence=JSON.parse(evidenceRaw),manifest=verifyStaticEvidence(config,raw,evidence,trust);
  await validateCandidatePackages({directory:source,manifest,acceptance:evidence,candidateId:config.sourceCommit});
  directory=resolve(directory);const sourceKey=comparisonPath(source),directoryKey=comparisonPath(await projectedRealPath(directory));if(directoryKey===sourceKey||directoryKey.startsWith(sourceKey+'/'))fail('Static stage must be separate from candidate inputs');await mkdir(directory,{recursive:true});const meta=await lstat(directory);if(!meta.isDirectory()||meta.isSymbolicLink())fail('Static stage must be a real directory');
  const objects=objectsFor(config,directory);
  // Check every pre-existing destination before any package write. Reentry may
  // fill missing files, but it never replaces different bytes or a symlink.
  const plan=publicPlan(config,objects),pending={schemaVersion:1,version:config.version,sourceCommit:config.sourceCommit,passed:false,windowsNormalGui:{passed:false,binarySha256:config.files.find(f=>f.target==='portable').sha256,receiptSha256:null},files:config.files.map(({name,size,sha256,sourceFingerprint})=>({name,size,sha256,sourceFingerprint,passed:true})),scope:'Package preparation only. Record actual final normal Windows GUI evidence in a separate completed acceptance file before upload.'},metadata=[['static-downloads-plan.json',Buffer.from(JSON.stringify(plan,null,2)+'\n')],['static-candidate-envelope.json',raw],['static-candidate-acceptance.json',evidenceRaw],['static-downloads-acceptance.pending.json',Buffer.from(JSON.stringify(pending,null,2)+'\n')]];
  for(const object of objects){try{await regular(object.path);const actual=await digest(createReadStream(object.path));if(actual.sha256!==object.sha256||actual.size!==object.size)fail('Static stage already differs');}catch(e){if(e.code!=='ENOENT')throw e;}}
  for(const[name,bytes]of metadata){try{await regular(resolve(directory,name));if(!(await readFile(resolve(directory,name))).equals(bytes))fail('Existing static metadata differs');}catch(e){if(e.code!=='ENOENT')throw e;}}
  for(const object of objects){try{await lstat(object.path);continue;}catch(e){if(e.code!=='ENOENT')throw e;}const bytes=object.bytes??await readFile(resolve(source,config.files.find(f=>f.staticName===object.name).name));await writeFile(object.path,bytes,{flag:'wx'});}
  await verifyLocal(objects);for(const[name,bytes]of metadata){try{await lstat(resolve(directory,name));}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(resolve(directory,name),bytes,{flag:'wx'});}}
  return plan;
}
function validateAcceptance(acceptance,config){
  const portable=config.files.find(f=>f.target==='portable');
  const gui=acceptance?.windowsNormalGui,waiver=gui?.waiver;
  const performed=gui?.passed===true&&gui.status!=='waived'&&hex64(gui.receiptSha256);
  // A product owner may change manual-download acceptance scope. That records
  // an unperformed test, never authorizes a denied tool or marks it passed.
  const waived=gui?.status==='waived'&&gui.performed===false&&gui.passed===false&&gui.receiptSha256===null
    &&waiver?.authority==='product-owner'&&waiver.scope==='static-manual-downloads'
    &&waiver.version===config.version&&waiver.sourceCommit===config.sourceCommit
    &&typeof waiver.reason==='string'&&waiver.reason.trim().length>0
    &&hex64(waiver.decisionEvidenceSha256)&&Array.isArray(waiver.substituteEvidenceSha256)
    &&waiver.substituteEvidenceSha256.length>0&&waiver.substituteEvidenceSha256.every(hex64)
    &&acceptance.passed===false&&acceptance.releaseApproved===true&&acceptance.functionalEvidencePassed===true;
  if((!performed&&!waived)||(performed&&acceptance?.passed!==true)||acceptance?.sourceCommit!==config.sourceCommit||acceptance.version!==config.version||gui?.binarySha256!==portable.sha256||!Array.isArray(acceptance.files)||acceptance.files.length!==3)fail('Final normal Windows GUI or explicit owner-scoped waiver and exact package acceptance are still required');
  for(const file of config.files){const row=acceptance.files.find(f=>f.name===file.name);if(row?.passed!==true||row.sha256!==file.sha256||row.size!==file.size||row.sourceFingerprint!==file.sourceFingerprint)fail('Final static package acceptance mismatch');}
  return waived?'waived':'passed';
}
async function remoteState(object,fetchPublic){
  const options={redirect:'error',cache:'no-store',signal:AbortSignal.timeout(180000)};const head=await fetchPublic(object.url,{...options,method:'HEAD'});
  if(head.status===404)return'missing';if(head.status!==200)fail('Cannot establish remote static object state');const response=await fetchPublic(object.url,options);if(response.status!==200)fail('Existing static object cannot be read');const actual=await digest(response.body);if(actual.size!==object.size||actual.sha256!==object.sha256)fail('Existing static object has different bytes; stop without overwrite');return'identical';
}
export async function publishStaticDownloads({config:input,directory,acceptance,uploader,fetchPublic=fetch,upload=false,singleWriter=false,trust}){
  const config=validateStaticDownloads(input),objects=objectsFor(config,resolve(directory));await verifyLocal(objects);await regular(resolve(directory,'static-candidate-envelope.json'));await regular(resolve(directory,'static-candidate-acceptance.json'));verifyStaticEvidence(config,await readFile(resolve(directory,'static-candidate-envelope.json')),JSON.parse(await readFile(resolve(directory,'static-candidate-acceptance.json'),'utf8')),trust);const plan=publicPlan(config,objects);
  if(upload!==true){let status='pending';if(acceptance?.passed===true||acceptance?.releaseApproved===true||acceptance?.windowsNormalGui?.status==='waived')status=validateAcceptance(acceptance,config);return{...plan,uploaded:false,normalWindowsGuiPassed:status==='passed',normalWindowsGuiStatus:status,manualDownloadReleaseApproved:status==='passed'||status==='waived'};}
  const guiStatus=validateAcceptance(acceptance,config);if(singleWriter!==true||!uploader?.put)fail('Explicit single writer and existing uploader are required');
  const lockPath=resolve(directory,'.static-downloads-publish.lock'),journalPath=resolve(directory,'static-downloads-publish-journal.json');let lock;
  try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,sourceCommit:config.sourceCommit,startedAt:new Date().toISOString()})+'\n');await lock.close();}catch(error){if(lock){await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}throw error;}
  let journal={schemaVersion:1,sourceCommit:config.sourceCommit,version:config.version,objects:{},staticDownloadsOnly:true,conditionalPut:false,stableTouched:false};
  const save=()=>writeFile(journalPath,JSON.stringify(journal,null,2)+'\n');
  try{
    try{await regular(journalPath);journal=JSON.parse(await readFile(journalPath,'utf8'));if(journal.sourceCommit!==config.sourceCommit||journal.version!==config.version||!journal.objects)fail('Existing static upload journal differs');for(const[key,value]of Object.entries(journal.objects)){const object=objects.find(o=>o.key===key);if(!object||value.sha256!==object.sha256||value.size!==object.size||!['uploading','uncertain','verified'].includes(value.phase))fail('Existing static upload journal object differs');}}catch(e){if(e.code!=='ENOENT')throw e;}
    // Full preflight before the first write, then repeat immediately before
    // every PUT. These are single-writer checks, not a remote atomic CAS.
    for(const object of objects){const state=await remoteState(object,fetchPublic);if(state==='missing'&&['uploading','uncertain'].includes(journal.objects[object.key]?.phase))fail('Prior upload outcome is uncertain; reconcile origin/process state before retry');}
    let objectsWritten=0;
    for(const object of objects){if(!object.key.startsWith(`releases/v${config.version}/`)||!object.name.includes(config.sourceCommit)&&!object.name.includes(config.files.find(f=>object.name.startsWith(f.staticName))?.sha256??'INVALID'))fail('Static-only key violation');
      if(await remoteState(object,fetchPublic)==='identical'){journal.objects[object.key]={phase:'verified',sha256:object.sha256,size:object.size,reused:true};await save();continue;}
      const meta=await regular(object.path),actual=await digest(createReadStream(object.path));if(meta.size!==object.size||actual.sha256!==object.sha256)fail('Static object changed before PUT');journal.objects[object.key]={phase:'uploading',sha256:object.sha256,size:object.size};await save();
      try{await uploader.put(object);}catch(e){journal.objects[object.key].phase='uncertain';await save();throw e;}
      if(await remoteState(object,fetchPublic)!=='identical')fail('Uploaded static object did not become visible; reconcile before retry');journal.objects[object.key].phase='verified';await save();objectsWritten++;
    }
    journal.completedAt=new Date().toISOString();journal.normalWindowsGuiStatus=guiStatus;await save();return{...plan,uploaded:true,objectsWritten,publicBytesVerified:true,normalWindowsGuiPassed:guiStatus==='passed',normalWindowsGuiStatus:guiStatus,manualDownloadReleaseApproved:true};
  }finally{await unlink(lockPath).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),flags=['--prepare','--check','--upload-static','--single-writer'],options=['--spec=','--source=','--directory=','--acceptance=','--wrangler-cli='];if(args.some(a=>!flags.includes(a)&&!options.some(p=>a.startsWith(p))))fail('Unknown static-download argument');const modes=args.filter(a=>['--prepare','--check','--upload-static'].includes(a));if(modes.length!==1)fail('Choose exactly one static-download mode');const option=n=>args.find(a=>a.startsWith(n+'='))?.slice(n.length+1);if(!option('--directory'))fail('Explicit local static stage required');
  const config=JSON.parse(await readFile(resolve(option('--spec')??fileURLToPath(new URL('../../web/site/static-downloads.json',import.meta.url))),'utf8')),directory=resolve(option('--directory'));let result;
  if(modes[0]==='--prepare'){if(!option('--source'))fail('Exact candidate source stage required');const trust=JSON.parse(await readFile(new URL('../../assets/update-trust.json',import.meta.url),'utf8'));result=await prepareStaticDownloads({config,sourceDirectory:resolve(option('--source')),directory,trust});}
  else{
    const acceptance=option('--acceptance')?JSON.parse(await readFile(resolve(option('--acceptance')),'utf8')):undefined;let uploader;
    if(modes[0]==='--upload-static'){
      // Validate before opening the existing credentialed CLI or remote API.
      validateAcceptance(acceptance,validateStaticDownloads(config));const cli=resolve(option('--wrangler-cli')??'');if(basename(cli)!=='wrangler.js')fail('Existing official Wrangler CLI required');const pkg=JSON.parse(await readFile(resolve(dirname(cli),'../package.json'),'utf8'));if(pkg.name!=='wrangler'||pkg.version!=='4.155.0')fail('Review this Wrangler version before upload');
      uploader={async put(object){const run=spawnSync(process.execPath,[cli,'r2','object','put','xwx-deck-downloads/'+object.key,'--file',object.path,'--remote','--content-type',object.contentType,'--content-disposition',`attachment; filename="${object.downloadName}"`,'--cache-control',object.cacheControl],{stdio:'inherit',timeout:180000,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});if(run.status!==0)fail('Static upload failed; inspect outcome before any retry');}};
    }
    const trust=JSON.parse(await readFile(new URL('../../assets/update-trust.json',import.meta.url),'utf8'));result=await publishStaticDownloads({config,directory,acceptance,uploader,upload:modes[0]==='--upload-static',singleWriter:args.includes('--single-writer'),trust});
  }
  console.log(JSON.stringify(result,null,2));
}
