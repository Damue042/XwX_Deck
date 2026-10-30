export async function checkEditionRelease({read,check,contract,settings,config}) {
 const update=await read('src-native/src/edition/update-source.rs');
 const extension=await read('src-native/src/edition/core.rs');
 check(contract.providerFramework.defaultConnections.length===0&&/connections:\s*vec!\[\s*\]/.test(settings)&&/fresh_settings[^]*Settings::default/.test(extension),'new install has no saved connection');
 check(contract.traceRetention.defaultStorageLimitGB===1&&contract.traceRetention.automaticCleanupEnabledByDefault,'default 1 GB automatic cleanup');
 check(update.includes(contract.updates.defaultServer)&&update.includes('XWX_DECK_UPDATE_SERVER_URL'),'release update source');
 check(/fn metadata_events\(\)[^]*String::new\(\)/.test(config),'metadata push disabled by default');
 for(const key of ['windows','macosArm64'])check(contract.platforms[key]?.publishedArtifactName,'release artifact identity: '+key);
 check(/AUTOMATIC_MACOS_UPDATES:\s*bool\s*=\s*true/.test(config),'ordinary macOS automatic updates enabled');
 for(const key of ['macosArm64'])check(contract.platforms[key].installMode==='automatic'&&contract.platforms[key].automaticInstall&&contract.platforms[key].unsignedFallback==='manual-dmg','signed automatic update and unsigned fallback: '+key);
 check(JSON.stringify(Object.keys(contract.platforms))===JSON.stringify(['windows','macosArm64']),'current release supports Windows x64 and Apple Silicon only');
 const workflows=(await Promise.all(['ci','pages','release'].map(name=>read('.github/workflows/'+name+'.yml')))).join('\n');
 check(workflows.includes('release-distribution-candidate')&&workflows.includes('write-release-manifest.mjs')&&workflows.includes('Set up Rust'),'native CI and distribution staging gates');
}
