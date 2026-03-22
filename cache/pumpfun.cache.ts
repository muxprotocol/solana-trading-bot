import { PublicKey } from '@solana/web3.js';
import { BondingCurveState } from '../helpers';

export interface PumpFunPoolEntry {
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  state: BondingCurveState;
}

export class PumpFunCache {
  private readonly keys: Map<string, PumpFunPoolEntry> = new Map();

  public has(mint: string): boolean {
    return this.keys.has(mint);
  }

  public save(entry: PumpFunPoolEntry) {
    this.keys.set(entry.mint.toString(), entry);
  }

  public update(mint: string, state: BondingCurveState) {
    const existing = this.keys.get(mint);
    if (existing) existing.state = state;
  }

  public get(mint: string): PumpFunPoolEntry | undefined {
    return this.keys.get(mint);
  }
}
