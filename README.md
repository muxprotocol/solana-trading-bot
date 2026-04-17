# Warp Solana Bot

An automated **Solana sniping bot** that trades newly-listed tokens on **Raydium AMM v4** and **pump.fun** bonding curves. Listens to on-chain events in real time, applies configurable safety filters, buys with your chosen quote token (WSOL / USDC), and auto-sells on take-profit / stop-loss.

> ⚠️ **Disclaimer.** This software is provided **as-is** for educational purposes. Sniping memecoins is extremely risky — rug pulls, honeypots, sandwiching, and total loss are common outcomes. Use only funds you can afford to lose. You are solely responsible for every transaction this bot signs with your private key.

---

## Features

- 🦅 **Raydium AMM v4 sniper** — listens for newly-opened liquidity pools and buys within the same block window.
- 🚀 **pump.fun integration** — detects new token creations on the pump.fun bonding-curve program and buys early; sells via bonding curve until graduation.
- ⚡ **Three transaction executors** — `default` (regular RPC), `warp` (warp.id bundled relay), `jito` (Jito bundle fan-out to five block-engine regions).
- 🛡️ **Pool filters** — burn check, mint renounced, freeze authority, metadata mutability, socials, pool size range.
- 🎯 **Snipe list** — restrict buys to a whitelist of mint addresses refreshed from `snipe-list.txt`.
- 📈 **Auto-sell** — take-profit / stop-loss polling against live pool state for both Raydium and pump.fun.
- 🔒 **Concurrency guard** — `ONE_TOKEN_AT_A_TIME` mode via mutex to avoid fighting yourself across new pools.
- 🔁 **Retries** — configurable retry counts for buy and sell transactions.

---

## Architecture

```
┌────────────────┐    ┌────────────────┐    ┌────────────────┐
│   Listeners    │───▶│      Bot       │───▶│   Transaction  │
│ (WS subscrs.)  │    │  (buy / sell)  │    │    Executor    │
└────────────────┘    └────────────────┘    └────────────────┘
        │                     │                     │
        │                     │                     ├─ default RPC
        │                     │                     ├─ warp.id
        │                     │                     └─ Jito bundles
        │                     │
        │                     ├─ PoolFilters (burn / renounced / socials / size)
        │                     ├─ SnipeListCache
        │                     ├─ MarketCache / PoolCache
        │                     └─ PumpFunCache
        │
        ├─ OpenBook markets      (quoteMint memcmp)
        ├─ Raydium AmmV4 pools   (status=6, quoteMint memcmp)
        ├─ pump.fun logs         (Create instruction)
        └─ Wallet SPL changes    (token balance deltas → auto-sell)
```

Key modules:

| Path | Purpose |
|------|---------|
| `index.ts` | Entry point — wires `Connection`, `Listeners`, `Bot`, event handlers. |
| `bot.ts` | `Bot` class — Raydium `buy`/`sell` + pump.fun `buyPumpFun`/`sellPumpFun`, filter & price matching. |
| `listeners/` | WebSocket subscriptions (OpenBook, Raydium, pump.fun logs, wallet). |
| `cache/` | In-memory stores for markets, Raydium pools, pump.fun bonding curves, snipe list. |
| `filters/` | Pluggable safety filters applied before a buy. |
| `transactions/` | Pluggable executors (`default`, `warp`, `jito`). |
| `helpers/` | Env loader, logger, wallet parser, Raydium/pump.fun helpers & pricing. |

---

## Requirements

- **Node.js ≥ 18**
- A funded **Solana wallet** (keep a **dedicated** keypair for the bot — never use your main one).
- A **reliable RPC** — public `api.mainnet-beta.solana.com` will throttle; use Helius, QuickNode, Triton, Shyft, etc.
- The quote token account must already exist in your wallet (e.g. WSOL ATA). You can create a WSOL ATA by wrapping a tiny amount of SOL first.

---

## Install

```bash
git clone <this-repo>
cd solana-trading-bot-master
npm install
cp .env.copy .env
```

Edit `.env` (see [Configuration](#configuration)) and then:

```bash
npm start
```

---

## Configuration

All settings live in `.env`. Copy from `.env.copy` and edit.

### Wallet & Connection

| Var | Example | Notes |
|-----|---------|-------|
| `PRIVATE_KEY` | `base58 / [n,...] / mnemonic` | Three accepted formats. Keep secret. |
| `RPC_ENDPOINT` | `https://...` | HTTPS RPC. Use a paid provider. |
| `RPC_WEBSOCKET_ENDPOINT` | `wss://...` | WebSocket RPC. |
| `COMMITMENT_LEVEL` | `confirmed` | `processed`, `confirmed`, or `finalized`. |

### Bot

| Var | Example | Notes |
|-----|---------|-------|
| `LOG_LEVEL` | `trace` | pino log level. |
| `ONE_TOKEN_AT_A_TIME` | `true` | Mutex to process one token at a time. |
| `PRE_LOAD_EXISTING_MARKETS` | `false` | Bulk-fetch OpenBook markets at start (slow). |
| `CACHE_NEW_MARKETS` | `false` | Subscribe to OpenBook markets live. |
| `TRANSACTION_EXECUTOR` | `default` | `default` \| `warp` \| `jito`. |
| `COMPUTE_UNIT_LIMIT` | `101337` | `default` executor only. |
| `COMPUTE_UNIT_PRICE` | `421197` | micro-lamports, `default` executor only. |
| `CUSTOM_FEE` | `0.006` | SOL; for `warp` / `jito` executors. |

### Buy

| Var | Example | Notes |
|-----|---------|-------|
| `QUOTE_MINT` | `WSOL` | `WSOL` or `USDC` (Raydium side). |
| `QUOTE_AMOUNT` | `0.001` | How much quote token to spend per buy. |
| `AUTO_BUY_DELAY` | `0` | ms delay before sending buy. |
| `MAX_BUY_RETRIES` | `10` | Retry count on confirmation failure. |
| `BUY_SLIPPAGE` | `20` | Percent. |

### Sell

| Var | Example | Notes |
|-----|---------|-------|
| `AUTO_SELL` | `true` | Enable auto-sell on wallet balance changes. |
| `AUTO_SELL_DELAY` | `0` | ms delay before sending sell. |
| `MAX_SELL_RETRIES` | `10` | |
| `PRICE_CHECK_INTERVAL` | `2000` | ms between price polls. |
| `PRICE_CHECK_DURATION` | `600000` | ms total TP/SL monitoring window. |
| `TAKE_PROFIT` | `40` | Percent gain. |
| `STOP_LOSS` | `20` | Percent loss. |
| `SELL_SLIPPAGE` | `20` | Percent. |

### Filters (Raydium)

| Var | Example | Notes |
|-----|---------|-------|
| `USE_SNIPE_LIST` | `false` | When `true`, all filters are bypassed and only mints in `snipe-list.txt` are bought. |
| `SNIPE_LIST_REFRESH_INTERVAL` | `30000` | ms. |
| `FILTER_CHECK_INTERVAL` | `2000` | ms. |
| `FILTER_CHECK_DURATION` | `60000` | ms — total filter monitoring window. |
| `CONSECUTIVE_FILTER_MATCHES` | `3` | Required matches in a row before buying. |
| `CHECK_IF_MUTABLE` | `false` | Reject if token metadata is mutable. |
| `CHECK_IF_SOCIALS` | `true` | Require non-empty socials in metadata URI. |
| `CHECK_IF_MINT_IS_RENOUNCED` | `true` | Require mint authority = null. |
| `CHECK_IF_FREEZABLE` | `false` | Reject if freeze authority set. |
| `CHECK_IF_BURNED` | `true` | Require LP supply = 0 (burned). |
| `MIN_POOL_SIZE` | `5` | In quote token. |
| `MAX_POOL_SIZE` | `50` | In quote token. Set both to `0` to disable. |

### pump.fun

| Var | Example | Notes |
|-----|---------|-------|
| `ENABLE_RAYDIUM` | `true` | Master toggle for the Raydium sniper. |
| `ENABLE_PUMP_FUN` | `false` | Master toggle for pump.fun. |
| `PUMP_FUN_BUY_AMOUNT_SOL` | `0.001` | Native SOL per pump.fun buy. |
| `PUMP_FUN_MAX_CURVE_PROGRESS` | `50` | Percent; skip if bonding curve is already filled past this. |

Notes on pump.fun:

- Trades use **native SOL** through the pump.fun bonding curve (no WSOL / Raydium pool). `QUOTE_MINT` / `QUOTE_AMOUNT` do **not** apply.
- A 1% protocol fee is assumed in price calculations; `BUY_SLIPPAGE` and `SELL_SLIPPAGE` are applied on top.
- Once a pump.fun token's bonding curve graduates (`complete = true`), it migrates to Raydium. The bot stops selling via pump.fun at that point; the wallet listener will then route to the Raydium sell path if a pool is known.
- Pool filters (burn, socials, pool size, etc.) **do not** apply to pump.fun — only `PUMP_FUN_MAX_CURVE_PROGRESS` and the snipe list.

---

## Snipe list

Create / edit `snipe-list.txt` with one mint address per line. Set `USE_SNIPE_LIST=true`. Refreshes every `SNIPE_LIST_REFRESH_INTERVAL` ms.

```
# snipe-list.txt
So11111111111111111111111111111111111111112
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

Works for both Raydium and pump.fun paths.

---

## Running

```bash
npm start        # ts-node index.ts
npm run tsc      # type-check only
```

Stop with `Ctrl+C`. Logs print to stdout via pino-pretty.

---

## Transaction executors

### `default`
Standard `sendRawTransaction` + confirmation. You pay priority via `COMPUTE_UNIT_PRICE` × `COMPUTE_UNIT_LIMIT` micro-lamports.

### `warp`
Bundled through `https://tx.warp.id/transaction/execute`. A tip of `CUSTOM_FEE` SOL is sent to the warp fee wallet in a leading transfer.

### `jito`
Sends a Jito bundle to all 5 block-engine regions (mainnet, amsterdam, frankfurt, ny, tokyo). Tip of `CUSTOM_FEE` SOL is sent to a randomly-chosen Jito tip account. Compute-budget instructions are skipped since Jito priority is set via the tip.

---

## Safety checklist

- [ ] Use a **dedicated wallet** funded only with what you're willing to lose.
- [ ] Keep `.env` out of version control (`.gitignore` already excludes it).
- [ ] Start with tiny amounts (`QUOTE_AMOUNT=0.001`, `PUMP_FUN_BUY_AMOUNT_SOL=0.001`).
- [ ] Use a paid RPC; free endpoints will miss fills.
- [ ] Test `ENABLE_RAYDIUM=false ENABLE_PUMP_FUN=true` or vice versa in isolation first.
- [ ] Monitor logs actively — `LOG_LEVEL=trace` is verbose but informative.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `PRIVATE_KEY is not set` | `.env` missing / path wrong. |
| `... token account not found in wallet` | You haven't created a WSOL (or USDC) ATA yet. Wrap a tiny amount of SOL first. |
| No pools detected | RPC too slow / filters too strict / wrong `COMMITMENT_LEVEL`. |
| Buys never confirm | Priority fee too low or RPC drops txs; try `warp` / `jito` executor. |
| `Curve progress too high` | Increase `PUMP_FUN_MAX_CURVE_PROGRESS` or loosen. |
| `Bonding curve complete` | Token already graduated to Raydium; pump.fun path can't trade it. |

---

## Project layout

```
.
├── bot.ts                       Core Bot (buy/sell for both DEXes)
├── index.ts                     Entry point & event wiring
├── cache/
│   ├── market.cache.ts
│   ├── pool.cache.ts
│   ├── pumpfun.cache.ts         pump.fun bonding curve state cache
│   └── snipe-list.cache.ts
├── filters/                     PoolFilters + individual filters
├── helpers/
│   ├── constants.ts             Env var parsing
│   ├── liquidity.ts             createPoolKeys for Raydium
│   ├── logger.ts
│   ├── market.ts                MinimalMarketLayoutV3
│   ├── pumpfun.ts               pump.fun program + layout + ix builders + pricing
│   ├── promises.ts
│   ├── token.ts                 WSOL / USDC
│   └── wallet.ts
├── listeners/listeners.ts       WebSocket subscriptions
├── transactions/
│   ├── default-transaction-executor.ts
│   ├── warp-transaction-executor.ts
│   └── jito-rpc-transaction-executor.ts
├── .env.copy                    Template
├── snipe-list.txt               Whitelist (optional)
└── tsconfig.json
```

---

## License

MIT — see `LICENSE.md`.

## Credits

- Original Raydium sniper by Filip Dundjer / warp.id.
- pump.fun integration layered on top.
- Built on `@solana/web3.js`, `@solana/spl-token`, `@raydium-io/raydium-sdk`, `@metaplex-foundation/mpl-token-metadata`.
