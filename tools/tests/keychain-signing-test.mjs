import assert from 'node:assert/strict';
import {signWithKeychain} from '../release/keychain-signing.mjs';
import {verifyEnvelope} from '../release/update-signature.mjs';

if(process.platform!=='darwin') {
  console.log('SKIP macOS Security/CryptoKit signing adapter on this platform; no Keychain access attempted');
} else {
  const names=[['windows','x64','installer','XwX-Deck-windows-x64-setup.exe'],['windows','x64','portable','XwX-Deck-windows-x64.exe'],['darwin','arm64','disk-image','XwX-Deck-mac-arm64.dmg']];
  const manifest={schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:'1.0.0',tag:'v1.0.0',files:names.map(([platform,arch,kind,name])=>({platform,arch,kind,name,url:'https://download.xwxdeck.com/releases/v1.0.0/'+name,size:1,sha256:'a'.repeat(64)}))};
  // This explicit helper mode generates an ephemeral in-memory fixture key.
  // It neither queries nor writes Keychain, and never uses production trust.
  const result=await signWithKeychain(manifest,{keys:[]},{selfTest:true});
  assert.equal(result.envelope.keyId,'ephemeral-fixture');
  assert.deepEqual(verifyEnvelope(result.envelope,{keys:[{id:'ephemeral-fixture',publicKey:result.publicKey}]}),manifest);
  assert.throws(()=>verifyEnvelope({...result.envelope,payload:Buffer.from('{}').toString('base64')},{keys:[{id:'ephemeral-fixture',publicKey:result.publicKey}]}),/signature/);
  assert.throws(()=>verifyEnvelope(result.envelope,{keys:[]}),/Untrusted/);
  await assert.rejects(signWithKeychain({...manifest,releaseSeries:'unrelated'},{keys:[]}),/Invalid release manifest/);
  const candidateId='a'.repeat(40);
  const candidate={...manifest,candidate:{schemaVersion:1,only:true,commit:candidateId,sourceFingerprint:'b'.repeat(64)},files:manifest.files.map(file=>({...file,url:'https://download.xwxdeck.com/candidates/'+candidateId+'/'+file.name}))};
  await assert.rejects(signWithKeychain(candidate,{keys:[]}),/not a production release/);
  const staged=await signWithKeychain(candidate,{keys:[]},{selfTest:true,candidateId});
  const candidateTrust={keys:[{id:'ephemeral-fixture',publicKey:staged.publicKey}]};
  assert.deepEqual(verifyEnvelope(staged.envelope,candidateTrust,{candidateId}),candidate);
  assert.throws(()=>verifyEnvelope(staged.envelope,candidateTrust),/not a production release/);
  assert.throws(()=>verifyEnvelope(staged.envelope,candidateTrust,{candidateId:'c'.repeat(40)}),/candidate identity/);
  await assert.rejects(signWithKeychain({...candidate,files:candidate.files.map(file=>({...file,url:file.url.replace('/candidates/','/updates/stable/')}))},{keys:[]},{selfTest:true,candidateId}),/Invalid release artifact/);
  console.log('PASS actual Swift/CryptoKit signer interoperates with Node Ed25519 verification; tamper/unknown trust rejected; invalid input rejected before Keychain; ephemeral fixture only, production access not tested');
}
