/**
 * Ferramentas de remontagem:
 *
 * 1) Remontar conversa:
 *    node decrypt_tool.js convo <numero>
 *
 * 2) Remontar mídia:
 *    node decrypt_tool.js media <MEDIA_CODE>
 *
 * Requer:
 *   WHATSAPP_AUDIT_KEY_B64 igual ao usado no index.js
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOG_DIR = path.join(__dirname, "logs_enc");
const MEDIA_DIR = path.join(__dirname, "media_enc");
const MEDIA_MANIFEST_DIR = path.join(__dirname, "media_manifest");
const OUT_DIR = path.join(__dirname, "remontado");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function getKey() {
  const b64 = "N28BOuBna97kKkKP96DrIJHVdAi67WwOWVnhw10YOcE=";
  if (!b64) throw new Error("WHATSAPP_AUDIT_KEY_B64 não definido.");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("Chave inválida: precisa ser 32 bytes.");
  return key;
}

const KEY = getKey();

function decryptFromBase64(b64) {
  // base64( iv(12) + tag(16) + ciphertext )
  const payload = Buffer.from(b64, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

function decryptFileToBuffer(encFilePath) {
  const payload = fs.readFileSync(encFilePath);
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function extFromMime(mime) {
  if (!mime) return "bin";
  const parts = mime.split("/");
  return (parts[1] || "bin").split(";")[0];
}

function remountConversation(number) {
  const filePath = path.join(LOG_DIR, `${number}.log`);
  if (!fs.existsSync(filePath)) {
    console.error("Arquivo não encontrado:", filePath);
    process.exit(1);
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);

  const outPath = path.join(OUT_DIR, `${number}.txt`);
  const out = [];

  for (const line of lines) {
    const json = decryptFromBase64(line);
    const obj = JSON.parse(json);
    out.push(`${obj.ts} | ${obj.direction} | ${obj.number} | ${obj.name || "-"} | ${obj.text}`);
  }

  fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
  console.log("Conversa remontada em:", outPath);
}

function remountMedia(mediaCode) {
  const manifestPath = path.join(MEDIA_MANIFEST_DIR, `${mediaCode}.json`);
  const encPath = path.join(MEDIA_DIR, `${mediaCode}.bin`);

  if (!fs.existsSync(manifestPath)) {
    console.error("Manifesto não encontrado:", manifestPath);
    process.exit(1);
  }
  if (!fs.existsSync(encPath)) {
    console.error("Binário criptografado não encontrado:", encPath);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const buf = decryptFileToBuffer(encPath);

  const ext = extFromMime(manifest.mimetype);
  const outPath = path.join(OUT_DIR, `${mediaCode}.${ext}`);
  fs.writeFileSync(outPath, buf);

  console.log("Mídia remontada em:", outPath);
  console.log("Manifest:", manifestPath);
}

// CLI
const [,, cmd, arg] = process.argv;

if (!cmd || !arg) {
  console.log("Uso:");
  console.log("  node decrypt_tool.js convo <numero>");
  console.log("  node decrypt_tool.js media <MEDIA_CODE>");
  process.exit(0);
}

if (cmd === "convo") remountConversation(arg);
else if (cmd === "media") remountMedia(arg);
else {
  console.error("Comando inválido:", cmd);
  process.exit(1);
}
