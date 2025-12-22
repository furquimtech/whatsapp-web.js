/**
 * POC - Auditoria WhatsApp -> log criptografado por número (somente 1:1, sem grupos)
 *
 * - Cada mensagem vira 1 linha criptografada (AES-256-GCM) em ./logs_enc/<numero>.log
 * - Se tiver mídia: gera MEDIA_CODE, salva metadados em ./media_manifest/<MEDIA_CODE>.json
 *   e salva o binário criptografado em ./media_enc/<MEDIA_CODE>.bin
 *
 * Dependências:
 *   npm i whatsapp-web.js qrcode-terminal
 *
 * Chave (obrigatório):
 *   set WHATSAPP_AUDIT_KEY_B64=<base64 de 32 bytes>
 *   (ex.: gerada pelo comando que eu deixei abaixo)
 *
 * Rodar:
 *   node index.js
 * 
 * COmando para limpeza em caso de problemas
 Remove-Item -Recurse -Force .wwebjs_auth, .wwebjs_cache -ErrorAction SilentlyContinue
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const LOG_DIR = path.join(__dirname, "logs_enc");
const MEDIA_DIR = path.join(__dirname, "media_enc");
const MEDIA_MANIFEST_DIR = path.join(__dirname, "media_manifest");

for (const dir of [LOG_DIR, MEDIA_DIR, MEDIA_MANIFEST_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ========= CRYPTO (AES-256-GCM) =========

function getKey() {
  const b64 = "N28BOuBna97kKkKP96DrIJHVdAi67WwOWVnhw10YOcE=";
  
  if (!b64) {
    throw new Error(
      "WHATSAPP_AUDIT_KEY_B64 não definido. Defina uma chave base64 de 32 bytes."
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `WHATSAPP_AUDIT_KEY_B64 inválido: precisa ter 32 bytes após base64, veio ${key.length}.`
    );
  }

  return key;

}

const KEY = getKey();

function encryptToBase64(plainText) {
  // Retorna: base64( iv(12) + tag(16) + ciphertext )
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plainText, "utf8")),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function encryptBufferToFile(buffer, outFilePath) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);

  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Arquivo: iv + tag + ciphertext (binário)
  const payload = Buffer.concat([iv, tag, ciphertext]);
  fs.writeFileSync(outFilePath, payload);
}

// ========= HELPERS =========

function nowIso() {
  return new Date().toISOString();
}

function isGroupChatId(chatId) {
  return typeof chatId === "string" && chatId.endsWith("@g.us");
}

function normalizeContactId(chatId) {
  if (!chatId) return "unknown";
  return String(chatId).replace("@c.us", "").replace("@g.us", "");
}

function safeFileName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function getLogFilePathByNumber(numberOnly) {
  return path.join(LOG_DIR, `${safeFileName(numberOnly)}.log`);
}

async function resolveContactName(client, msg) {
  try {
    const chatId = msg.fromMe ? msg.to : msg.from;
    const contact = await client.getContactById(chatId);
    return (
      contact?.pushname ||
      contact?.name ||
      contact?.shortName ||
      contact?.number ||
      ""
    );
  } catch {
    return "";
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function makeMediaCode(hashHex) {
  // Curto e único: 16 chars do hash + epochms
  return `${hashHex.slice(0, 16)}_${Date.now()}`;
}

async function appendEncryptedLine(numberOnly, obj) {
  // Um registro por linha, em JSON criptografado
  const json = JSON.stringify(obj);
  const enc = encryptToBase64(json);
  const line = enc + "\n";
  const filePath = getLogFilePathByNumber(numberOnly);
  await fs.promises.appendFile(filePath, line, { encoding: "utf8" });
  return filePath;
}

async function saveMediaEncryptedAndManifest(media, numberOnly, msgIdSerialized) {
  // media = { data: base64, mimetype, filename? }
  const bin = Buffer.from(media.data, "base64");
  const hash = sha256(bin);
  const mediaCode = makeMediaCode(hash);

  const outBinPath = path.join(MEDIA_DIR, `${mediaCode}.bin`);
  encryptBufferToFile(bin, outBinPath);

  const manifest = {
    mediaCode,
    createdAt: nowIso(),
    number: numberOnly,
    msgId: msgIdSerialized || null,
    mimetype: media.mimetype || null,
    originalFilename: media.filename || null,
    sha256: hash,
    size: bin.length,
    encryptedFile: `${mediaCode}.bin`,
    note: "Arquivo salvo criptografado (AES-256-GCM). Use decrypt_tool.js para remontar.",
  };

  const manifestPath = path.join(MEDIA_MANIFEST_DIR, `${mediaCode}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { mediaCode, manifestPath, encryptedPath: outBinPath, mimetype: manifest.mimetype, size: manifest.size };
}

// ========= WHATSAPP CLIENT =========

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "ftech-auditoria-dev" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log(`[${nowIso()}] QR_RECEIVED - escaneie no WhatsApp`);
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log(`[${nowIso()}] AUTHENTICATED`);
});

client.on("auth_failure", (msg) => {
  console.error(`[${nowIso()}] AUTH_FAILURE:`, msg);
});

client.on("ready", () => {
  console.log(`[${nowIso()}] READY - client pronto`);
});

client.on("disconnected", (reason) => {
  console.warn(`[${nowIso()}] DISCONNECTED:`, reason);
});

// INBOUND
client.on("message", async (msg) => {
  try {
    if (isGroupChatId(msg.from)) return; // não grava grupos

    const numberOnly = normalizeContactId(msg.from);
    const contactName = await resolveContactName(client, msg);

    let text = msg.body || "";
    let mediaInfo = null;

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (media) {
        const saved = await saveMediaEncryptedAndManifest(
          media,
          numberOnly,
          msg.id?._serialized
        );
        mediaInfo = {
          mediaCode: saved.mediaCode,
          mimetype: saved.mimetype,
          size: saved.size,
        };
        // no texto, não colocamos binário, só o código
        text = text
          ? `${text} [MEDIA_CODE:${saved.mediaCode}]`
          : `[MEDIA_CODE:${saved.mediaCode}]`;
      } else {
        text = text ? `${text} [MEDIA_CODE:download_failed]` : `[MEDIA_CODE:download_failed]`;
      }
    }

    const record = {
      ts: nowIso(),
      direction: "IN",
      number: numberOnly,
      name: contactName || null,
      msgId: msg.id?._serialized || null,
      type: msg.type || null,
      text,
      media: mediaInfo,
    };

    const filePath = await appendEncryptedLine(numberOnly, record);
    console.log(`[${nowIso()}] LOGGED_IN_ENC -> ${filePath}`);

    // teste rápido
    if (msg.body && msg.body.trim() === "!ping") {
      await msg.reply("pong ✅ (log criptografado ativo)");
    }
  } catch (err) {
    console.error(`[${nowIso()}] ERROR_ON_MESSAGE_IN:`, err?.message || err);
  }
});

// OUTBOUND
client.on("message_create", async (msg) => {
  try {
    if (!msg.fromMe) return;
    if (isGroupChatId(msg.to)) return; // não grava grupos

    const numberOnly = normalizeContactId(msg.to);
    const contactName = await resolveContactName(client, msg);

    let text = msg.body || "";
    let mediaInfo = null;

    if (msg.hasMedia) {
      // tentativa de baixar mídia outbound (nem sempre funciona)
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const saved = await saveMediaEncryptedAndManifest(
            media,
            numberOnly,
            msg.id?._serialized
          );
          mediaInfo = { mediaCode: saved.mediaCode, mimetype: saved.mimetype, size: saved.size };
          text = text
            ? `${text} [MEDIA_CODE:${saved.mediaCode}]`
            : `[MEDIA_CODE:${saved.mediaCode}]`;
        } else {
          text = text ? `${text} [MEDIA_CODE:outbound_no_data]` : `[MEDIA_CODE:outbound_no_data]`;
        }
      } catch {
        text = text ? `${text} [MEDIA_CODE:outbound_error]` : `[MEDIA_CODE:outbound_error]`;
      }
    }

    const record = {
      ts: nowIso(),
      direction: "OUT",
      number: numberOnly,
      name: contactName || null,
      msgId: msg.id?._serialized || null,
      type: msg.type || null,
      text,
      media: mediaInfo,
    };

    const filePath = await appendEncryptedLine(numberOnly, record);
    console.log(`[${nowIso()}] LOGGED_OUT_ENC -> ${filePath}`);
  } catch (err) {
    console.error(`[${nowIso()}] ERROR_ON_MESSAGE_OUT:`, err?.message || err);
  }
});

// shutdown
process.on("SIGINT", async () => {
  console.log(`[${nowIso()}] SHUTDOWN...`);
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
});

// start
(async () => {
  console.log(`[${nowIso()}] STARTING...`);
  await client.initialize();
})();
