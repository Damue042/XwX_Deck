import assert from 'node:assert/strict';
import {signWithKeychain} from '../release/keychain-signing.mjs';
import {verifyEnvelope} from '../release/update-signature.mjs';

if(process.platform!=='darwin') {
  console.log('SKIP macOS Security/CryptoKit signing adapter on this platform; no Keychain access attempted');
} else {
  const names=[['windows','x64','installer','XwX-Deck-windows-x64-setup.exe'],['windows','x64','portable','XwX-Deck-windows-x64.exe'],['darwin','arm64','disk-image','XwX-Deck-mac-arm64.dmg'],['darwin','x64','disk-image','XwX-Deck-mac-x64.dmg']];
  const manifest={schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:'1.0.0',tag:'v1.0.0',files:names.map(([platform,arch,kind,name])=>({platform,arch,kind,name,url:'https://download.xwxdeck.com/releases/v1.0.0/'+name,size:1,sha256:'a'.repeat(64)}))};
  // This explicit helper mode generates an ephemeral in-memory fixture key.
  // It neither queries nor writes Keychain, and never uses production trust.
  const result=await signWithKeychain(manifest,{keys:[]},{selfTest:true});
  assert.equal(result.envelope.keyId,'ephemeral-fixture');
  assert.deepEqual(verifyEnvelope(result.envelope,{keys:[{id:'ephemeral-fixture',publicKey:result.publicKey}]}),manifest);
  assert.throws(()=>verifyEnvelope({...result.envelope,payload:Buffer.from('{}').toString('base64')},{keys:[{id:'ephemeral-fixture',publicKey:result.publicKey}]}),/signature/);
  assert.throws(()=>verifyEnvelope(result.envelope,{keys:[]}),/Untrusted/);
  await assert.rejects(signWithKeychain({...manifest,releaseSeries:'unrelated'},{keys:[]}),/Invalid release manifest/);
  console.log('PASS actual Swift/CryptoKit signer interoperates with Node Ed25519 verification; tamper/unknown trust rejected; invalid input rejected before Keychain; ephemeral fixture only, production access not tested');
}
