# Any2API 2.0

An account-authorized browser gateway with an OpenAI-compatible API and an operations console.

## Development

```bash
npm install
cp .env.example .env
npm run dev
npm run dev:admin
```

The API listens on `http://127.0.0.1:8787`; the admin UI runs on `http://localhost:5173`.

Set `ANY2API_ENCRYPTION_KEY` to a 32-byte base64url value before creating provider accounts. The development bootstrap owner is created only when `ANY2API_OWNER_PASSWORD` is set.
