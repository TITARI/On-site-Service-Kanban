import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

console.log(`WXAUTO_UPDATE_SIGNING_PRIVATE_KEY=${JSON.stringify(privateKey.export({ format: "pem", type: "pkcs8" }).toString())}`);
console.log(`WXAUTO_UPDATE_SIGNING_PUBLIC_KEY=${JSON.stringify(publicKey.export({ format: "pem", type: "spki" }).toString())}`);
