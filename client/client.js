/**
 * client/client.js (SEM ENV)
 *
 * - Conecta 1 telefone (QR no terminal)
 * - Gera logs criptografados (DM + grupos) usando audit.js
 *
 * Dependências:
 *   npm i whatsapp-web.js qrcode-terminal
 */

const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

// ✅ Reusa o audit.js da API (ele vai ler WHATSAPP_AUDIT_KEY_B64)
// Como você quer SEM ENV, vamos setar process.env aqui antes de importar audit.js.
const CONFIG = {
  // Identificador da sessão (pode ser o número, ou um nome)
  CLIENT_ID: "k",

  // Headless true = sem abrir janela do Chrome (recomendado)
  PUPPETEER_HEADLESS: true,

  // Capturar grupos (true/false)
  CAPTURE_GROUPS: true,

  // ⚠️ CHAVE (base64 de 32 bytes) — NÃO VERSIONAR ISSO NO GIT
  // Gere com:
  // node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  WHATSAPP_AUDIT_KEY_B64: "Xr9/1yu0vDPb6crDM+AAOfKStMpOLKEN43/O3+H/C4c="
};

// ---- Força configs no process.env para o audit.js (sem precisar setar no terminal)
process.env.WHATSAPP_AUDIT_KEY_B64 = CONFIG.WHATSAPP_AUDIT_KEY_B64;
process.env.CAPTURE_GROUPS = String(CONFIG.CAPTURE_GROUPS);

// Agora sim importa o audit.js
const { attachAudit } = require(path.join(__dirname, "..", "client-api", "audit"));

function nowIso() {
  return new Date().toISOString();
}

console.log(
  `[${nowIso()}] START client standalone (CLIENT_ID=${CONFIG.CLIENT_ID}, HEADLESS=${CONFIG.PUPPETEER_HEADLESS}, CAPTURE_GROUPS=${CONFIG.CAPTURE_GROUPS})`
);

// LocalAuth vai criar a sessão aqui dentro de /client
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: CONFIG.CLIENT_ID,
    dataPath: path.join(__dirname), // força .wwebjs_auth e .wwebjs_cache dentro /client
  }),
  puppeteer: {
    headless: CONFIG.PUPPETEER_HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  },
  restartOnAuthFail: true,
});

// ✅ Plug auditoria (gera logs em ../client-api/audit/...)
attachAudit(client, CONFIG.CLIENT_ID);

client.on("qr", (qr) => {
  console.log(`[${nowIso()}] QR RECEBIDO - escaneie com o WhatsApp`);
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log(`[${nowIso()}] authenticated`);
});

client.on("ready", () => {
  console.clear();
  console.log(`[${nowIso()}] connected/ready`);
});

client.on("auth_failure", (msg) => {
  console.log(`[${nowIso()}] auth_failure: ${msg}`);
});

client.on("disconnected", (reason) => {
  console.log(`[${nowIso()}] disconnected: ${reason}`);
  console.log(`[${nowIso()}] Para forçar novo QR, apague: .\\client\\.wwebjs_auth e .\\client\\.wwebjs_cache`);
});

client.initialize().catch((err) => {
  console.error(`[${nowIso()}] initialize error:`, err?.message || err);
});
