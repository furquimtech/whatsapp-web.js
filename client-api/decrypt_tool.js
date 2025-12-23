/**
 * decrypt_tool.js
 *
 * Uso:
 *   node decrypt_tool.js convo <clientId> <remoteNumber>
 *   node decrypt_tool.js media <clientId> <mediaCode>
 *
 * Requer:
 *   WHATSAPP_AUDIT_KEY_B64 (base64 de 32 bytes) - mesma usada para criptografar
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE_DIR = path.join(__dirname, "audit");
const LOG_DIR = path.join(BASE_DIR, "logs_enc");
const MEDIA_DIR = path.join(BASE_DIR, "media_enc");
const MEDIA_MANIFEST_DIR = path.join(BASE_DIR, "media_manifest");
const OUT_DIR = path.join(BASE_DIR, "remontado");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function safePart(v) {
  return String(v || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function getKey() {
  const b64 = "Xr9/1yu0vDPb6crDM+AAOfKStMpOLKEN43/O3+H/C4c="; //process.env.WHATSAPP_AUDIT_KEY_B64;
  if (!b64) throw new Error("WHATSAPP_AUDIT_KEY_B64 não definido.");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error(`Chave inválida: precisa ser 32 bytes (veio ${key.length}).`);
  }
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

function remountConversation(clientId, remoteNumber) {
  const fp = path.join(LOG_DIR, safePart(clientId), `${safePart(remoteNumber)}.log`);
  if (!fs.existsSync(fp)) {
    console.error("Log não encontrado:", fp);
    process.exit(1);
  }

  const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/).filter(Boolean);

  const outPath = path.join(
    OUT_DIR,
    `convo_${safePart(clientId)}__${safePart(remoteNumber)}.txt`
  );

  const outLines = [];
  for (const line of lines) {
    try {
      const json = decryptFromBase64(line);
      const obj = JSON.parse(json);
      outLines.push(
        `${obj.ts} | ${obj.direction} | clientId=${obj.clientId} | remote=${obj.remoteNumber} | ${obj.remoteName || "-"} | ${obj.text}`
      );
    } catch (e) {
      outLines.push(`[ERRO ao descriptografar linha] ${String(e?.message || e)}`);
    }
  }

  fs.writeFileSync(outPath, outLines.join("\n") + "\n", "utf8");
  console.log("Conversa remontada em:", outPath);
}

function remountMedia(clientId, mediaCode) {
  const manifestPath = path.join(
    MEDIA_MANIFEST_DIR,
    safePart(clientId),
    `${safePart(mediaCode)}.json`
  );
  const encPath = path.join(
    MEDIA_DIR,
    safePart(clientId),
    `${safePart(mediaCode)}.bin`
  );

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

  const ext = manifest.ext || extFromMime(manifest.mimetype);
  const outPath = path.join(OUT_DIR, `media_${safePart(mediaCode)}.${ext}`);

  fs.writeFileSync(outPath, buf);

  console.log("Mídia remontada em:", outPath);
  console.log("Manifest:", manifestPath);
}

// CLI
const [, , cmd, a1, a2] = process.argv;

if (!cmd) {
  console.log("Uso:");
  console.log("  node decrypt_tool.js convo <clientId> <remoteNumber>");
  console.log("  node decrypt_tool.js media <clientId> <mediaCode>");
  process.exit(0);
}

if (cmd === "convo") {
  if (!a1 || !a2) {
    console.error("Faltou parâmetro. Ex: node decrypt_tool.js convo 5511999999999 5511888777666");
    process.exit(1);
  }
  remountConversation(a1, a2);
} else if (cmd === "media") {
  if (!a1 || !a2) {
    console.error("Faltou parâmetro. Ex: node decrypt_tool.js media 5511999999999 abcd1234_1700000000000");
    process.exit(1);
  }
  remountMedia(a1, a2);
} else {
  console.error("Comando inválido:", cmd);
  process.exit(1);
}
