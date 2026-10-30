import{createServer as createModelServer}from'node:http';
import{createServer}from'node:https';import{generateKeyPairSync,sign,createHash,randomUUID}from'node:crypto';import{mkdirSync,writeFileSync,readFileSync,chmodSync,unlinkSync,existsSync,readdirSync,realpathSync}from'node:fs';import{spawnSync}from'node:child_process';import{resolve,join}from'node:path';
process.umask(0o077);
if(!process.argv[2])throw Error('Explicit fresh temporary fixture directory required');
const requested=resolve(process.argv[2]);
if(!requested.startsWith('/private/tmp/'))throw Error('Use a fresh /private/tmp fixture directory; Documents requires independent TCC consent');
if(existsSync(requested)&&readdirSync(requested).length)throw Error('Existing fixture/evidence preserved; select a fresh directory');
mkdirSync(requested,{recursive:true});const root=realpathSync(requested);chmodSync(root,0o700);
process.once('exit',()=>{for(const name of ['ca.key','server.key']){const file=join(root,name);if(existsSync(file))unlinkSync(file);}});
process.once('SIGINT',()=>process.exit(0));
function command(args){const r=spawnSync('/usr/bin/openssl',args,{stdio:'ignore'});if(r.status!==0)throw Error('TLS fixture creation failed: '+args[0]);}
writeFileSync(join(root,'ca.cnf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=XwX isolated update acceptance CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
writeFileSync(join(root,'tls.cnf'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
command(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'ca.key'),'-out',join(root,'ca.pem'),'-days','1','-config',join(root,'ca.cnf')]);
command(['req','-new','-newkey','rsa:2048','-nodes','-keyout',join(root,'server.key'),'-out',join(root,'server.csr'),'-subj','/CN=127.0.0.1']);
command(['x509','-req','-in',join(root,'server.csr'),'-CA',join(root,'ca.pem'),'-CAkey',join(root,'ca.key'),'-CAcreateserial','-out',join(root,'server.pem'),'-days','1','-extfile',join(root,'tls.cnf')]);unlinkSync(join(root,'ca.key'));
const pair=generateKeyPairSync('ed25519'),wrong=generateKeyPairSync('ed25519');const trust={schemaVersion:1,algorithm:'Ed25519',keys:[{id:'isolated-mac-validation',publicKey:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')}]};
writeFileSync(join(root,'control.json'),JSON.stringify({mode:'network-failure'}));const log=[];
const server=createServer({key:readFileSync(join(root,'server.key')),cert:readFileSync(join(root,'server.pem'))},(req,res)=>{
 const mode=JSON.parse(readFileSync(join(root,'control.json'))).mode;log.push({at:new Date().toISOString(),path:req.url,mode});writeFileSync(join(root,'https-requests.json'),JSON.stringify(log,null,2));
 if(mode==='network-failure'){res.writeHead(503);res.end('isolated failure');return;}
 let registry;try{registry=JSON.parse(readFileSync(join(root,'artifacts.json')));}catch{res.writeHead(503);res.end('not built');return;}
 const file=registry[mode==='invalid-platform-signature'?'invalid':'good'];
 if(req.url==='/release.json'){
  const payload=Buffer.from(JSON.stringify({schemaVersion:1,channel:'mac-validation',releaseSeries:'mac-update-validation-v1',version:mode==='up-to-date'?'0.9.9':'1.0.0',tag:mode==='up-to-date'?'v0.9.9':'v1.0.0',changelog:'Isolated acceptance only; never a production release',files:[{platform:'darwin',arch:process.arch,kind:'disk-image',name:'XwX-Deck-mac-'+process.arch+'.dmg',url:base+'/package.dmg',size:file.bytes,sha256:file.sha256}]}));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({schemaVersion:1,algorithm:'Ed25519',keyId:'isolated-mac-validation',payload:payload.toString('base64'),signature:sign(null,payload,mode==='bad-signature'?wrong.privateKey:pair.privateKey).toString('base64')}));return;
 }
 if(req.url!=='/package.dmg'){res.writeHead(404);res.end();return;}
 const bytes=readFileSync(file.path);res.setHeader('content-length',bytes.length);
 if(mode==='interrupted-download'){res.write(bytes.subarray(0,1024));setTimeout(()=>res.destroy(),30);return;}
 if(mode==='corrupt-download')bytes[bytes.length-1]^=1;res.end(bytes);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='https://127.0.0.1:'+server.address().port;
const modelServer=createModelServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'nightly-fixture'}]}));return;}
 if(req.method==='POST'){for await(const _chunk of req){}res.end(JSON.stringify({id:'nightly-fixture',object:'response',status:'completed',model:'nightly-fixture',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'isolated nightly fixture'}]}],usage:{input_tokens:1,output_tokens:1}}));return;}
 res.writeHead(404);res.end('{}');
});await new Promise(r=>modelServer.listen(0,'127.0.0.1',r));const modelBase='http://127.0.0.1:'+modelServer.address().port+'/v1';
const id=randomUUID();writeFileSync(join(root,'fixture-id'),id);const metadata={id,root,base,modelBase,trust,caSha256:createHash('sha256').update(readFileSync(join(root,'ca.pem'))).digest('hex'),pid:process.pid,createdAt:new Date().toISOString(),ephemeralKeys:true,systemTrustChanged:false,productionKeyUsed:false};writeFileSync(join(root,'fixture.json'),JSON.stringify(metadata,null,2));console.log(JSON.stringify(metadata));
process.on('SIGTERM',()=>{server.close();modelServer.close();process.exit(0);});
