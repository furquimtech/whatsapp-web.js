# 📱 WhatsApp Client API – Auditoria Criptografada

Este projeto fornece uma **API simples em Node.js** para conectar **múltiplos números do WhatsApp** via **WhatsApp Web**, gerar **QR Code**, acompanhar **status de conexão** e **auditar conversas 1:1** (sem grupos), armazenando todo o histórico de forma **criptografada (AES-256-GCM)**.

⚠️ **Aviso**  
Este projeto utiliza automação via WhatsApp Web (`whatsapp-web.js`), **não oficial**, indicado para **POC, auditoria interna e governança**.

b64 = "Xr9/1yu0vDPb6crDM+AAOfKStMpOLKEN43/O3+H/C4c=";

---

## 🚀 Como rodar a API

```bash
cd client-api
npm install
npm start
```

A API sobe em:
```
http://localhost:3005
```

---

## 🔐 Chave de Criptografia

Gerar chave (32 bytes base64):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Definir variável:

```bash
# PowerShell
$env:WHATSAPP_AUDIT_KEY_B64="SUA_CHAVE_BASE64"
```

---

## 🌐 Endpoints

### POST /numbers
Cadastra número e retorna QR Code

```json
{
  "id": "5511999999999",
  "name": "Empresa X - Numero 1"
}
```

### GET /numbers
Lista números cadastrados

### GET /numbers/{id}/status
Retorna status do número

### GET /numbers/{id}/qr
Retorna QR Code (base64)

---

## 🧾 Auditoria Criptografada

Estrutura gerada:

```
audit/
 ├── logs_enc/<clientId>/<remoteNumber>.log
 ├── media_enc/<clientId>/<MEDIA_CODE>.bin
 ├── media_manifest/<clientId>/<MEDIA_CODE>.json
 └── remontado/
```

---

## 🔓 Descriptografia

### Conversa
```bash
node decrypt_tool.js convo <clientId> <remoteNumber>
```

### Mídia
```bash
node decrypt_tool.js media <clientId> <MEDIA_CODE>
```

---

## 📦 Postman

Importe a collection incluída neste projeto:

`WhatsApp_Client_API.postman_collection.json`

---

## 📌 Observações

- Grupos são ignorados
- Perder a chave = perder os dados
- Cada número abre um Chromium

---

Projeto para auditoria e governança – Furquim Tech
