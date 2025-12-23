const { attachAudit } = require("./audit");
const express = require("express");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { upsertNumber, getNumber, listNumbers } = require("./store");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3005;
const QR_WAIT_MS = Number(process.env.QR_WAIT_MS || 30000); // 30s

// Clients em memória: id -> state
// state = { client, status, lastQrDataUrl, lastQrAt, waiters: Set<fn>, startedAt }
const clients = new Map();

function normalizeId(id) {
  return String(id || "").trim().replace(/[^\dA-Za-z_-]/g, "");
}
function nowIso() {
  return new Date().toISOString();
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

function ensureClientStarted(id) {
  if (clients.has(id)) return clients.get(id);

  // Garantir que existe no store
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
      const st = clients.get(id);

      // Se já existe QR, retorna
      if (data?.lastQrDataUrl && data?.status === "qr") return resolve({ kind: "qr", data });

      // Se conectou/autenticou, retorna status (sem QR)
      if (data?.status === "connected" || data?.status === "authenticated")
        return resolve({ kind: "connected", data });

      // Se deu erro/falha
      if (
        data?.status === "auth_failure" ||
        data?.status === "error" ||
        data?.status === "qr_error"
      ) {
        return resolve({ kind: "error", data });
      }

      // Timeout
      if (Date.now() - start >= timeoutMs) return resolve({ kind: "timeout", data });

      // senão, segue aguardando
      return;
    };

    const st = clients.get(id);
    const waiter = () => tick();

    // registra waiter
    st.waiters.add(waiter);

    // primeiro check (caso já esteja pronto)
    tick();

    // timeout hard: remove waiter e resolve se não resolveu
    setTimeout(() => {
      try {
        st.waiters.delete(waiter);
      } catch {}
      tick();
    }, timeoutMs + 50);
  });
}

/**
 * POST /numbers
 * Body: { "id": "5511999999999", "name": "Empresa X - Numero 1" }
 *
 * Agora: SEMPRE tenta retornar QR no response (ou status final/timeout).
 */
app.post("/numbers", async (req, res) => {
  const id = normalizeId(req.body?.id);
  const name = req.body?.name ?? null;

  if (!id) return res.status(400).json({ error: "Informe um id (ex: 5511999999999)" });

  // cria/atualiza cadastro
  upsertNumber(id, { name });

  // sobe client (se não existir)
  ensureClientStarted(id);

  // aguarda QR ou status
  const result = await waitForQrOrStatus(id, QR_WAIT_MS);
  const data = getNumber(id);

  // Resposta única do POST já com QR (quando disponível)
  return res.json({
    ok: true,
    id,
    name: data?.name || null,
    status: data?.status || "unknown",
    lastQrAt: data?.lastQrAt || null,
    lastQrDataUrl: data?.lastQrDataUrl || null,
    waitResult: result.kind, // "qr" | "connected" | "error" | "timeout"
    waitMs: QR_WAIT_MS,
  });
});

app.get("/numbers", (req, res) => res.json(listNumbers()));

app.get("/numbers/:id/status", (req, res) => {
  const id = normalizeId(req.params.id);
  const data = getNumber(id);
  if (!data) return res.status(404).json({ error: "Número não cadastrado" });
  return res.json({
    id: data.id,
    name: data.name,
    status: data.status,
    updatedAt: data.updatedAt,
    lastQrAt: data.lastQrAt,
    lastQrDataUrl: data.lastQrDataUrl,
    lastError: data.lastError || null,
  });
});

app.listen(PORT, () => {
  console.log(`client-api on http://localhost:${PORT} (QR_WAIT_MS=${QR_WAIT_MS})`);
});
