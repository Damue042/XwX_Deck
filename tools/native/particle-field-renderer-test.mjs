import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import esbuild from 'esbuild';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div id="root" class="page current"></div>',{url:'https://field.test/'});
for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','CustomEvent'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let focused=true,hidden=false,sequence=0,paints=0,observers=0;
Object.defineProperty(document,'hasFocus',{value:()=>focused});
Object.defineProperty(document,'hidden',{get:()=>hidden});
dom.window.matchMedia=()=>({matches:false});
const frames=new Map(),listeners=new Map(),resizers=new Set();
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame=callback=>{const id=++sequence;frames.set(id,callback);return id;};
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame=id=>frames.delete(id);
globalThis.ResizeObserver=class{constructor(callback){this.callback=callback;}observe(){observers++;resizers.add(this.callback);}disconnect(){observers--;resizers.delete(this.callback);}};
const ctx=new Proxy({}, {get:(_,key)=>key==='clearRect'?()=>paints++:()=>{},set:()=>true});
dom.window.HTMLCanvasElement.prototype.getContext=()=>ctx;
dom.window.HTMLCanvasElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:100,height:100});
for(const [target,prefix]of [[document,'document'],[dom.window,'window']]){
  const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);
  target.addEventListener=(name,callback,...args)=>{if(['focus','blur','visibilitychange','xwx:pagechange','xwx:field-ripple','xwx:native-window-focus'].includes(name)){const key=prefix+':'+name;if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(callback);}return add(name,callback,...args);};
  target.removeEventListener=(name,callback,...args)=>{const key=prefix+':'+name;const group=listeners.get(key);group?.delete(callback);if(group?.size===0)listeners.delete(key);return remove(name,callback,...args);};
}
const rootPath=resolve(import.meta.dirname,'../..'),require=createRequire(resolve(rootPath,'package.json'));
const {act,createElement}=require('react'),{createRoot}=require('react-dom/client');
const result=await esbuild.build({entryPoints:[resolve(rootPath,'src/renderer/features/trace/ParticleField.tsx')],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/*'],plugins:[{name:'desktop-field-fixture',setup(build){build.onResolve({filter:/^@\/bridge\/api$/},()=>({path:'api',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const isDesktop=()=>true;'}));}}]});
const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,module,module.exports);
const root=createRoot(document.querySelector('#root'));
const flush=time=>{const callbacks=[...frames.values()];frames.clear();for(const callback of callbacks)callback(time);};
try{
  await act(async()=>root.render(createElement(module.exports.ParticleField)));
  const canvas=document.querySelector('canvas');
  await act(async()=>root.render(createElement(module.exports.ParticleField,{paused:true})));
  assert.equal(frames.size,0);assert.equal(canvas.width,100,'explicitly paused field keeps its bitmap');
  const stillPaints=paints;flush(90);assert.equal(paints,stillPaints);
  await act(async()=>root.render(createElement(module.exports.ParticleField,{paused:false})));
  assert.equal(frames.size,1,'resuming schedules one animation loop');

  assert.equal(frames.size,1);flush(100);assert.ok(paints>0);
  focused=false;dom.window.dispatchEvent(new Event('blur'));assert.equal(frames.size,0);assert.equal(canvas.dataset.rendering,'paused');
  const paused=paints;flush(200);assert.equal(paints,paused);
  for(let n=0;n<100;n++){
    focused=true;dom.window.dispatchEvent(new Event('focus'));assert.equal(frames.size,1);
    focused=false;dom.window.dispatchEvent(new Event('blur'));assert.equal(frames.size,0);
  }
  focused=true;dom.window.dispatchEvent(new Event('focus'));
  document.documentElement.dataset.nativeWindowActive='false';dom.window.dispatchEvent(new Event('xwx:native-window-focus'));assert.equal(frames.size,0);
  document.documentElement.dataset.nativeWindowActive='true';dom.window.dispatchEvent(new Event('xwx:native-window-focus'));assert.equal(frames.size,1);
  document.querySelector('#root').classList.remove('current');document.dispatchEvent(new Event('xwx:pagechange'));assert.equal(frames.size,0);
  assert.equal(canvas.width,1);assert.equal(canvas.height,1);
  document.querySelector('#root').classList.add('current');document.dispatchEvent(new Event('xwx:pagechange'));assert.equal(frames.size,1);
  assert.equal(canvas.width,100);assert.equal(canvas.height,100);
  focused=false;dom.window.dispatchEvent(new Event('blur'));
  assert.equal(canvas.width,100,'visible blurred window retains its still frame');
  document.documentElement.dataset.nativeWindowVisible='false';dom.window.dispatchEvent(new Event('xwx:native-window-focus'));
  assert.equal(canvas.width,1);assert.equal(canvas.height,1);
  document.documentElement.dataset.nativeWindowVisible='true';dom.window.dispatchEvent(new Event('xwx:native-window-focus'));
  assert.equal(canvas.width,100,'unfocused reopen restores its still frame');assert.equal(frames.size,0);
  focused=true;dom.window.dispatchEvent(new Event('focus'));
  hidden=true;document.dispatchEvent(new Event('visibilitychange'));assert.equal(frames.size,0);
  assert.equal(canvas.width,1);assert.equal(canvas.height,1);
  hidden=false;document.dispatchEvent(new Event('visibilitychange'));assert.equal(frames.size,1);
  await act(async()=>root.unmount());assert.equal(frames.size,0);assert.equal(observers,0);assert.equal(listeners.size,0);
  globalThis.getComputedStyle=dom.window.getComputedStyle;
  globalThis.MutationObserver=dom.window.MutationObserver;
  const chartBundle=await esbuild.build({entryPoints:[resolve(rootPath,'src/renderer/features/trace/ThroughputChart.tsx')],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/*'],plugins:[{name:'chart-fixture',setup(build){build.onResolve({filter:/^@\/lib\/(i18n|format)$/},args=>({path:args.path,namespace:'chart-fixture'}));build.onLoad({filter:/.*/,namespace:'chart-fixture'},args=>({contents:args.path.endsWith('i18n')?'export const t=m=>m;export const useLanguage=()=>"zh-CN";':'export const formatNumber=n=>String(n);export const formatTime=()=>"";'}));}}]});
  const chartModule={exports:{}};new Function('require','module','exports',chartBundle.outputFiles[0].text)(require,chartModule,chartModule.exports);
  const chartRoot=createRoot(document.querySelector('#root'));
  const chart=active=>createElement(chartModule.exports.ThroughputChart,{active,series:[]});
  await act(async()=>chartRoot.render(chart(false)));
  const chartCanvas=document.querySelector('canvas');assert.equal(chartCanvas.width,1);assert.equal(observers,0);assert.equal(frames.size,0);
  await act(async()=>chartRoot.render(chart(true)));assert.equal(observers,1);assert.equal(frames.size,1);
  const beforeChartPaints=paints;
  for(let n=0;n<10;n++)for(const callback of resizers)callback([]);
  assert.equal(paints,beforeChartPaints,'size delivery does not mutate a canvas');assert.equal(frames.size,1,'resize notifications share one paint');
  flush(500);assert.equal(paints,beforeChartPaints+1);assert.equal(chartCanvas.width,100);
  for(const callback of resizers)callback([]);assert.equal(frames.size,1);
  await act(async()=>chartRoot.render(chart(false)));assert.equal(frames.size,0);assert.equal(observers,0);assert.equal(chartCanvas.width,1);
  await act(async()=>chartRoot.unmount());assert.equal(resizers.size,0);assert.equal(listeners.size,0);
  const bridgeDom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://tauri.localhost/',runScripts:'outside-only'});
  try{
    bridgeDom.window.__TAURI__={core:{invoke:async()=>({})},event:{listen:async()=>()=>{}}};
    const bridgeBundle=await esbuild.build({entryPoints:[resolve(rootPath,'tools/native/bridge.ts')],bundle:true,platform:'browser',format:'iife',write:false,define:{__NATIVE_ARCH__:'"x64"'}});
    bridgeDom.window.eval(bridgeBundle.outputFiles[0].text);
    for(let n=0;n<160;n++)bridgeDom.window.dispatchEvent(new bridgeDom.window.ErrorEvent('error',{message:n+':'+ 'x'.repeat(65536)}));
    const buffered=bridgeDom.window.__pilotErrors;
    assert.equal(buffered.length,64);assert.ok(buffered[0].startsWith('96:'));assert.ok(buffered.at(-1).startsWith('159:'));assert.ok(buffered.every(message=>message.length<=4096));
    const rejection=new bridgeDom.window.Event('unhandledrejection');Object.defineProperty(rejection,'reason',{value:'isolated rejection'});bridgeDom.window.dispatchEvent(rejection);
    assert.equal(buffered.length,64);assert.equal(buffered.at(-1),'isolated rejection');
  }finally{bridgeDom.window.close();}
  console.log(JSON.stringify({passed:true,checks:['desktop field pauses while unfocused without further draws','100 focus/blur cycles schedule at most one animation','native inactivity pauses even when WebView retains document focus','page and visibility changes pause/resume the field','hidden pages and windows release canvas bitmaps','unfocused visible windows retain and restore still frames','unmount releases animation, resize observation and all field listeners','inactive throughput charts release bitmaps and size subscriptions','resize delivery defers and coalesces chart paints','hiding the chart cancels pending paints','160 large runtime errors retain only 64 bounded diagnostic excerpts','unhandled rejections use the same bounded diagnostic buffer']}));
}finally{dom.window.close();}
