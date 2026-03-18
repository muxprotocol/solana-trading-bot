import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
export const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
export const PUMP_FUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

// anchor account discriminator for BondingCurve: sha256("account:BondingCurve")[0..8]
export const BONDING_CURVE_DISCRIMINATOR = Buffer.from([23, 183, 248, 55, 96, 93, 172, 108]);
export const BONDING_CURVE_DISCRIMINATOR_B58 = bs58.encode(BONDING_CURVE_DISCRIMINATOR);

// anchor instruction discriminators
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

export const BONDING_CURVE_ACCOUNT_SIZE = 8 + 8 * 5 + 1; // 49

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export function decodeBondingCurve(data: Buffer): BondingCurveState {
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data.readUInt8(48) === 1,
  };
}

export function getBondingCurvePDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID,
  )[0];
}

export function getAssociatedBondingCurve(bondingCurve: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, bondingCurve, true);
}

// constant-product: tokensOut = vTok - (vTok*vSol)/(vSol + solIn)
export function computeTokensOutForSol(curve: BondingCurveState, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  const k = curve.virtualTokenReserves * curve.virtualSolReserves;
  const newSol = curve.virtualSolReserves + solIn;
  const newTok = k / newSol;
  const out = curve.virtualTokenReserves - newTok;
  return out < curve.realTokenReserves ? out : curve.realTokenReserves;
}

// solOut = vSol - (vSol*vTok)/(vTok + tokensIn); apply 1% fee
export function computeSolOutForTokens(curve: BondingCurveState, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const k = curve.virtualTokenReserves * curve.virtualSolReserves;
  const newTok = curve.virtualTokenReserves + tokensIn;
  const newSol = k / newTok;
  const gross = curve.virtualSolReserves - newSol;
  const fee = gross / 100n;
  return gross - fee;
}

function encodeBuyData(amount: bigint, maxSolCost: bigint): Buffer {
  const data = Buffer.alloc(24);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);
  return data;
}

function encodeSellData(amount: bigint, minSolOutput: bigint): Buffer {
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(minSolOutput, 16);
  return data;
}

export interface PumpFunIxParams {
  mint: PublicKey;
  user: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
}

export function createPumpFunBuyInstruction(
  params: PumpFunIxParams & { amount: bigint; maxSolCost: bigint },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedUser, isSigner: false, isWritable: true },
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeBuyData(params.amount, params.maxSolCost),
  });
}

export function createPumpFunSellInstruction(
  params: PumpFunIxParams & { amount: bigint; minSolOutput: bigint },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: params.associatedUser, isSigner: false, isWritable: true },
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encodeSellData(params.amount, params.minSolOutput),
  });
}

export const PUMP_TOKEN_DECIMALS = 6;
