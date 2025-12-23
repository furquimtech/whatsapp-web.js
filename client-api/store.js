const fs = require("fs");
const path = require("path");

const FILE_PATH = path.join(__dirname, "numbers.json");

function loadStore() {
  try {
    if (!fs.existsSync(FILE_PATH)) return { numbers: {} };
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return { numbers: {} };
    if (!data.numbers || typeof data.numbers !== "object") data.numbers = {};
    return data;
  } catch {
    return { numbers: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function upsertNumber(id, patch) {
  const store = loadStore();
  const curr = store.numbers[id] || {
    id,
    name: null,
    status: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastQrAt: null,
    lastQrDataUrl: null,
    lastError: null
  };

  const updated = {
    ...curr,
    ...patch,
    id,
    updatedAt: new Date().toISOString()
  };

  store.numbers[id] = updated;
  saveStore(store);
  return updated;
}

function getNumber(id) {
  const store = loadStore();
  return store.numbers[id] || null;
}

function listNumbers() {
  const store = loadStore();
  return Object.values(store.numbers);
}

function deleteNumber(id) {
  const store = loadStore();
  const existed = !!store.numbers[id];
  if (existed) {
    delete store.numbers[id];
    saveStore(store);
  }
  return existed;
}

function clearNumbers() {
  const store = { numbers: {} };
  saveStore(store);
}

module.exports = {
  loadStore,
  saveStore,
  upsertNumber,
  getNumber,
  listNumbers,
  deleteNumber,
  clearNumbers
};
