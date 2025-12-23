const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Base folder: client-api/audit/...
const BASE_DIR = path.join(__dirname, "audit");
const LOG_DIR = path.join(BASE_DIR, "logs_enc");
const MEDIA_DIR = path.join(BASE_DIR, "media_enc");
const MEDIA_MANIFEST_DIR = path.join(BASE_DIR, "media_manifest");

for (const dir of [BASE_DIR, LOG_DIR, MEDIA_DIR, MEDIA_MANIFEST_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function safePart(v) {
  return String(v || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function isGroupChatId(chatId) {
  return typeof chatId === "string" && chatId.endsWith("@g.us");
}

function normalizeContactId(chatId) {
  if (!chatId) return "unknown";
  return String(chatId).replace("@c.us", "").replace("@g.us", "");
}

function getKey() {
  const b64 = "Xr9/1yu0vDPb6crDM+AAOfKStMpOLKEN43/O3+H/C4c="; //process.env.WHATSAPP_AUDIT_KEY_B64;
  
  if (!b64) {
    throw new Error(
      "WHATSAPP_AUDIT_KEY_B64 não definido. Defina base64 de 32 bytes."
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `WHATSAPP_AUDIT_KEY_B64 inválido: precisa ser 32 bytes (veio ${key.length}).`
    );
  }
  return key;
}

const KEY = getKey();

function encryptToBase64(plainText) {
  // base64( iv(12) + tag(16) + ciphertext )
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

  // binário: iv + tag + ciphertext
  fs.writeFileSync(outFilePath, Buffer.concat([iv, tag, ciphertext]));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function makeMediaCode(hashHex) {
  return `${hashHex.slice(0, 16)}_${Date.now()}`;
}

function extFromMime(mime) {
  if (!mime) return "bin";
  const parts = mime.split("/");
  return (parts[1] || "bin").split(";")[0];
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function getLogFilePath(clientId, remoteNumber) {
  // audit/logs_enc/<clientId>/<remoteNumber>.log
  const dir = path.join(LOG_DIR, safePart(clientId));
  ensureDir(dir);
  return path.join(dir, `${safePart(remoteNumber)}.log`);
}

async function appendEncryptedLine(clientId, remoteNumber, recordObj) {
  const json = JSON.stringify(recordObj);
  const enc = encryptToBase64(json);
  const line = enc + "\n";
  const fp = getLogFilePath(clientId, remoteNumber);
  await fs.promises.appendFile(fp, line, { encoding: "utf8" });
  return fp;
}

async function saveMediaEncryptedAndManifest(clientId, remoteNumber, media, msgIdSerialized) {
  const bin = Buffer.from(media.data, "base64");
  const hash = sha256(bin);
  const mediaCode = makeMediaCode(hash);

  // audit/media_enc/<clientId>/<mediaCode>.bin
  const mediaDir = path.join(MEDIA_DIR, safePart(clientId));
  ensureDir(mediaDir);
  const encPath = path.join(mediaDir, `${mediaCode}.bin`);
  encryptBufferToFile(bin, encPath);

  // audit/media_manifest/<clientId>/<mediaCode>.json
  const maniDir = path.join(MEDIA_MANIFEST_DIR, safePart(clientId));
  ensureDir(maniDir);
  const manifestPath = path.join(maniDir, `${mediaCode}.json`);

  const manifest = {
    mediaCode,
    createdAt: nowIso(),
    clientId,
    remoteNumber,
    msgId: msgIdSerialized || null,
    mimetype: media.mimetype || null,
    ext: extFromMime(media.mimetype),
    originalFilename: media.filename || null,
    sha256: hash,
    size: bin.length,
    encryptedFile: `${mediaCode}.bin`,
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { mediaCode, mimetype: manifest.mimetype, size: manifest.size };
}

async function resolveContactName(client, chatId) {
  try {
    const c = await client.getContactById(chatId);
    return c?.pushname || c?.name || c?.shortName || c?.number || "";
  } catch {
    return "";
  }
}

/**
 * Pluga auditoria no client do WhatsApp.
 * clientId = id do número conectado (LocalAuth clientId)
 */
function attachAudit(client, clientId) {
  // IN
  client.on("message", async (msg) => {
    try {
      if (isGroupChatId(msg.from)) return;

      const remoteChatId = msg.from;
      const remoteNumber = normalizeContactId(remoteChatId);
      const name = await resolveContactName(client, remoteChatId);

      let text = msg.body || "";
      let mediaInfo = null;

      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media) {
          const saved = await saveMediaEncryptedAndManifest(
            clientId,
            remoteNumber,
            media,
            msg.id?._serialized
          );
          mediaInfo = saved;
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
        clientId,
        remoteNumber,
        remoteName: name || null,
        msgId: msg.id?._serialized || null,
        type: msg.type || null,
        text,
        media: mediaInfo,
      };

      await appendEncryptedLine(clientId, remoteNumber, record);
    } catch (e) {
      console.error(`[audit] IN error (${clientId}):`, e?.message || e);
    }
  });

  // OUT (mensagens enviadas pela sessão)
  client.on("message_create", async (msg) => {
    try {
      if (!msg.fromMe) return;
      if (isGroupChatId(msg.to)) return;

      const remoteChatId = msg.to;
      const remoteNumber = normalizeContactId(remoteChatId);
      const name = await resolveContactName(client, remoteChatId);

      let text = msg.body || "";
      let mediaInfo = null;

      if (msg.hasMedia) {
        // nem sempre download outbound funciona, mas tentamos
        try {
          const media = await msg.downloadMedia();
          if (media) {
            const saved = await saveMediaEncryptedAndManifest(
              clientId,
              remoteNumber,
              media,
              msg.id?._serialized
            );
            mediaInfo = saved;
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
        clientId,
        remoteNumber,
        remoteName: name || null,
        msgId: msg.id?._serialized || null,
        type: msg.type || null,
        text,
        media: mediaInfo,
      };

      await appendEncryptedLine(clientId, remoteNumber, record);
    } catch (e) {
      console.error(`[audit] OUT error (${clientId}):`, e?.message || e);
    }
  });
}

module.exports = {
  attachAudit,
};
