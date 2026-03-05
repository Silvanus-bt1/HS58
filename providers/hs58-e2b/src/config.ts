/**
 * HS58-E2B Provider Configuration
 *
 * Defines supported language "models" and their DRAIN pricing.
 * Pricing is flat-rate per execution, covering E2B sandbox compute costs + markup.
 *
 * E2B compute cost reference (default 2 vCPU + 512 MiB):
 *   ~$0.000028/s CPU + ~$0.00000225/s RAM ≈ $0.000030/s total
 *   Typical execution (30s incl. startup): ~$0.001 upstream cost
 */

import { config } from 'dotenv';
import type { ProviderConfig, ModelPricing } from './types.js';
import type { Hex } from 'viem';

config();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
};

const optionalEnv = (name: string, defaultValue: string): string =>
  process.env[name] ?? defaultValue;

/**
 * Base prices per execution in USD (before markup).
 * These cover upstream E2B cost (~$0.001) with a healthy margin
 * to support the provider business.
 */
export const MODEL_BASE_PRICES_USD: Record<string, number> = {
  'e2b/python':     0.02,
  'e2b/javascript': 0.02,
  'e2b/typescript': 0.02,
  'e2b/bash':       0.01,
  'e2b/r':          0.02,
  'e2b/java':       0.03, // higher: JVM startup adds ~5-10s
};

export const MODEL_DESCRIPTIONS: Record<string, string> = {
  'e2b/python':     'Execute Python 3 code in an isolated sandbox. Supports data science libs: numpy, pandas, matplotlib, etc.',
  'e2b/javascript': 'Execute JavaScript (Node.js) code in an isolated sandbox. npm packages can be installed via commands.',
  'e2b/typescript': 'Execute TypeScript code with top-level await and ESM import support.',
  'e2b/bash':       'Execute Bash shell commands. Full Linux environment with internet access.',
  'e2b/r':          'Execute R code for statistical computing and data analysis.',
  'e2b/java':       'Execute Java code. JDK pre-installed. Note: JVM startup adds a few seconds.',
};

let pricingMap: Map<string, ModelPricing> = new Map();

/**
 * Build the pricing map from base prices and markup.
 */
export function buildPricing(markupMultiplier: number): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();

  for (const [model, baseUsd] of Object.entries(MODEL_BASE_PRICES_USD)) {
    const priceUsd = baseUsd * markupMultiplier;
    const priceWei = BigInt(Math.ceil(priceUsd * 1_000_000));
    map.set(model, { inputPer1k: priceWei, outputPer1k: 0n });
  }

  pricingMap = map;
  return map;
}

export const getModelPricing = (model: string): ModelPricing | null =>
  pricingMap.get(model) ?? null;

export const isModelSupported = (model: string): boolean =>
  pricingMap.has(model);

export const getSupportedModels = (): string[] =>
  Array.from(pricingMap.keys());

export function loadConfig(): ProviderConfig {
  const chainId = parseInt(optionalEnv('CHAIN_ID', '137')) as 137 | 80002;
  if (chainId !== 137 && chainId !== 80002) {
    throw new Error(`Invalid CHAIN_ID: ${chainId}`);
  }

  const markupPercent = parseInt(optionalEnv('MARKUP_PERCENT', '50'));
  const markupMultiplier = 1 + (markupPercent / 100);
  const pricing = buildPricing(markupMultiplier);

  return {
    e2bApiKey: requireEnv('E2B_API_KEY'),
    sandboxTimeoutMs: parseInt(optionalEnv('SANDBOX_TIMEOUT_MS', '120000')),
    markupMultiplier,
    port: parseInt(optionalEnv('PORT', '3000')),
    host: optionalEnv('HOST', '0.0.0.0'),
    chainId,
    providerPrivateKey: requireEnv('PROVIDER_PRIVATE_KEY') as Hex,
    polygonRpcUrl: process.env.POLYGON_RPC_URL || undefined,
    pricing,
    claimThreshold: BigInt(optionalEnv('CLAIM_THRESHOLD', '1000000')),
    storagePath: optionalEnv('STORAGE_PATH', './data/vouchers.json'),
    providerName: optionalEnv('PROVIDER_NAME', 'HS58-E2B'),
    autoClaimIntervalMinutes: parseInt(optionalEnv('AUTO_CLAIM_INTERVAL_MINUTES', '10')),
    autoClaimBufferSeconds: parseInt(optionalEnv('AUTO_CLAIM_BUFFER_SECONDS', '3600')),
  };
}
