import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, PumpFunCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import {
  computeSolOutForTokens,
  computeTokensOutForSol,
  createPoolKeys,
  createPumpFunBuyInstruction,
  createPumpFunSellInstruction,
  decodeBondingCurve,
  getAssociatedBondingCurve,
  getBondingCurvePDA,
  logger,
  NETWORK,
  sleep,
} from './helpers';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
  pumpFunBuyAmountSol?: number;
  pumpFunMaxCurveProgress?: number;
}

export class Bot {
  private readonly poolFilters: PoolFilters;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
    private readonly pumpFunStorage: PumpFunCache = new PumpFunCache(),
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint: poolState.baseMint.toString() }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: poolState.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: poolState.baseMint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            break;
          }

          logger.info(
            {
              mint: poolState.baseMint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: poolState.baseMint.toString(), error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: poolState.baseMint.toString(), error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      await this.priceMatch(tokenAmountIn, poolKeys);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  public isPumpFunMint(mint: string): boolean {
    return !!this.pumpFunStorage.get(mint);
  }

  public async buyPumpFun(mint: PublicKey) {
    const mintStr = mint.toString();
    logger.trace({ mint: mintStr }, `Processing new pump.fun token...`);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(mintStr)) {
      logger.debug({ mint: mintStr }, `Skipping pump.fun buy (not on snipe list)`);
      return;
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug({ mint: mintStr }, `Skipping pump.fun buy (one-at-a-time busy)`);
        return;
      }
      await this.mutex.acquire();
    }

    try {
      const bondingCurve = getBondingCurvePDA(mint);
      const associatedBondingCurve = getAssociatedBondingCurve(bondingCurve, mint);
      const associatedUser = getAssociatedTokenAddress(mint, this.config.wallet.publicKey);

      const info = await this.connection.getAccountInfo(bondingCurve, this.connection.commitment);
      if (!info?.data) {
        logger.debug({ mint: mintStr }, `Bonding curve not found`);
        return;
      }
      const curve = decodeBondingCurve(info.data);
      if (curve.complete) {
        logger.debug({ mint: mintStr }, `Bonding curve complete, skipping`);
        return;
      }

      const initialRealTokens = curve.tokenTotalSupply; // approx; use realTokenReserves/total as progress proxy
      const progressPct =
        curve.tokenTotalSupply > 0n
          ? Number(((curve.tokenTotalSupply - curve.realTokenReserves) * 10000n) / curve.tokenTotalSupply) / 100
          : 0;
      const maxProgress = this.config.pumpFunMaxCurveProgress ?? 100;
      if (progressPct > maxProgress) {
        logger.debug({ mint: mintStr, progressPct }, `Curve progress too high, skipping`);
        return;
      }

      const solInLamports = BigInt(Math.floor((this.config.pumpFunBuyAmountSol ?? 0.001) * 1_000_000_000));
      const expectedTokens = computeTokensOutForSol(curve, solInLamports);
      if (expectedTokens <= 0n) {
        logger.debug({ mint: mintStr }, `Expected tokens out is zero`);
        return;
      }
      const slippageBps = BigInt(Math.floor(this.config.buySlippage * 100));
      const maxSolCost = (solInLamports * (10000n + slippageBps)) / 10000n;
      // pump.fun charges 1% fee, bump max by 1% more for safety
      const maxSolCostWithFee = (maxSolCost * 101n) / 100n;

      this.pumpFunStorage.save({
        mint,
        bondingCurve,
        associatedBondingCurve,
        state: curve,
      });

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: mintStr },
            `Send pump.fun buy tx attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const result = await this.executePumpFunBuy({
            mint,
            bondingCurve,
            associatedBondingCurve,
            associatedUser: await associatedUser,
            amount: expectedTokens,
            maxSolCost: maxSolCostWithFee,
          });

          if (result.confirmed) {
            logger.info(
              {
                mint: mintStr,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed pump.fun buy`,
            );
            break;
          }
          logger.info({ mint: mintStr, signature: result.signature, error: result.error }, `Error confirming pump.fun buy`);
        } catch (error) {
          logger.debug({ mint: mintStr, error }, `Error sending pump.fun buy`);
        }
      }
    } catch (error) {
      logger.error({ mint: mint.toString(), error }, `Failed to buy pump.fun token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sellPumpFun(userAta: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      const mintStr = rawAccount.mint.toString();
      const entry = this.pumpFunStorage.get(mintStr);
      if (!entry) return;

      const tokensIn = BigInt(rawAccount.amount.toString());
      if (tokensIn === 0n) {
        logger.info({ mint: mintStr }, `Empty pump.fun balance`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        await sleep(this.config.autoSellDelay);
      }

      await this.pumpFunPriceMatch(entry.mint, tokensIn);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          const curveInfo = await this.connection.getAccountInfo(entry.bondingCurve, this.connection.commitment);
          if (!curveInfo?.data) break;
          const curve = decodeBondingCurve(curveInfo.data);
          if (curve.complete) {
            logger.info({ mint: mintStr }, `Curve graduated to Raydium; skipping pump.fun sell`);
            break;
          }

          const solOut = computeSolOutForTokens(curve, tokensIn);
          const slippageBps = BigInt(Math.floor(this.config.sellSlippage * 100));
          const minSolOutput = (solOut * (10000n - slippageBps)) / 10000n;

          logger.info({ mint: mintStr }, `Send pump.fun sell tx attempt: ${i + 1}/${this.config.maxSellRetries}`);
          const result = await this.executePumpFunSell({
            mint: entry.mint,
            bondingCurve: entry.bondingCurve,
            associatedBondingCurve: entry.associatedBondingCurve,
            associatedUser: userAta,
            amount: tokensIn,
            minSolOutput,
          });

          if (result.confirmed) {
            logger.info(
              {
                mint: mintStr,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed pump.fun sell`,
            );
            break;
          }
          logger.info({ mint: mintStr, signature: result.signature, error: result.error }, `Error confirming pump.fun sell`);
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error }, `Error pump.fun sell`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell pump.fun token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  private async executePumpFunBuy(params: {
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    amount: bigint;
    maxSolCost: bigint;
  }) {
    const latestBlockhash = await this.connection.getLatestBlockhash();
    const ixs = [
      ...(this.isWarp || this.isJito
        ? []
        : [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
          ]),
      createAssociatedTokenAccountIdempotentInstruction(
        this.config.wallet.publicKey,
        params.associatedUser,
        this.config.wallet.publicKey,
        params.mint,
      ),
      createPumpFunBuyInstruction({
        mint: params.mint,
        user: this.config.wallet.publicKey,
        bondingCurve: params.bondingCurve,
        associatedBondingCurve: params.associatedBondingCurve,
        associatedUser: params.associatedUser,
        amount: params.amount,
        maxSolCost: params.maxSolCost,
      }),
    ];
    const messageV0 = new TransactionMessage({
      payerKey: this.config.wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.config.wallet]);
    return this.txExecutor.executeAndConfirm(tx, this.config.wallet, latestBlockhash);
  }

  private async executePumpFunSell(params: {
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    amount: bigint;
    minSolOutput: bigint;
  }) {
    const latestBlockhash = await this.connection.getLatestBlockhash();
    const ixs = [
      ...(this.isWarp || this.isJito
        ? []
        : [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
          ]),
      createPumpFunSellInstruction({
        mint: params.mint,
        user: this.config.wallet.publicKey,
        bondingCurve: params.bondingCurve,
        associatedBondingCurve: params.associatedBondingCurve,
        associatedUser: params.associatedUser,
        amount: params.amount,
        minSolOutput: params.minSolOutput,
      }),
      createCloseAccountInstruction(params.associatedUser, this.config.wallet.publicKey, this.config.wallet.publicKey),
    ];
    const messageV0 = new TransactionMessage({
      payerKey: this.config.wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([this.config.wallet]);
    return this.txExecutor.executeAndConfirm(tx, this.config.wallet, latestBlockhash);
  }

  private async pumpFunPriceMatch(mint: PublicKey, tokensIn: bigint) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) return;

    const buyAmountSol = this.config.pumpFunBuyAmountSol ?? 0.001;
    const takeProfitLamports = BigInt(Math.floor(buyAmountSol * (1 + this.config.takeProfit / 100) * 1_000_000_000));
    const stopLossLamports = BigInt(Math.floor(buyAmountSol * (1 - this.config.stopLoss / 100) * 1_000_000_000));
    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    let timesChecked = 0;
    const bondingCurve = getBondingCurvePDA(mint);

    do {
      try {
        const info = await this.connection.getAccountInfo(bondingCurve, this.connection.commitment);
        if (!info?.data) break;
        const curve = decodeBondingCurve(info.data);
        if (curve.complete) break;
        const solOut = computeSolOutForTokens(curve, tokensIn);
        logger.debug(
          { mint: mint.toString() },
          `PumpFun TP: ${takeProfitLamports} | SL: ${stopLossLamports} | Now: ${solOut}`,
        );
        if (solOut <= stopLossLamports) break;
        if (solOut >= takeProfitLamports) break;
        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: mint.toString(), e }, `pump.fun price check failed`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    const stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        if (amountOut.lt(stopLoss)) {
          break;
        }

        if (amountOut.gt(takeProfit)) {
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }
}
