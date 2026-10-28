import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import esbuild from 'esbuild';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const root=resolve(import.meta.dirname,'../..');
const bundled=await esbuild.build({entryPoints:[resolve(root,'src/renderer/lib/i18n.ts')],bundle:true,platform:'node',format:'esm',write:false});
const i18n=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const english=(await import(`data:text/javascript;base64,${Buffer.from((await esbuild.build({entryPoints:[resolve(root,'src/renderer/lib/locales/en.ts')],bundle:true,platform:'node',format:'esm',write:false})).outputFiles[0].text).toString('base64')}`)).english;
const placeholders=value=>[...value.matchAll(/\{\d+\}/g)].map(match=>match[0]).sort();
for(const {id}of i18n.LANGUAGES){
  if(id!=='zh-CN'&&id!=='en'){
    const dictionary=JSON.parse(await readFile(resolve(root,`src/renderer/lib/locales/${id}.json`),'utf8'));
    for(const [key,value]of Object.entries(english)){
      assert.ok(dictionary[key]?.trim(),`${id}: missing ${key}`);
      assert.deepEqual(placeholders(dictionary[key]),placeholders(value),`${id}: placeholders ${key}`);
    }
  }
  i18n.applyLanguage(id);
  assert.equal(i18n.getLanguage(),id);
  assert.notEqual(i18n.t('语言'),'');
  assert.ok(i18n.t('{0} 的更多操作','USER_MODEL_42').includes('USER_MODEL_42'));
}
for(const [input,expected]of [['zh-Hant-HK','zh-TW'],['zh_HK.UTF-8','zh-TW'],['zh-Hans-SG','zh-CN'],['ja-JP','ja'],['ko-KR','ko'],['fr-FR','fr'],['de-DE','de'],['es-MX','es'],['pt_BR','pt-BR'],['it-IT','en']])assert.equal(i18n.systemLanguage([input]),expected);
i18n.applyLanguage('ja');
await assert.rejects(i18n.changeLanguage('fr',async()=>{throw Error('isolated save failure')}));
assert.equal(i18n.getLanguage(),'ja','failed persistence restores previous language');
await i18n.changeLanguage('de',async()=>{});
i18n.restoreLanguage('en');assert.equal(i18n.getLanguage(),'de','late runtime must not overwrite explicit choice');
console.log(`PASS ${i18n.LANGUAGES.length} languages: full dictionary coverage, placeholders, system matching, rollback and explicit choice preservation`);

// Render the real rail with its actual edition navigation metadata. Keep page
// implementations outside this fixture so it exercises language changes only.
const editionSource = await readFile(resolve(root, 'src/renderer/edition/index.tsx'), 'utf8');
const editionAst = ts.createSourceFile('index.tsx', editionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let navigation;
for (const statement of editionAst.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(editionAst) === 'editionNavItems') navigation = declaration.initializer?.getText(editionAst);
  }
}
assert.ok(navigation, 'edition navigation metadata is available');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://deck.test/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(resolve(root, 'package.json'));
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
const output = await esbuild.build({
  stdin: { contents: "export { Rail } from './src/renderer/features/shell/Rail'; export { applyLanguage, t, LANGUAGES } from './src/renderer/lib/i18n'; export { editionDictionaries } from './src/renderer/edition/locales';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  plugins: [{ name: 'language-rail-fixture', setup(build) {
    build.onResolve({ filter: /^@\/(edition|bridge\/api|lib\/toast)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'ts', resolveDir: root, contents: args.path === '@/edition'
      ? `import { RefreshCw, Wrench } from 'lucide-react'; export const editionNavItems = ${navigation};`
      : args.path.endsWith('api') ? 'export const getApi = () => ({ openDashboard: async () => {} });'
      : 'export const showErrorToast = () => {};' }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const ui = module.exports;
const mount = createRoot(document.getElementById('root'));
await act(async () => mount.render(React.createElement(ui.Rail, { activePage: 'models', onNavigate() {}, updateState: null })));
const hint = '从「{0}」添加已安装的客户端';
for (const { id } of ui.LANGUAGES) {
  await act(async () => ui.applyLanguage(id));
  assert.ok(ui.t(hint, ui.t('客户端管理')).includes(ui.t('客户端管理')), `${id}: empty-state hint uses the actual client-management label`);
  if (id !== 'zh-CN') {
    const common = id === 'en' ? english : JSON.parse(await readFile(resolve(root, `src/renderer/lib/locales/${id}.json`), 'utf8'));
    for (const key of Object.keys(ui.editionDictionaries.en ?? {})) {
      assert.ok((common[key] ?? ui.editionDictionaries[id]?.[key])?.trim(), `${id}: missing edition translation ${key}`);
    }
  }
  for (const [page, label] of [['sync', '同步'], ['tools', '工具']]) {
    const button = document.querySelector(`[data-page="${page}"]`);
    if (!button) continue;
    const translated = ui.t(label);
    if (!['zh-CN', 'zh-TW'].includes(id)) assert.notEqual(translated, label, `${id}: edition navigation is translated`);
    assert.equal(button.textContent, translated, `${id}: visible navigation updates`);
    assert.equal(button.getAttribute('aria-label'), translated, `${id}: accessible navigation updates`);
    assert.equal(button.getAttribute('data-tip'), translated, `${id}: collapsed navigation tooltip updates`);
  }
}
await act(async () => mount.unmount());
dom.window.close();
console.log(`PASS ${ui.LANGUAGES.length} languages: actual rail updates, edition dictionaries and client-management hint labels`);
