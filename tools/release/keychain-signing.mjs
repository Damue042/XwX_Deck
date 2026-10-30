import {spawnSync} from 'node:child_process';
import {mkdtemp, realpath, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateManifest, verifyEnvelope} from './update-signature.mjs';

// Explicit manual operation. No security CLI, private-key environment variable,
// disk export, trusted-application change, or background credential access.
export async function signWithKeychain(manifest, trust, {selfTest=false}={}) {
  if(process.platform!=='darwin')throw Error('Keychain signing requires macOS');
  validateManifest(manifest);
  const directory=await mkdtemp(join(await realpath(tmpdir()),'xwx-manifest-sign-'));
  await chmod(directory,0o700);
  try {
    const binary=join(directory,'sign-manifest');
    const compile=spawnSync('/usr/bin/swiftc',['-O',fileURLToPath(new URL('./macos-keychain-sign.swift',import.meta.url)),'-o',binary],{encoding:'utf8',timeout:60000});
    if(compile.status!==0)throw Error('Unable to compile local Keychain signing helper: '+(compile.stderr||compile.error?.message||compile.status));
    const signed=spawnSync(binary,[selfTest?'--self-test':'--sign'],{input:JSON.stringify(manifest),encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
    if(signed.status!==0)throw Error('Keychain signing did not complete: '+(signed.stderr||signed.error?.message||signed.status));
    const result=JSON.parse(signed.stdout);
    const acceptedTrust=selfTest?{keys:[{id:'ephemeral-fixture',publicKey:result.publicKey}]}:trust;
    const verified=verifyEnvelope(result.envelope,acceptedTrust);
    if(JSON.stringify(verified)!==JSON.stringify(manifest))throw Error('Signed manifest changed during signing');
    return selfTest?result:result.envelope;
  } finally {await rm(directory,{recursive:true,force:true});}
}
