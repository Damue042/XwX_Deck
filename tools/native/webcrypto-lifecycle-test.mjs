// macOS-only native ownership regression. Uses a nonpersistent WKWebView and
// synthetic wrapping keys; never reads the user's browser or credential store.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.platform !== 'darwin') {
  console.log('SKIP WebKit delegate lifecycle: macOS required');
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'xwx-webcrypto-lifecycle-'));
const source = String.raw`
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
extern void deck_install_webcrypto_key(void *, const unsigned char *, size_t);
static NSUInteger finished = 0;
@interface NavigationOwner : NSObject <WKNavigationDelegate>
@property(nonatomic, strong) WKWebView *view;
@end
@implementation NavigationOwner
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation { finished++; }
@end
static void pump(void) {
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
}
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSMutableDictionary *checks = [NSMutableDictionary dictionary];
        __weak WKWebView *releasedView;
        __weak NavigationOwner *releasedOwner;
        @autoreleasepool {
            WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
            configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
            WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 400, 300) configuration:configuration];
            // Wry's navigation callback owns the view, while InnerWebView owns
            // that callback. Model that ownership without importing Wry.
            NavigationOwner *owner = [NavigationOwner new];
            owner.view = view;
            view.navigationDelegate = owner;
            releasedView = view;
            releasedOwner = owner;
            unsigned char key[32] = {1};
            deck_install_webcrypto_key((__bridge void *)view, key, sizeof(key));
            id proxy = view.navigationDelegate;
            key[0] = 2;
            deck_install_webcrypto_key((__bridge void *)view, key, sizeof(key));
            checks[@"reinstallReusesProxy"] = @(view.navigationDelegate == proxy);
            SEL selector = NSSelectorFromString(@"_webCryptoMasterKeyForWebView:");
            NSData *wrapped = ((NSData *(*)(id, SEL, id))objc_msgSend)(view.navigationDelegate, selector, view);
            checks[@"reinstallUpdatesKey"] = @(wrapped.length == sizeof(key) && ((const unsigned char *)wrapped.bytes)[0] == 2);
            [view loadHTMLString:@"<html><body>isolated navigation</body></html>" baseURL:nil];
            NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
            while (!finished && deadline.timeIntervalSinceNow > 0) pump();
            checks[@"navigationStillForwarded"] = @(finished > 0);
        }
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
        while ((releasedView || releasedOwner) && deadline.timeIntervalSinceNow > 0) pump();
        checks[@"navigationOwnerReleased"] = @(releasedOwner == nil);
        checks[@"webviewReleased"] = @(releasedView == nil);
        BOOL passed = YES;
        for (NSNumber *value in checks.allValues) passed &= value.boolValue;
        NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"passed":@(passed), @"checks":checks} options:NSJSONWritingSortedKeys error:nil];
        puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
        return passed ? 0 : 1;
    }
}
`;
let passed = false;
try {
  const main = join(directory, 'main.m'), binary = join(directory, 'test');
  await writeFile(main, source);
  const implementation = process.env.XWX_WEBCRYPTO_TEST_SOURCE || resolve('src-native/src/webcrypto_store.m');
  const compile = spawnSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'WebKit', main, implementation, '-o', binary], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 25_000 });
  process.stdout.write(run.stdout);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout.trim()).passed, true);
  passed = true;
} finally {
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error('Failed native ownership fixture retained at ' + directory);
}
