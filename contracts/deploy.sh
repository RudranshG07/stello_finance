#!/usr/bin/env bash
#
# Deploy sXLM Soroban contracts to Stellar Testnet.
#
# Usage:
#   cd contracts && bash deploy.sh
#
# Prerequisites:
#   - stellar CLI installed
#   - Funded testnet account (stellar keys generate deployer --network testnet)

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
ACCOUNT="${STELLAR_ACCOUNT:-deployer}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== sXLM Protocol — Contract Deployment ==="
echo "Network: $NETWORK"
echo "Account: $ACCOUNT"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Build all contracts (workspace build from root)
# ---------------------------------------------------------------------------
echo "[1/10] Building contracts..."
cd "$SCRIPT_DIR"
stellar contract build 2>&1 || cargo build --release --target wasm32v1-none

TOKEN_WASM="$SCRIPT_DIR/target/wasm32v1-none/release/sxlm_token.wasm"
STAKING_WASM="$SCRIPT_DIR/target/wasm32v1-none/release/sxlm_staking.wasm"
LENDING_WASM="$SCRIPT_DIR/target/wasm32v1-none/release/sxlm_lending.wasm"
LP_POOL_WASM="$SCRIPT_DIR/target/wasm32v1-none/release/sxlm_lp_pool.wasm"
GOVERNANCE_WASM="$SCRIPT_DIR/target/wasm32v1-none/release/sxlm_governance.wasm"

for wasm in "$TOKEN_WASM" "$STAKING_WASM" "$LENDING_WASM" "$LP_POOL_WASM" "$GOVERNANCE_WASM"; do
  if [ ! -f "$wasm" ]; then
    echo "ERROR: WASM not found at $wasm"
    exit 1
  fi
  echo "  Found: $wasm"
done

# ---------------------------------------------------------------------------
# Step 2: Deploy sXLM Token contract
# ---------------------------------------------------------------------------
echo ""
echo "[2/10] Deploying sXLM Token contract..."
TOKEN_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$TOKEN_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)

echo "  Token Contract ID: $TOKEN_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 3: Deploy Staking contract
# ---------------------------------------------------------------------------
echo "[3/10] Deploying Staking contract..."
STAKING_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$STAKING_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)

echo "  Staking Contract ID: $STAKING_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 4: Deploy Lending contract
# ---------------------------------------------------------------------------
echo "[4/10] Deploying Lending contract..."
LENDING_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$LENDING_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)

echo "  Lending Contract ID: $LENDING_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 5: Deploy LP Pool contract
# ---------------------------------------------------------------------------
echo "[5/10] Deploying LP Pool contract..."
LP_POOL_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$LP_POOL_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)

echo "  LP Pool Contract ID: $LP_POOL_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 6: Deploy Governance contract
# ---------------------------------------------------------------------------
echo "[6/10] Deploying Governance contract..."
GOVERNANCE_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$GOVERNANCE_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)

echo "  Governance Contract ID: $GOVERNANCE_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 7: Get the native XLM SAC address
# ---------------------------------------------------------------------------
echo "[7/10] Resolving native XLM token (SAC) address..."
NATIVE_TOKEN_ID=$(stellar contract id asset \
  --asset native \
  --network "$NETWORK" \
  2>&1)

echo "  Native XLM Token ID: $NATIVE_TOKEN_ID"

# ---------------------------------------------------------------------------
# Step 8: Get admin public key
# ---------------------------------------------------------------------------
ADMIN_PUB_KEY=$(stellar keys address "$ACCOUNT" 2>&1 || echo "")

if [ -z "$ADMIN_PUB_KEY" ]; then
  echo "WARNING: Could not resolve admin public key."
  ADMIN_PUB_KEY="<YOUR_ADMIN_PUBLIC_KEY>"
fi

echo "  Admin public key: $ADMIN_PUB_KEY"

# ---------------------------------------------------------------------------
# Step 9: Initialize contracts
# ---------------------------------------------------------------------------
echo ""
echo "[8/10] Initializing sXLM Token contract..."
stellar contract invoke \
  --id "$TOKEN_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --minter "$STAKING_CONTRACT_ID" \
  --decimals 7 \
  --name "Staked XLM" \
  --symbol "sXLM"

echo "  Token initialized (minter = staking contract)"

echo "[9/10] Initializing Staking contract..."
stellar contract invoke \
  --id "$STAKING_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --sxlm_token "$TOKEN_CONTRACT_ID" \
  --native_token "$NATIVE_TOKEN_ID" \
  --cooldown_period 17280

echo "  Staking contract initialized"

echo "[10/10] Initializing Milestone 5 contracts..."

# Lending: CF=7000bps (70%), Liq=8000bps (80%), BorrowRate=500bps (5%)
stellar contract invoke \
  --id "$LENDING_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --sxlm_token "$TOKEN_CONTRACT_ID" \
  --native_token "$NATIVE_TOKEN_ID" \
  --collateral_factor_bps 7000 \
  --liquidation_threshold_bps 8000 \
  --borrow_rate_bps 500

echo "  Lending contract initialized"

# LP Pool: fee=30bps (0.3%)
stellar contract invoke \
  --id "$LP_POOL_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --sxlm_token "$TOKEN_CONTRACT_ID" \
  --native_token "$NATIVE_TOKEN_ID" \
  --fee_bps 30

echo "  LP Pool contract initialized"

# Governance: voting_period=17280 ledgers (~24h), quorum=1000bps (10%)
stellar contract invoke \
  --id "$GOVERNANCE_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --sxlm_token "$TOKEN_CONTRACT_ID" \
  --voting_period_ledgers 17280 \
  --quorum_bps 1000

echo "  Governance contract initialized"

# ---------------------------------------------------------------------------
# Write .env file
# ---------------------------------------------------------------------------
ENV_FILE="$SCRIPT_DIR/../.env"
ADMIN_SECRET=$(stellar keys show "$ACCOUNT" 2>&1 || echo "")

cat > "$ENV_FILE" <<EOF
# ===========================================
# sXLM Protocol — Environment Variables
# Generated by deploy.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ===========================================

# --- Stellar Network ---
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# --- Contract IDs ---
SXLM_TOKEN_CONTRACT_ID=$TOKEN_CONTRACT_ID
STAKING_CONTRACT_ID=$STAKING_CONTRACT_ID
LENDING_CONTRACT_ID=$LENDING_CONTRACT_ID
LP_POOL_CONTRACT_ID=$LP_POOL_CONTRACT_ID
GOVERNANCE_CONTRACT_ID=$GOVERNANCE_CONTRACT_ID

# --- Backend Server ---
PORT=3001
HOST=0.0.0.0
NODE_ENV=development

# --- PostgreSQL ---
DATABASE_URL=postgresql://sxlm:sxlm_password@localhost:5432/sxlm_protocol

# --- Redis ---
REDIS_URL=redis://localhost:6379

# --- Admin Keypair ---
ADMIN_SECRET_KEY=$ADMIN_SECRET
ADMIN_PUBLIC_KEY=$ADMIN_PUB_KEY

# --- JWT ---
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES_IN=24h

# --- Frontend (Vite) ---
VITE_API_URL=http://localhost:3001
VITE_SXLM_TOKEN_CONTRACT_ID=$TOKEN_CONTRACT_ID
VITE_STAKING_CONTRACT_ID=$STAKING_CONTRACT_ID
VITE_LENDING_CONTRACT_ID=$LENDING_CONTRACT_ID
VITE_LP_POOL_CONTRACT_ID=$LP_POOL_CONTRACT_ID
VITE_GOVERNANCE_CONTRACT_ID=$GOVERNANCE_CONTRACT_ID
VITE_NETWORK_NAME=TESTNET
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_HORIZON_URL=https://horizon-testnet.stellar.org
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
EOF

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Contract IDs:"
echo "  SXLM_TOKEN_CONTRACT_ID=$TOKEN_CONTRACT_ID"
echo "  STAKING_CONTRACT_ID=$STAKING_CONTRACT_ID"
echo "  LENDING_CONTRACT_ID=$LENDING_CONTRACT_ID"
echo "  LP_POOL_CONTRACT_ID=$LP_POOL_CONTRACT_ID"
echo "  GOVERNANCE_CONTRACT_ID=$GOVERNANCE_CONTRACT_ID"
echo "  NATIVE_TOKEN_ID=$NATIVE_TOKEN_ID"
echo ""
echo ".env written to $ENV_FILE"
echo ""
echo "Next steps:"
echo "  1. cd backend && docker-compose up -d"
echo "  2. npx prisma migrate dev --name milestone5"
echo "  3. npm run dev"
echo "  4. cd frontend && npm run dev"
