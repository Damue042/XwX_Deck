import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';

// Base UI 1.7.0 measures and mutates the root during ResizeObserver delivery.
// WebKit can report an undelivered resize notification when toast text changes.
// Keep this narrowly pinned until the upstream package supplies the same fix.
const root = new URL('../../', import.meta.url);
const packageRoot = new URL('node_modules/@base-ui/react/', root);
const pkg = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
assert.equal(pkg.version, '1.7.0', 'Review the ToastContent resize patch before upgrading Base UI');
const hashes = {
  mjs: ['273a08cbca9fe8a4475f312b4cb5ca8f3fff6decc4fcacaf4ebb06c9cf441270', '49305af38c153080d322365caddcba2440224e45b54c70953bdb53c436ce1eba'],
  js: ['d7ce45e608f5ac0f4d05bdd8807d46803e1bd2eb454bac4fa2499e54889ec773', '6aca71cf09ad8794b7db947ca8c31ec9d88c74099e6119cc5c3c5345dc3b9850'],
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const scheduledObserver = `const observerWindow = node.ownerDocument.defaultView ?? window;
    let resizeFrame = 0;
    // Height measurement mutates the toast root; keep it outside RO delivery.
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = observerWindow.requestAnimationFrame(() => {
        resizeFrame = 0;
        recalculateHeight(true);
      });
    });`;
// Validate both inputs before writing either file. Unknown bytes fail closed.
const changes = [];
for (const [extension, [before, after]] of Object.entries(hashes)) {
  const file = new URL(`toast/content/ToastContent.${extension}`, packageRoot);
  const source = await readFile(file, 'utf8');
  if (sha256(source) === after) continue;
  assert.equal(sha256(source), before, `Unexpected Base UI ToastContent.${extension}`);
  const patched = source
    .replace('const resizeObserver = new ResizeObserver(() => recalculateHeight(true));', scheduledObserver)
    .replace('      resizeObserver.disconnect();', '      observerWindow.cancelAnimationFrame(resizeFrame);\n      resizeObserver.disconnect();');
  assert.equal(sha256(patched), after, 'ToastContent patch no longer matches the reviewed output');
  changes.push({ file, patched });
}
for (const { file, patched } of changes) {
  const temporary = new URL(file.href + `.xwx-${process.pid}.tmp`);
  await writeFile(temporary, patched, { flag: 'wx' });
  await rename(temporary, file);
}
console.log('Base UI ToastContent: coalesced resize measurement with frame cleanup');
