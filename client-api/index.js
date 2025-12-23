/**
 * client-api/index.js
 * Ajuste: NÃO retornar lastQrDataUrl em:
 * - GET /numbers
 * - GET /numbers/:id/status
 *
 * QR fica somente em:
 * - POST /numbers (quando waitResult=qr)
 * - GET /numbers/:id/qr
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const {
  upsertNumber,
  getNumber,
  listNumbers,
  deleteNumber,
  clearNumbers,
} = require("./store");

const { attachAudit } = require("./audit");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3005;
const QR_WAIT_MS = Number(process.env.QR_WAIT_MS || 30000); // 30s

// Clients em memória: id -> state
const clients = new Map();

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(id) {
  return String(id || "").trim().replace(/[^\dA-Za-z_-]/g, "");
}

function setStatus(id, status, extra = {}) {
  upsertNumber(id, { status, ...extra });
}

function notifyWaiters(id) {
  const st = clients.get(id);
  if (!st || !st.waiters) return;
  for (const fn of st.waiters) {
    try {
      fn();
    } catch {}
  }
}

// -------------------------
// Sessão / limpeza
// -------------------------
function removeDirSafe(dirPath) {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function removeSessionFiles(clientId) {
  const authDir = path.join(__dirname, ".wwebjs_auth", `session-${clientId}`);
  const cacheDir = path.join(__dirname, ".wwebjs_cache", `session-${clientId}`);
  const removedAuth = removeDirSafe(authDir);
  const removedCache = removeDirSafe(cacheDir);
  return { authDir, cacheDir, removedAuth, removedCache };
}

async function disconnectClient(clientId) {
  const st = clients.get(clientId);
  if (!st) return { existedInMemory: false };

  try {
    await st.client.destroy();
  } catch {}

  clients.delete(clientId);
  return { existedInMemory: true };
}

// -------------------------
// Client Manager
// -------------------------
function ensureClientStarted(id) {
  if (clients.has(id)) return clients.get(id);

  // garante que exista no store
  const existing = getNumber(id);
  if (!existing) upsertNumber(id, { status: "initializing" });
  else setStatus(id, existing.status || "initializing");

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
    restartOnAuthFail: true,
  });

  // Auditoria criptografada (sem grupos)
  attachAudit(client, id);

  const st = {
    client,
    status: "initializing",
    lastQrDataUrl: null,
    lastQrAt: null,
    startedAt: nowIso(),
    waiters: new Set(),
  };

  clients.set(id, st);

  client.on("qr", async (qr) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
      st.status = "qr";
      st.lastQrDataUrl = dataUrl;
      st.lastQrAt = nowIso();

      setStatus(id, "qr", {
        lastQrAt: st.lastQrAt,
        lastQrDataUrl: dataUrl,
      });

      console.log(`[${nowIso()}] [${id}] QR gerado`);
      notifyWaiters(id);
    } catch (e) {
      console.error(`[${nowIso()}] [${id}] Erro ao gerar QR:`, e?.message || e);
      st.status = "qr_error";
      setStatus(id, "qr_error", { lastError: String(e?.message || e) });
      notifyWaiters(id);
    }
  });

  client.on("authenticated", () => {
    st.status = "authenticated";
    setStatus(id, "authenticated");
    console.log(`[${nowIso()}] [${id}] authenticated`);
    notifyWaiters(id);
  });

  client.on("ready", () => {
    st.status = "connected";
    setStatus(id, "connected");
    console.log(`[${nowIso()}] [${id}] connected`);
    notifyWaiters(id);
  });

  client.on("auth_failure", (msg) => {
    st.status = "auth_failure";
    setStatus(id, "auth_failure", { lastError: String(msg || "") });
    console.log(`[${nowIso()}] [${id}] auth_failure: ${msg}`);
    notifyWaiters(id);
  });

  client.on("disconnected", (reason) => {
    st.status = "disconnected";
    setStatus(id, "disconnected", { lastError: String(reason || "") });
    console.log(`[${nowIso()}] [${id}] disconnected: ${reason}`);
    notifyWaiters(id);
  });

  client.initialize().catch((err) => {
    console.error(`[${nowIso()}] [${id}] initialize error:`, err?.message || err);
    st.status = "error";
    setStatus(id, "error", { lastError: String(err?.message || err) });
    notifyWaiters(id);
  });

  return st;
}

function waitForQrOrStatus(id, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();

    const tick = () => {
      const data = getNumber(id);

      if (data?.lastQrDataUrl && data?.status === "qr") return resolve({ kind: "qr" });
      if (data?.status === "connected" || data?.status === "authenticated") return resolve({ kind: "connected" });
      if (data?.status === "auth_failure" || data?.status === "error" || data?.status === "qr_error") return resolve({ kind: "error" });
      if (Date.now() - start >= timeoutMs) return resolve({ kind: "timeout" });

      return;
    };

    const st = clients.get(id);
    const waiter = () => tick();

    st.waiters.add(waiter);
    tick();

    setTimeout(() => {
      try { st.waiters.delete(waiter); } catch {}
      tick();
    }, timeoutMs + 50);
  });
}

// -------------------------
// Routes
// -------------------------

/**
 * POST /numbers
 * Retorna QR na mesma chamada (ou connected/error/timeout)
 */
app.post("/numbers", async (req, res) => {
  const id = normalizeId(req.body?.id);
  const name = req.body?.name ?? null;

  if (!id) return res.status(400).json({ error: "Informe um id (ex: 5511999999999)" });

  upsertNumber(id, { name });
  ensureClientStarted(id);

  const result = await waitForQrOrStatus(id, QR_WAIT_MS);
  const data = getNumber(id);

  // ✅ Mantém QR aqui (somente no cadastro)
  return res.json({
    ok: true,
    id,
    name: data?.name || null,
    status: data?.status || "unknown",
    lastQrAt: data?.lastQrAt || null,
    lastQrDataUrl: data?.lastQrDataUrl || null,
    lastError: data?.lastError || null,
    waitResult: result.kind,
    waitMs: QR_WAIT_MS,
  });
});

/**
 * GET /numbers
 * ✅ NÃO retorna lastQrDataUrl
 */
app.get("/numbers", (req, res) => {
  const items = listNumbers().map((n) => ({
    id: n.id,
    name: n.name,
    status: n.status,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    lastQrAt: n.lastQrAt || null,
    lastError: n.lastError || null,
  }));
  res.json(items);
});

/**
 * GET /numbers/:id/status
 * ✅ NÃO retorna lastQrDataUrl
 */
app.get("/numbers/:id/status", (req, res) => {
  const id = normalizeId(req.params.id);
  const data = getNumber(id);
  if (!data) return res.status(404).json({ error: "Número não cadastrado" });

  return res.json({
    id: data.id,
    name: data.name,
    status: data.status,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    lastQrAt: data.lastQrAt || null,
    lastError: data.lastError || null,
  });
});

/**
 * GET /numbers/:id/qr
 * Endpoint dedicado ao QR
 */
app.get("/numbers/:id/qr", (req, res) => {
  const id = normalizeId(req.params.id);
  const data = getNumber(id);
  if (!data) return res.status(404).json({ error: "Número não cadastrado" });

  if (!data.lastQrDataUrl) {
    return res.status(404).json({ error: "QR ainda não disponível", status: data.status });
  }

  return res.json({
    id,
    status: data.status,
    lastQrAt: data.lastQrAt,
    lastQrDataUrl: data.lastQrDataUrl,
  });
});

/**
 * DELETE /numbers/:id
 */
app.delete("/numbers/:id", async (req, res) => {
  const id = normalizeId(req.params.id);
  if (!id) return res.status(400).json({ error: "id inválido" });

  const mem = await disconnectClient(id);
  const session = removeSessionFiles(id);
  const removedFromStore = deleteNumber(id);

  return res.json({
    ok: true,
    id,
    disconnected: mem.existedInMemory,
    removedFromStore,
    session,
  });
});

/**
 * POST /numbers/clear
 */
app.post("/numbers/clear", async (req, res) => {
  const all = listNumbers();
  const results = [];

  for (const n of all) {
    const id = normalizeId(n.id);
    const mem = await disconnectClient(id);
    const session = removeSessionFiles(id);
    results.push({ id, disconnected: mem.existedInMemory, session });
  }

  clearNumbers();

  return res.json({
    ok: true,
    cleared: results.length,
    results,
  });
});

// -------------------------
app.listen(PORT, () => {
  console.log(`client-api on http://localhost:${PORT} (QR_WAIT_MS=${QR_WAIT_MS})`);
});
