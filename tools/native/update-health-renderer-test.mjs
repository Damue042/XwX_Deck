import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {url:'https://health.test/'});
for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','CustomEvent']) {
  Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Health acknowledgement must work independently of visibility/paint scheduling.
globalThis.requestAnimationFrame = () => {throw Error('Startup health must not require a foreground animation frame');};
globalThis.__healthFixture={bridge:null,notices:[]};
const {default:React,act}=await import('react');const {createRoot}=await import('react-dom/client');
const bundle=await build({entryPoints:[resolve('src/renderer/features/shell/NativeLifecycleActions.tsx')],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/*'],plugins:[{name:'health-fixture',setup(build){
  const sources={
    '@/bridge/store':'export const useBridge=()=>globalThis.__healthFixture.bridge;',
    '@/components/ui/confirm-dialog':'export const useConfirm=()=>async()=>false;',
    '@/lib/toast':'export const showToast=(...args)=>globalThis.__healthFixture.notices.push(args);',
    '@/lib/i18n':'export const t=value=>value;',
    '@/lib/errors':'export const userErrorMessage=String;'
  };
  build.onResolve({filter:/^@\//},args=>Object.hasOwn(sources,args.path)?{path:args.path,namespace:'health'}:undefined);
  build.onLoad({filter:/.*/,namespace:'health'},args=>({contents:sources[args.path],loader:'js'}));
}}]});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const Component=module.exports.NativeLifecycleActions;
let calls=0,fail=false;
const api={async confirmUpdateStartup(){calls++;if(fail)throw Error('injected channel failure');}};
let root=createRoot(document.getElementById('root'));
async function render(bridge){globalThis.__healthFixture.bridge=bridge;await act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(Component)));});}
try {
  await render({api,booted:false,runtime:null,loadIssues:[]});assert.equal(calls,0);
  await render({api,booted:true,runtime:null,loadIssues:[]});assert.equal(calls,0);
  await render({api,booted:true,runtime:{},loadIssues:['backend unavailable']});assert.equal(calls,0);
  await render({api,booted:true,runtime:{},loadIssues:[]});assert.equal(calls,1);
  await render({api,booted:true,runtime:{changed:true},loadIssues:[]});assert.equal(calls,1);
  await act(async()=>root.unmount());
  root=createRoot(document.getElementById('root'));fail=true;
  await render({api,booted:true,runtime:{},loadIssues:[]});assert.equal(calls,2);assert.equal(globalThis.__healthFixture.notices.length,1);
  fail=false;await render({api,booted:true,runtime:{retry:true},loadIssues:[]});assert.equal(calls,3);
  await act(async()=>root.unmount());
  root=createRoot(document.getElementById('root'));
  let release;const pendingApi={confirmUpdateStartup(){calls++;return new Promise(resolve=>{release=resolve;});}};
  await render({api:pendingApi,booted:true,runtime:{},loadIssues:[]});assert.equal(calls,4);
  await render({api:pendingApi,booted:true,runtime:{refresh:true},loadIssues:[]});assert.equal(calls,4);
  await act(async()=>release());
  await render({api:pendingApi,booted:true,runtime:{again:true},loadIssues:[]});assert.equal(calls,4);
  await act(async()=>root.unmount());
  console.log('PASS real React startup lifecycle: no acknowledgement before backend readiness or after load failure; one StrictMode acknowledgement after commit; no duplicate during pending RPC; background-safe without animation frames; failed handshake remains retryable');
} finally {dom.window.close();delete globalThis.__healthFixture;}
