import { createPublicKey, sign, verify } from 'node:crypto';

export function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.channel !== 'release' || manifest.releaseSeries !== 'native-v1'
      || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.tag !== `v${manifest.version}`
      || !Array.isArray(manifest.files) || manifest.files.length !== 4) throw Error('Invalid release manifest');
  const identities = new Set();
  for (const file of manifest.files) {
    const identity = `${file.platform}/${file.arch}/${file.kind}`;
    const names = {
      'windows/x64/installer': 'XwX-Deck-windows-x64-setup.exe',
      'windows/x64/portable': 'XwX-Deck-windows-x64.exe',
      'darwin/arm64/disk-image': 'XwX-Deck-mac-arm64.dmg',
      'darwin/x64/disk-image': 'XwX-Deck-mac-x64.dmg'
    };
    if (identities.has(identity) || names[identity] !== file.name
        || file.url !== `https://download.xwxdeck.com/releases/${manifest.tag}/${file.name}`
        || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 1024 ** 3
        || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid release artifact');
    identities.add(identity);
  }
  return manifest;
}

export function signManifest(manifest, privateKey, keyId) {
  validateManifest(manifest);
  const payload = Buffer.from(JSON.stringify(manifest));
  return { schemaVersion: 1, algorithm: 'Ed25519', keyId,
    payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
}

export function verifyEnvelope(envelope, trust) {
  const key = trust.keys.find(key => key.id === envelope.keyId);
  if (envelope.schemaVersion !== 1 || envelope.algorithm !== 'Ed25519' || !key) throw Error('Untrusted update signing key');
  const payload = Buffer.from(envelope.payload ?? '', 'base64');
  const publicKey = Buffer.from(key.publicKey, 'base64');
  if (publicKey.length !== 32 || payload.length > 1024 ** 2) throw Error('Invalid signed update payload');
  // RFC 8410 SubjectPublicKeyInfo wrapping a raw Ed25519 public key.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
  if (!verify(null, payload, createPublicKey({key: spki, format: 'der', type: 'spki'}), Buffer.from(envelope.signature ?? '', 'base64'))) {
    throw Error('Update signature verification failed');
  }
  return validateManifest(JSON.parse(payload));
}
