/**
 * decrypt_tool.js (v2)
 *
 * Requer:
 *   WHATSAPP_AUDIT_KEY_B64 (base64 de 32 bytes) - mesma usada para criptografar
 *
 * Uso:
 *   node decrypt_tool.js
 *
 * Comandos:
 *   node decrypt_tool.js ls
 *     -> lista clientIds existentes em audit/logs_enc
 *
 *   node decrypt_tool.js lsconvos <clientId>
 *     -> lista arquivos de conversa (convoKey) existentes para o clientId
 *
 *   node decrypt_tool.js convo <clientId> <convoKey>
 *     -> descriptografa 1 conversa (1 arquivo .log)
 *
 *   node decrypt_tool.js convo-all <clientId>
 *     -> descriptografa TODAS as conversas do clientId
 *
 *   node decrypt_tool.js lsmedia <clientId>
 *     -> lista mediaCodes (manifestos) do clientId
 *
 *   node decrypt_tool.js media <clientId> <mediaCode>
 *     -> descriptografa 1 mídia
 *
 *   node decrypt_tool.js media-all <clientId>
 *     -> descriptografa TODAS as mídias do clientId
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
  const b64 = "Xr9/1yu0vDPb6crDM+AAOfKStMpOLKEN43/O3+H/C4c="; //rocess.env.WHATSAPP_AUDIT_KEY_B64;
  if (!b64) throw new Error("WHATSAPP_AUDIT_KEY_B64 não definido.");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error(`Chave inválida: precisa ser 32 bytes (veio ${key.length}).`);
  }
  return key;
}
const KEY = getKey();

// base64( iv(12) + tag(16) + ciphertext )
function decryptFromBase64(b64) {
  const payload = Buffer.from(b64, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

// arquivo binário: iv(12) + tag(16) + ciphertext
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

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function listClientIds() {
  if (!fs.existsSync(LOG_DIR)) return [];
  const dirs = fs.readdirSync(LOG_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  return dirs;
}

function listConvoKeys(clientId) {
  const dir = path.join(LOG_DIR, safePart(clientId));
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(f => f.isFile() && f.name.toLowerCase().endsWith(".log"))
    .map(f => f.name)
    .sort();

  // converte "dm_5511.log" -> "dm_5511"
  return files.map(fn => fn.replace(/\.log$/i, ""));
}

function parseLogFileToLines(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.split(/\r?\n/).filter(Boolean);
}

function formatRecord(obj) {
  const ts = obj.ts || "-";
  const dir = obj.direction || "-";
  const type = obj.type || "-";

  const peer = obj.peerNumber ? `peer=${obj.peerNumber}` : "";
  const pname = obj.peerName ? `(${obj.peerName})` : "";

  const author = obj.authorNumber ? `author=${obj.authorNumber}` : "";
  const aname = obj.authorName ? `(${obj.authorName})` : "";

  const text = obj.text || "";
  const media = obj.media?.mediaCode ? ` MEDIA_CODE=${obj.media.mediaCode}` : "";

  return `${ts} | ${dir} | ${type} | ${peer} ${pname} ${author} ${aname} | ${text}${media}`
    .replace(/\s+/g, " ")
    .trim();
}


function remountConversation(clientId, convoKey) {
  const fp = path.join(LOG_DIR, safePart(clientId), `${safePart(convoKey)}.log`);
  if (!fs.existsSync(fp)) {
    console.error("Log não encontrado:", fp);
    return { ok: false, error: "not_found", file: fp };
  }

  const lines = parseLogFileToLines(fp);

  const outPath = path.join(
    OUT_DIR,
    `convo_${safePart(clientId)}__${safePart(convoKey)}.txt`
  );

  const outLines = [];
  let okCount = 0;
  let errCount = 0;

  for (const line of lines) {
    try {
      const json = decryptFromBase64(line);
      const obj = JSON.parse(json);
      outLines.push(formatRecord(obj));
      okCount++;
    } catch (e) {
      outLines.push(`[ERRO ao descriptografar linha] ${String(e?.message || e)}`);
      errCount++;
    }
  }

  fs.writeFileSync(outPath, outLines.join("\n") + "\n", "utf8");

  console.log(`OK: ${clientId}/${convoKey} -> ${outPath} (linhas ok=${okCount}, erro=${errCount})`);
  return { ok: true, outPath, okCount, errCount };
}

function remountConversationAll(clientId) {
  const keys = listConvoKeys(clientId);
  if (!keys.length) {
    console.log("Nenhuma conversa encontrada para:", clientId);
    return;
  }

  console.log(`Encontradas ${keys.length} conversas para clientId=${clientId}`);
  for (const key of keys) {
    remountConversation(clientId, key);
  }
}

function listMediaCodes(clientId) {
  const dir = path.join(MEDIA_MANIFEST_DIR, safePart(clientId));
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter(f => f.isFile() && f.name.toLowerCase().endsWith(".json"))
    .map(f => f.name)
    .sort();

  return files.map(fn => fn.replace(/\.json$/i, ""));
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
    return { ok: false, error: "manifest_not_found" };
  }
  if (!fs.existsSync(encPath)) {
    console.error("Binário criptografado não encontrado:", encPath);
    return { ok: false, error: "bin_not_found" };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const buf = decryptFileToBuffer(encPath);

  const ext = manifest.ext || extFromMime(manifest.mimetype);
  const outPath = path.join(OUT_DIR, `media_${safePart(mediaCode)}.${ext}`);

  fs.writeFileSync(outPath, buf);

  console.log(`OK: media ${clientId}/${mediaCode} -> ${outPath}`);
  return { ok: true, outPath };
}

function remountMediaAll(clientId) {
  const codes = listMediaCodes(clientId);
  if (!codes.length) {
    console.log("Nenhuma mídia encontrada para:", clientId);
    return;
  }

  console.log(`Encontradas ${codes.length} mídias para clientId=${clientId}`);
  for (const code of codes) {
    remountMedia(clientId, code);
  }
}

function usage() {
  console.log("Uso:");
  console.log("  node decrypt_tool.js ls");
  console.log("  node decrypt_tool.js lsconvos <clientId>");
  console.log("  node decrypt_tool.js convo <clientId> <convoKey>");
  console.log("  node decrypt_tool.js convo-all <clientId>");
  console.log("  node decrypt_tool.js lsmedia <clientId>");
  console.log("  node decrypt_tool.js media <clientId> <mediaCode>");
  console.log("  node decrypt_tool.js media-all <clientId>");
  console.log("");
  console.log("Onde encontrar os dados:");
  console.log(`  logs:   ${LOG_DIR}\\<clientId>\\<convoKey>.log`);
  console.log(`  media:  ${MEDIA_DIR}\\<clientId>\\<mediaCode>.bin`);
  console.log(`  mani:   ${MEDIA_MANIFEST_DIR}\\<clientId>\\<mediaCode>.json`);
  console.log(`  saida:  ${OUT_DIR}`);
}

// CLI
const [, , cmd, a1, a2] = process.argv;

try {
  if (!cmd) {
    usage();
    process.exit(0);
  }

  if (cmd === "ls") {
    const ids = listClientIds();
    if (!ids.length) console.log("Nenhum clientId encontrado em logs_enc.");
    else ids.forEach(x => console.log(x));
  } else if (cmd === "lsconvos") {
    if (!a1) return usage();
    const keys = listConvoKeys(a1);
    if (!keys.length) console.log("Nenhuma conversa encontrada.");
    else keys.forEach(k => console.log(k));
  } else if (cmd === "convo") {
    if (!a1 || !a2) return usage();
    remountConversation(a1, a2);
  } else if (cmd === "convo-all") {
    if (!a1) return usage();
    remountConversationAll(a1);
  } else if (cmd === "lsmedia") {
    if (!a1) return usage();
    const codes = listMediaCodes(a1);
    if (!codes.length) console.log("Nenhuma mídia encontrada.");
    else codes.forEach(c => console.log(c));
  } else if (cmd === "media") {
    if (!a1 || !a2) return usage();
    remountMedia(a1, a2);
  } else if (cmd === "media-all") {
    if (!a1) return usage();
    remountMediaAll(a1);
  } else {
    usage();
    process.exit(1);
  }
} catch (e) {
  console.error("Erro:", e?.message || e);
  process.exit(1);
}
