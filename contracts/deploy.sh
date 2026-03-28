#!/usr/bin/env bash
#
# Deploy ALL sXLM Soroban contracts to Stellar Testnet.
# Includes the new price-feed contract and updated lending initialize signature.
#
# Usage:
#   cd contracts && bash deploy.sh
#
# Prerequisites:
#   - stellar CLI installed  (stellar --version)
#   - Funded testnet account named "deployer"
#     (stellar keys generate deployer --network testnet)

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
ACCOUNT="${STELLAR_ACCOUNT:-deployer}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== sXLM Protocol — Full Contract Deployment ==="
echo "Network : $NETWORK"
echo "Account : $ACCOUNT"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Build all contracts
# ---------------------------------------------------------------------------
echo "[1/12] Building contracts..."
cd "$SCRIPT_DIR"
stellar contract build 2>&1 || cargo build --release --target wasm32v1-none

WASM_DIR="$SCRIPT_DIR/target/wasm32v1-none/release"

TOKEN_WASM="$WASM_DIR/sxlm_token.wasm"
STAKING_WASM="$WASM_DIR/sxlm_staking.wasm"
LENDING_WASM="$WASM_DIR/sxlm_lending.wasm"
LP_POOL_WASM="$WASM_DIR/sxlm_lp_pool.wasm"
GOVERNANCE_WASM="$WASM_DIR/sxlm_governance.wasm"
PRICE_FEED_WASM="$WASM_DIR/price_feed.wasm"

for wasm in "$TOKEN_WASM" "$STAKING_WASM" "$LENDING_WASM" "$LP_POOL_WASM" "$GOVERNANCE_WASM" "$PRICE_FEED_WASM"; do
  if [ ! -f "$wasm" ]; then
    echo "ERROR: WASM not found: $wasm"
    exit 1
  fi
  echo "  Found: $(basename $wasm)"
done

# ---------------------------------------------------------------------------
# Step 2: Resolve native XLM SAC address
# ---------------------------------------------------------------------------
echo ""
echo "[2/12] Resolving native XLM token (SAC) address..."
NATIVE_TOKEN_ID=$(stellar contract id asset \
  --asset native \
  --network "$NETWORK" \
  2>&1)
echo "  Native XLM Token ID: $NATIVE_TOKEN_ID"

# ---------------------------------------------------------------------------
# Step 3: Get admin public key
# ---------------------------------------------------------------------------
ADMIN_PUB_KEY=$(stellar keys address "$ACCOUNT" 2>&1)
echo "  Admin public key: $ADMIN_PUB_KEY"

# ---------------------------------------------------------------------------
# Step 4: Deploy price-feed contract  ← NEW
# ---------------------------------------------------------------------------
echo ""
echo "[3/12] Deploying Price Feed contract..."
PRICE_FEED_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$PRICE_FEED_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)
echo "  Price Feed Contract ID: $PRICE_FEED_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 5: Deploy sXLM Token contract
# ---------------------------------------------------------------------------
echo "[4/12] Deploying sXLM Token contract..."
TOKEN_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$TOKEN_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)
echo "  Token Contract ID: $TOKEN_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 6: Deploy Staking contract
# ---------------------------------------------------------------------------
echo "[5/12] Deploying Staking contract..."
STAKING_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$STAKING_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)
echo "  Staking Contract ID: $STAKING_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 7: Deploy Lending contract
# ---------------------------------------------------------------------------
echo "[6/12] Deploying Lending contract..."
LENDING_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$LENDING_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)
echo "  Lending Contract ID: $LENDING_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 8: Deploy LP Pool contract
# ---------------------------------------------------------------------------
echo "[7/12] Deploying LP Pool contract..."
LP_POOL_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$LP_POOL_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)
echo "  LP Pool Contract ID: $LP_POOL_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 9: Deploy Governance contract
# ---------------------------------------------------------------------------
echo "[8/12] Deploying Governance contract..."
GOVERNANCE_CONTRACT_ID=$(stellar contract deploy \
  --wasm "$GOVERNANCE_WASM" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  2>&1)
echo "  Governance Contract ID: $GOVERNANCE_CONTRACT_ID"

# ---------------------------------------------------------------------------
# Step 10: Initialize price-feed contract  ← NEW
# ---------------------------------------------------------------------------
echo ""
echo "[9/12] Initializing Price Feed contract..."
stellar contract invoke \
  --id "$PRICE_FEED_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY"
echo "  Price Feed initialized"

# Set initial prices (1:1 with XLM stroops, scaled by 1e7)
# sXLM price: 1.0 XLM  → 10_000_000
echo "  Setting sXLM price (1:1 with XLM)..."
stellar contract invoke \
  --id "$PRICE_FEED_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- set_price \
  --asset "$TOKEN_CONTRACT_ID" \
  --price 10000000
echo "  sXLM price set"

# ---------------------------------------------------------------------------
# Step 11: Initialize all other contracts
# ---------------------------------------------------------------------------
echo ""
echo "[10/12] Initializing sXLM Token contract..."
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

echo "[11/12] Initializing Staking contract..."
stellar contract invoke \
  --id "$STAKING_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --sxlm_token "$TOKEN_CONTRACT_ID" \
  --native_token "$NATIVE_TOKEN_ID" \
  --cooldown_period 17280
echo "  Staking initialized"

echo "[12/12] Initializing Lending contract (multi-collateral)..."
# New signature: initialize(admin, native_token, price_feed, borrow_rate_bps)
stellar contract invoke \
  --id "$LENDING_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --native_token "$NATIVE_TOKEN_ID" \
  --price_feed "$PRICE_FEED_CONTRACT_ID" \
  --borrow_rate_bps 500
echo "  Lending initialized"

# Register sXLM as a supported collateral (CF=75%, LT=85%)
echo "  Registering sXLM as collateral (CF=7500, LT=8500)..."
stellar contract invoke \
  --id "$LENDING_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- add_collateral \
  --asset "$TOKEN_CONTRACT_ID" \
  --cf_bps 7500 \
  --lt_bps 8500
echo "  sXLM collateral registered"

echo "Initializing LP Pool contract..."
stellar contract invoke \
  --id "$LP_POOL_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --sxlm_token "$TOKEN_CONTRACT_ID" \
  --native_token "$NATIVE_TOKEN_ID" \
  --fee_bps 30
echo "  LP Pool initialized"

echo "Initializing Governance contract..."
stellar contract invoke \
  --id "$GOVERNANCE_CONTRACT_ID" \
  --source "$ACCOUNT" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_PUB_KEY" \
  --sxlm_token "$TOKEN_CONTRACT_ID" \
  --voting_period_ledgers 17280 \
  --quorum_bps 1000
echo "  Governance initialized"

# ---------------------------------------------------------------------------
# Write backend/.env
# ---------------------------------------------------------------------------
BACKEND_ENV="$SCRIPT_DIR/../backend/.env"
ADMIN_SECRET=$(stellar keys show "$ACCOUNT" 2>&1 || echo "")
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || echo "change-me-in-production")

echo ""
echo "Writing backend/.env ..."
cat > "$BACKEND_ENV" <<EOF
# ===========================================
# sXLM Protocol — Environment Variables
# Generated by deploy.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ===========================================

# --- Contract IDs ---
SXLM_TOKEN_CONTRACT_ID=$TOKEN_CONTRACT_ID
STAKING_CONTRACT_ID=$STAKING_CONTRACT_ID
LENDING_CONTRACT_ID=$LENDING_CONTRACT_ID
LP_POOL_CONTRACT_ID=$LP_POOL_CONTRACT_ID
GOVERNANCE_CONTRACT_ID=$GOVERNANCE_CONTRACT_ID
PRICE_FEED_CONTRACT_ID=$PRICE_FEED_CONTRACT_ID

# --- Stellar Network ---
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# --- Backend Server ---
PORT=3001
HOST=0.0.0.0
NODE_ENV=development
NETWORK=testnet

# --- PostgreSQL ---
DATABASE_URL=postgresql://postgres:SelloFinance2003@db.vdnxctfyzwzftlpbgykv.supabase.co:5432/postgres

# --- Redis ---
REDIS_URL=redis://localhost:6379

# --- Admin Keypair ---
ADMIN_SECRET_KEY=$ADMIN_SECRET
ADMIN_PUBLIC_KEY=$ADMIN_PUB_KEY

# --- JWT ---
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=24h

# --- Optional webhooks ---
GOVERNANCE_WEBHOOK_URL=
SLACK_WEBHOOK_URL=
EOF
echo "  Written: $BACKEND_ENV"

# ---------------------------------------------------------------------------
# Write frontend/.env
# ---------------------------------------------------------------------------
FRONTEND_ENV="$SCRIPT_DIR/../frontend/.env"
echo "Writing frontend/.env ..."
cat > "$FRONTEND_ENV" <<EOF
# ===========================================
# sXLM Protocol — Frontend Environment
# Generated by deploy.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ===========================================

VITE_API_URL=http://localhost:3001
VITE_NETWORK_NAME=TESTNET
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_HORIZON_URL=https://horizon-testnet.stellar.org
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

VITE_SXLM_TOKEN_CONTRACT_ID=$TOKEN_CONTRACT_ID
VITE_STAKING_CONTRACT_ID=$STAKING_CONTRACT_ID
VITE_LENDING_CONTRACT_ID=$LENDING_CONTRACT_ID
VITE_LP_POOL_CONTRACT_ID=$LP_POOL_CONTRACT_ID
VITE_GOVERNANCE_CONTRACT_ID=$GOVERNANCE_CONTRACT_ID
VITE_PRICE_FEED_CONTRACT_ID=$PRICE_FEED_CONTRACT_ID
EOF
echo "  Written: $FRONTEND_ENV"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "  Deployment Complete!"
echo "========================================"
echo ""
echo "  PRICE_FEED_CONTRACT_ID  = $PRICE_FEED_CONTRACT_ID"
echo "  SXLM_TOKEN_CONTRACT_ID  = $TOKEN_CONTRACT_ID"
echo "  STAKING_CONTRACT_ID     = $STAKING_CONTRACT_ID"
echo "  LENDING_CONTRACT_ID     = $LENDING_CONTRACT_ID"
echo "  LP_POOL_CONTRACT_ID     = $LP_POOL_CONTRACT_ID"
echo "  GOVERNANCE_CONTRACT_ID  = $GOVERNANCE_CONTRACT_ID"
echo "  NATIVE_TOKEN_ID         = $NATIVE_TOKEN_ID"
echo ""
echo "Next steps:"
echo "  1. cd backend && npx prisma migrate deploy"
echo "  2. npm run dev"
echo "  3. cd ../frontend && npm run dev"
echo ""
echo "To add more collateral assets later:"
echo "  stellar contract invoke --id \$LENDING_CONTRACT_ID --source deployer --network testnet \\"
echo "    -- add_collateral --asset <SAC_ADDRESS> --cf_bps <CF> --lt_bps <LT>"
echo "  stellar contract invoke --id \$PRICE_FEED_CONTRACT_ID --source deployer --network testnet \\"
echo "    -- set_price --asset <SAC_ADDRESS> --price <PRICE_SCALED_BY_1E7>"
