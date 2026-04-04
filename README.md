# STELLO

A liquid staking protocol for Stellar (XLM) built on Soroban. Users stake XLM to receive sXLM, participate in validator delegation, and access lending, liquidity pools, governance, and leverage features.

---
## Live links
Deployed live link - https://stellofi.vercel.app/
Live Video Link - https://x.com/stello_fi/status/2026176292203405473?s=20
Live status - https://x.com/stello_fi
## Architecture

The project is a monorepo with three main components:

| Component | Description |
|-----------|-------------|
| **contract** | Soroban smart contracts (Rust). sXLM token, staking, lending, LP pool, and governance. |
| **backend** | Node.js API and off-chain services. Handles indexing, validators, rewards, risk, and keeper logic. |
| **frontend** | React SPA. Stake, withdraw, validators, analytics, lending, liquidity, governance, leverage, restaking. |

- **Chain:** Stellar (Soroban). Default configuration targets Stellar Testnet.
- **Data:** PostgreSQL (Prisma) for validators, metrics, withdrawals, positions, governance; Redis for event bus.
- **Wallet:** Stellar Freighter (frontend); backend uses admin keypair for contract interactions.

---

## Deployed contract addresses

| Contract | Address |
|----------|---------|
| sXLM Token | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| Staking | `CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS` |
| LP Pool | `CAW2DRMOI3CCJWKVMEUWYJUEQHXB4S4DR72HNL2DWQCMQQUH3LFFVLHV` |
| Lending | `CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG` |
| Governance | `CB7LV3FBQ7US26GVC7SM7RMX22IEEHAEUL7V3TDDWM32DHA5TDFDDEP4` |

Backend `.env`:

```
SXLM_TOKEN_CONTRACT_ID=CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA
STAKING_CONTRACT_ID=CDYXKWVDGEVA6OSIGN7GRAPPRN6AKID35OJL5ZZQIBCMECZ35KGL45PS
LP_POOL_CONTRACT_ID=CAW2DRMOI3CCJWKVMEUWYJUEQHXB4S4DR72HNL2DWQCMQQUH3LFFVLHV
LENDING_CONTRACT_ID=CAOWXZ6BWA2ZYY7GHD75OFKADKUJS4WCKPDYGGXULQWFJRB55TXAQNJG
GOVERNANCE_CONTRACT_ID=CB7LV3FBQ7US26GVC7SM7RMX22IEEHAEUL7V3TDDWM32DHA5TDFDDEP4
```

For the frontend, set the same IDs with the `VITE_` prefix (e.g. `VITE_SXLM_TOKEN_CONTRACT_ID`, `VITE_STAKING_CONTRACT_ID`, etc.).

---

## Prerequisites

- **Node.js** 20+ (backend and frontend)
- **Rust** and **Soroban CLI** (contracts; [Stellar Soroban docs](https://soroban.stellar.org/docs))
- **PostgreSQL** and **Redis** (for backend)
- **pnpm** or **npm** (package manager)

---

## Getting Started

### 1. Smart Contracts (Rust / Soroban)

From the repository root:

```bash
cd contract
cargo build
```

Workspace members:

- `sxlm-token` — sXLM liquid staking token
- `staking` — stake/unstake and delegation
- `lending` — collateralized lending
- `lp-pool` — XLM/sXLM liquidity pool
- `governance` — parameter proposals and voting

Deploy and configure contract IDs per your network (testnet/mainnet) and set the same IDs in backend and frontend environment variables.

### 2. Backend

```bash
cd backend
npm install
# Create .env with required variables (see Environment Variables below)
npx prisma generate
npx prisma migrate dev   # or db push for prototyping
npm run dev
```

Default dev server: `http://localhost:3001`.

Optional: seed database with sample validators and metrics:

```bash
npm run seed
```

### 3. Frontend

```bash
cd frontend
npm install
# Set VITE_* env vars if needed (see Environment Variables)
npm run dev
```

Default dev server: `http://localhost:5173`.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (event bus) |
| `STELLAR_RPC_URL` | Soroban RPC endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | Network passphrase (e.g. Test SDF Network) |
| `STELLAR_HORIZON_URL` | Horizon API URL |
| `SXLM_TOKEN_CONTRACT_ID` | Deployed sXLM token contract ID |
| `STAKING_CONTRACT_ID` | Deployed staking contract ID |
| `LENDING_CONTRACT_ID` | Deployed lending contract ID |
| `LP_POOL_CONTRACT_ID` | Deployed LP pool contract ID |
| `GOVERNANCE_CONTRACT_ID` | Deployed governance contract ID |
| `PORT` | API port (default `3001`) |
| `HOST` | Bind host (default `0.0.0.0`) |
| `ADMIN_SECRET_KEY` | Admin secret key for contract txs |
| `ADMIN_PUBLIC_KEY` | Admin public key |
| `JWT_SECRET` | Secret for JWT auth |
| `JWT_EXPIRES_IN` | JWT expiry (e.g. `24h`) |
| `GOVERNANCE_WEBHOOK_URL` | Optional webhook for governance events |
| `SLACK_WEBHOOK_URL` | Optional Slack webhook |

### Frontend (`frontend/.env`)

Prefix with `VITE_` so Vite exposes them to the client:

| Variable | Description |
|----------|-------------|
| `VITE_NETWORK_NAME` | e.g. `TESTNET` |
| `VITE_NETWORK_PASSPHRASE` | Stellar network passphrase |
| `VITE_HORIZON_URL` | Horizon URL |
| `VITE_SOROBAN_RPC_URL` | Soroban RPC URL |
| `VITE_SXLM_TOKEN_CONTRACT_ID` | sXLM token contract ID |
| `VITE_STAKING_CONTRACT_ID` | Staking contract ID |
| `VITE_LENDING_CONTRACT_ID` | Lending contract ID |
| `VITE_LP_POOL_CONTRACT_ID` | LP pool contract ID |
| `VITE_GOVERNANCE_CONTRACT_ID` | Governance contract ID |
| `VITE_API_URL` | Backend API base URL (e.g. `http://localhost:3001`) |

---

## Project Structure

```
xlmLR/
├── contract/                 # Soroban contracts (Rust workspace)
│   ├── sxlm-token/
│   ├── staking/
│   ├── lending/
│   ├── lp-pool/
│   └── governance/
├── backend/                  # Node.js API and services
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts
│   └── src/
│       ├── api-gateway/      # Fastify server and routes
│       ├── staking-engine/
│       ├── validator-service/
│       ├── reward-engine/
│       ├── risk-engine/
│       ├── event-listener/
│       ├── event-bus/
│       ├── user-service/
│       ├── metrics-cron/
│       ├── keeper/
│       ├── leverage-engine/
│       ├── restaking-engine/
│       └── config/
└── frontend/                 # React + Vite SPA
    └── src/
        ├── components/
        ├── pages/
        ├── hooks/
        ├── lib/
        ├── utils/
        └── config/
```

---

## Backend Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Dev | `npm run dev` | Run with tsx watch |
| Build | `npm run build` | TypeScript compile to `dist/` |
| Start | `npm start` | Run `dist/index.js` |
| DB generate | `npm run db:generate` | Prisma generate client |
| DB migrate | `npm run db:migrate` | Prisma migrate dev |
| DB push | `npm run db:push` | Prisma db push |
| DB studio | `npm run db:studio` | Prisma Studio |
| Seed | `npm run seed` | Run seed script |
| Test | `npm run test` | Vitest |
| Lint | `npm run lint` | TypeScript check |

---

## Frontend Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Dev | `npm run dev` | Vite dev server |
| Build | `npm run build` | TypeScript + Vite build |
| Preview | `npm run preview` | Preview production build |
| Lint | `npm run lint` | ESLint |

---

## Deployment

- **Backend:** `backend/nixpacks.toml` defines build and start (Prisma generate, build, migrate deploy, then `node dist/index.js`). Use with Nixpacks or adapt for your platform.
- **Frontend:** Build with `npm run build` and serve the `dist/` output with any static host; set `VITE_API_URL` to your backend URL.
- **Contracts:** Deploy each contract to your target Stellar network and record contract IDs in backend and frontend env.

---

## License

See repository license file.
