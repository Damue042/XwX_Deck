// Manual release signing only. The private key remains inside this process and Keychain.
import Foundation
import Security
import CryptoKit
func stop(_ message:String)->Never {fputs(message+"\n",stderr);exit(1)}
let input=FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 1024*1024,
      let manifest=(try? JSONSerialization.jsonObject(with:input)) as? [String:Any],
      manifest["schemaVersion"] as? Int == 1,
      manifest["channel"] as? String == "release",
      manifest["releaseSeries"] as? String == "native-v1",
      let version=manifest["version"] as? String,
      version.range(of:"^[0-9]+\\.[0-9]+\\.[0-9]+$",options:.regularExpression) != nil,
      manifest["tag"] as? String == "v"+version,
      let files=manifest["files"] as? [[String:Any]],files.count==4 else {stop("Invalid release manifest; Keychain not accessed")}
let names=["windows/x64/installer":"XwX-Deck-windows-x64-setup.exe","windows/x64/portable":"XwX-Deck-windows-x64.exe","darwin/arm64/disk-image":"XwX-Deck-mac-arm64.dmg","darwin/x64/disk-image":"XwX-Deck-mac-x64.dmg"]
let arguments=Array(CommandLine.arguments.dropFirst())
let selfTest:Bool
let candidateId:String?
if arguments == ["--self-test"] || arguments == ["--sign"] {
    selfTest=arguments == ["--self-test"];candidateId=nil
    guard manifest["candidate"] == nil else {stop("Candidate manifest is not a production release; Keychain not accessed")}
} else {
    guard arguments.count==2,["--self-test-candidate","--sign-candidate"].contains(arguments[0]),
          arguments[1].range(of:"^[a-f0-9]{40}$",options:.regularExpression) != nil,
          let candidate=manifest["candidate"] as? [String:Any],candidate["schemaVersion"] as? Int == 1,
          candidate["commit"] as? String == arguments[1],candidate["only"] as? Bool == true,
          let fingerprint=candidate["sourceFingerprint"] as? String,
          fingerprint.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else {stop("Invalid candidate identity; Keychain not accessed")}
    selfTest=arguments[0] == "--self-test-candidate";candidateId=arguments[1]
}
let artifactBase=candidateId.map{"https://download.xwxdeck.com/candidates/"+$0} ?? "https://download.xwxdeck.com/releases/v"+version
var seen=Set<String>()
for file in files {
    guard let platform=file["platform"] as? String,let arch=file["arch"] as? String,let kind=file["kind"] as? String,
          let name=names[platform+"/"+arch+"/"+kind],file["name"] as? String == name,
          file["url"] as? String == artifactBase+"/"+name,
          let size=file["size"] as? Int,size>0,size<=1024*1024*1024,
          let hash=file["sha256"] as? String,hash.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil,
          seen.insert(name).inserted else {stop("Invalid release artifact; Keychain not accessed")}
}
let key:Curve25519.Signing.PrivateKey
let id:String
if selfTest {
    key=Curve25519.Signing.PrivateKey();id="ephemeral-fixture"
} else {
    let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"XwXDeck.ReleaseSigning",kSecAttrAccount as String:"release-ed25519-v1",kSecReturnData as String:true,kSecMatchLimit as String:kSecMatchLimitOne]
    var value:CFTypeRef?
    let result=SecItemCopyMatching(query as CFDictionary,&value)
    guard result==errSecSuccess,let data=value as? Data,let pem=String(data:data,encoding:.utf8) else {stop("Keychain signing access failed: \(result)")}
    let lines=pem.components(separatedBy:.newlines).filter{!$0.hasPrefix("-----")}.joined()
    let prefix=Data([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20])
    guard let der=Data(base64Encoded:lines),der.count==48,der.prefix(16)==prefix else {stop("Stored signing key format is invalid")}
    key=try Curve25519.Signing.PrivateKey(rawRepresentation:der.suffix(32));id="release-ed25519-v1"
}
let signature=try key.signature(for:input)
let output:[String:Any]=["schemaVersion":1,"algorithm":"Ed25519","keyId":id,"payload":input.base64EncodedString(),"signature":signature.base64EncodedString()]
// Test mode returns only its ephemeral PUBLIC key, never a private representation.
var response:[String:Any]=["envelope":output]
if id=="ephemeral-fixture" {response["publicKey"]=key.publicKey.rawRepresentation.base64EncodedString()}
print(String(data:try JSONSerialization.data(withJSONObject:response,options:[.sortedKeys]),encoding:.utf8)!)
