---
name: provider-builder
description: Build and integrate DRAIN providers for the Handshake58 marketplace. Use when the user wants to add a new provider, integrate an API, wrap a service, or build a custom tool as a paid DRAIN provider. Covers LLM proxies, API wrappers, and self-built services.
---

# Provider Builder

Integrate any service into the Handshake58 marketplace as a DRAIN payment provider. This skill covers three provider types:

- **Typ A: LLM-Proxy** -- OpenAI-compatible API via SDK (Ref: `hs58-openai`, `hs58-claude`)
- **Typ B: API-Wrapper** -- External API via fetch/SDK (Ref: `hs58-apify`, `hs58-resend`, `hs58-tempsh`)
- **Typ C: Self-Built** -- Custom logic, no external API (e.g. Word-to-PDF, image processor)

All providers share the same DRAIN payment shell. Only the core logic differs.

Reference providers live in `providers/` in the HS58 repo. Read the closest reference before building.

## Phase 1: Discovery / Design

### Typ A+B (existing API)

1. Read the API docs (URL, GitHub, scrape if needed)
2. Probe endpoints: Is it OpenAI-compatible? REST? Needs SDK?
3. Walk the decision tree:

```
OpenAI-compatible? → Pattern 1: LLM-Proxy + SSE (Ref: hs58-openai, hs58-claude)
Immediate response? → Pattern 2: Flat-Rate (Ref: hs58-resend, hs58-vericore)
Async job + polling? → Pattern 3: Async/Polling (Ref: hs58-apify, hs58-replicate)
File upload/download? → Pattern 4: Binary I/O (Ref: hs58-faster-whisper, hs58-tempsh)
Price = f(duration)? → Pattern 5: Time-based (Ref: community-tpn)
Models loaded from API? → Pattern 6: Dynamic Registry (Ref: hs58-openrouter)
Sandbox lifecycle? → Pattern 7: Code Execution (Ref: hs58-e2b)
```

Patterns combine: e.g. OpenRouter = Pattern 1 + Pattern 6.

4. Ask the user for missing info: API key, auth method, pricing model, rate limits.

### Typ C (self-built)

1. Ask: What does the service do? What is the input? What is the output?
2. What libraries/tools are needed? System dependencies (ffmpeg, LibreOffice)?
3. Define the pricing model: flat per request, per unit, time-based?
4. Sketch the core logic module (e.g. `converter.ts`, `processor.ts`)

## Phase 2: Scaffolding

### Directory structure

```
community-{name}/
├── src/
│   ├── index.ts          # Express server + all endpoints
│   ├── config.ts          # Env loading, loadConfig(), loadModels()
│   ├── types.ts           # Shared + provider-specific types
│   ├── drain.ts           # COPY from reference (never modify)
│   ├── storage.ts         # COPY from reference (never modify)
│   ├── constants.ts       # COPY from reference (never modify)
│   └── [service].ts       # Provider-specific logic (Typ B/C)
├── package.json
├── tsconfig.json
├── railway.json
├── env.example
├── README.md
└── .gitignore
```

### Naming

- Directory: `community-{name}`
- package.json name: `@handshake58/community-{name}`
- Model IDs: `{prefix}/{model}` (e.g. `word2pdf/convert`, `myapi/search`)

### Shared DRAIN code -- COPY VERBATIM

Copy `drain.ts`, `storage.ts`, `constants.ts`, and the base types in `types.ts` from the nearest reference provider. **Never modify these files.** They handle voucher validation, EIP-712 signatures, on-chain claiming, and JSON file storage.

### package.json

```json
{
  "name": "@handshake58/community-{name}",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.0",
    "viem": "^2.0.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.0",
    "@types/express": "^4.17.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

Add provider-specific deps: `openai` for LLM proxies, `@anthropic-ai/sdk` for Claude, `multer` for file uploads, etc.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

### railway.json

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

### .gitignore

```
node_modules/
dist/
.env
*.log
package-lock.json
data/
```

### env.example

Always include these universal variables:

```bash
# === REQUIRED ===
PROVIDER_PRIVATE_KEY=0xYOUR_POLYGON_PRIVATE_KEY
{SERVICE}_API_KEY=your-api-key-here          # If wrapping an external API

# === DRAIN / BLOCKCHAIN ===
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
CHAIN_ID=137                                  # 137=Polygon, 80002=Amoy testnet
CLAIM_THRESHOLD=1000000                       # Min USDC-wei before auto-claim ($1)
AUTO_CLAIM_INTERVAL_MINUTES=10
AUTO_CLAIM_BUFFER_SECONDS=3600
STORAGE_PATH=./data/vouchers.json

# === SERVER ===
PORT=3000
HOST=0.0.0.0
PROVIDER_NAME=Community-{Name}

# === PRICING ===
MARKUP_PERCENT=50                             # Markup on base prices

# === OPTIONAL ===
ADMIN_PASSWORD=                               # Protect /v1/admin/* endpoints
RATE_LIMIT_PER_MINUTE=30                      # Per-channel rate limit
```

Add provider-specific vars (pricing params, limits, timeouts, etc.).

## Phase 2a: SSE Streaming (Pattern 1 -- LLM Proxies)

All LLM proxies must support both streaming and non-streaming. The pattern is identical across all providers:

**Streaming response:**
1. Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-DRAIN-Channel: {id}`
2. Forward chunks: `res.write(\`data: ${JSON.stringify(chunk)}\n\n\`)`
3. Track tokens from `chunk.usage` or estimate with `content.length / 4`
4. After stream ends: `res.write('data: [DONE]\n\n')`
5. Send cost as SSE comments (NOT HTTP headers):
```
: X-DRAIN-Cost: {amount}
: X-DRAIN-Total: {total}
: X-DRAIN-Remaining: {remaining}
```
6. `res.end()`

**Non-streaming response:**
1. Get actual token counts from `completion.usage`
2. Calculate actual cost
3. Re-validate voucher with actual cost (return 402 if insufficient)
4. Set response headers: `X-DRAIN-Cost`, `X-DRAIN-Total`, `X-DRAIN-Remaining`, `X-DRAIN-Channel`
5. Return the completion JSON

**Pre-auth estimation** (both modes): Estimate input tokens as `JSON.stringify(messages).length / 4`, assume 50 output tokens minimum. Validate voucher against this estimate before calling upstream.

**Anthropic exception:** Use `anthropic.messages.stream()` with event-based callbacks (`stream.on('text', ...)`) instead of `for await`.

## Phase 2b: Dynamic Registry (Pattern 6)

For providers where models come from an API (OpenRouter, Apify, Replicate):

1. `fetchModels()` from upstream API on startup
2. Store in a global `Map<string, ModelPricing>` cache
3. Refresh periodically: `setInterval(() => updatePricingCache(), refreshInterval)`
4. Expose `/v1/admin/refresh-models` for manual refresh
5. Convert upstream pricing to DRAIN format: `price * 1000 * 1_000_000 * markup`

## 7 Required Endpoints

Every provider MUST implement these. The `POST /v1/chat/completions` handler is the core -- all others are mostly boilerplate.

### GET /v1/pricing

**This endpoint is the gateway to the marketplace.** The connection test checks it during registration. If it fails, the provider is rejected.

```typescript
app.get('/v1/pricing', (_req, res) => {
  const models: Record<string, any> = {};
  for (const [id, pricing] of modelMap) {
    models[id] = {
      inputPer1kTokens: formatUnits(pricing.inputPer1k, 6),
      outputPer1kTokens: formatUnits(pricing.outputPer1k, 6),
    };
  }
  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    models,
  });
});
```

**Hard requirements (marketplace connection test):**
1. HTTP 200 within 10 seconds
2. Response has `provider` (string) AND `models` (object)
3. `provider` matches the wallet address used for registration (case-insensitive)
4. `models` has at least one entry
5. Each model has `inputPer1kTokens` and `outputPer1kTokens` as strings

For flat-rate providers: `inputPer1kTokens` = price per request, `outputPer1kTokens` = `"0"`.

### GET /v1/models

```typescript
app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: getSupportedModels().map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: id.split('/')[0],
    })),
  });
});
```

### GET /v1/docs

Returns `text/plain` markdown. This is how AI agents learn to use the provider. **If docs are missing or under 100 characters, the marketplace marks the provider as DEGRADED and agents cannot discover it.**

Use one of two templates:

**LLM template** (Pattern 1):
```
# {PROVIDER_NAME} — Agent Instructions
Standard OpenAI-compatible LLM provider via DRAIN payments.
## How to use via DRAIN
1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with: model + messages (standard chat format)
## Example
model: "{MODEL_ID}"
messages: [{"role": "user", "content": "Explain quantum computing"}]
Streaming is supported (stream: true).
## Top Models
{dynamic list with prices}
Full list: GET /v1/models | Full pricing: GET /v1/pricing
## Pricing
Per-token pricing in USDC. Cost = (input_tokens * input_rate + output_tokens * output_rate) / 1000.
## Notes
- Standard OpenAI chat completions format
- Streaming supported via stream: true
```

**Generic template** (Pattern 2-7, Typ C):
```
# {PROVIDER_NAME} — Agent Instructions
{Description. State "This is NOT a chat/LLM provider." if non-LLM.}
## How to use via DRAIN
1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: "{MODEL_ID}"
   - messages: ONE user message containing {describe input format}
## Available Models / Operations
{Table or list: Model ID | Description | Price}
## Input Format
{Exactly what goes in the user message: JSON with fields X,Y,Z? Plain text? Code?}
## Example
model: "{MODEL_ID}"
messages: [{"role": "user", "content": "{concrete example}"}]
## Response
{What the assistant message contains: JSON fields? URLs? Text?}
## Pricing
{Flat rate / per-token / time-based}. Check /v1/pricing for current USDC rates.
## Notes
{Timeouts, limits, constraints}
```

**Checklist:**
- Content-Type: `text/plain`
- Length: 800-2500 characters
- Use dynamic values (prices, model IDs, timeouts) where possible
- An agent with ZERO prior knowledge must be able to use the provider from the docs alone

### GET /health

```typescript
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', provider: drainService.getProviderAddress(), providerName: config.providerName });
});
```

### POST /v1/chat/completions -- Payment Flow

This is the core endpoint. The payment flow is identical for all providers:

```typescript
app.post('/v1/chat/completions', async (req, res) => {
  // 1. Require voucher
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    return res.status(402).set({ 'X-DRAIN-Error': 'voucher_required' }).json({
      error: { message: 'X-DRAIN-Voucher header required', type: 'payment_required', code: 'voucher_required' },
    });
  }

  // 2. Parse voucher
  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    return res.status(402).set({ 'X-DRAIN-Error': 'invalid_voucher_format' }).json({
      error: { message: 'Invalid X-DRAIN-Voucher format', type: 'payment_required', code: 'invalid_voucher_format' },
    });
  }

  // 3. Validate model
  const model = req.body.model;
  if (!isModelSupported(model)) {
    return res.status(400).json({ error: { message: `Model not supported: ${model}` } });
  }

  // 4. Calculate cost + validate voucher
  const cost = calculateCost(model, req.body);
  const validation = await drainService.validateVoucher(voucher, cost);
  if (!validation.valid) {
    const headers: Record<string, string> = { 'X-DRAIN-Error': validation.error! };
    if (validation.error === 'insufficient_funds' && validation.channel) {
      headers['X-DRAIN-Required'] = cost.toString();
      headers['X-DRAIN-Provided'] = (BigInt(voucher.amount) - validation.channel.totalCharged).toString();
    }
    return res.status(402).set(headers).json({
      error: { message: `Payment validation failed: ${validation.error}`, type: 'payment_required', code: validation.error },
    });
  }

  const channelState = validation.channel!;

  // 5. [OPTIONAL] Rate limit
  // if (!checkRateLimit(voucher.channelId)) return res.status(429).json({ error: { message: 'Rate limit exceeded' } });

  // === YOUR PROVIDER LOGIC HERE ===
  // Call upstream API, run local logic, etc.
  // Get the result and calculate actual cost if different from estimate.

  // 6. Store voucher + respond
  drainService.storeVoucher(voucher, channelState, cost);
  const remaining = channelState.deposit - channelState.totalCharged;
  res.set({
    'X-DRAIN-Cost': cost.toString(),
    'X-DRAIN-Total': channelState.totalCharged.toString(),
    'X-DRAIN-Remaining': remaining.toString(),
    'X-DRAIN-Channel': voucher.channelId,
  }).json({
    id: `${config.providerName}-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: resultContent }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  });
});
```

### POST /v1/close-channel

```typescript
app.post('/v1/close-channel', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  try {
    const { finalAmount, signature } = await drainService.signCloseAuthorization(channelId);
    res.json({ channelId, finalAmount: finalAmount.toString(), signature });
  } catch (error) {
    res.status(500).json({ error: 'internal_error' });
  }
});
```

### POST /v1/admin/claim

```typescript
app.post('/v1/admin/claim', async (req, res) => {
  if (config.adminPassword) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.adminPassword}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  try {
    const txs = await drainService.claimPayments(req.body?.forceAll === true);
    res.json({ claimed: txs.length, transactions: txs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

## Phase 3: Build + Verify

1. Run `npm install` then `npm run build` -- TypeScript must compile with zero errors
2. If build fails, read the error, fix it, rebuild. Max 3 iterations.
3. Verify all 7 endpoints exist in the compiled code
4. Check pricing format: `models` object with `inputPer1kTokens`/`outputPer1kTokens` as strings

## Phase 4: Marketplace Compliance

Simulate the connection test mentally:
- `GET /v1/pricing` returns 200 with `provider` + non-empty `models` object? 
- `provider` address derives from `PROVIDER_PRIVATE_KEY`?
- `GET /v1/docs` returns 200 with 100+ characters of text/plain?
- All model IDs follow `prefix/name` format?

## Phase 5: Registration Data + Logo

Generate all data the user needs for marketplace registration.

### Logo

Generate an SVG logo using the GenerateImage tool. Simple, clean icon representing the service. The user will host it (e.g. on GitHub) and use the raw URL as `logoUrl`.

### Registration payload

Output a ready-to-use JSON for `POST /api/directory/providers`:

```json
{
  "name": "{Provider Name}",
  "apiUrl": "[FILL AFTER DEPLOY - Railway URL]",
  "providerAddress": "[FILL - derived from PROVIDER_PRIVATE_KEY]",
  "description": "{1-2 sentence description}",
  "contactEmail": "[FILL - user's email]",
  "logoUrl": "[FILL - hosted logo URL]",
  "website": "[FILL - user's website]",
  "category": "{one of: llm, image, audio, video, code, multi-modal, scraping, search, data, scheduling, network, forecasting, other}",
  "additionalCategories": [],
  "supportsStreaming": false
}
```

**Profile completeness warning:** The provider is INVISIBLE to AI agents unless ALL 5 fields are set:
- `description` (20%) -- generated by this skill
- `logoUrl` (20%) -- generated by this skill, user must host
- `website` (20%) -- user must provide
- `docsUrl` or `apiUrl` (20%) -- automatic via /v1/docs
- `contactEmail` (20%) -- user must provide

Without 100% completeness, the provider will not appear in `drain_providers` results.

### Post-registration

Status starts as `pending`. An admin must approve the provider. After approval, the marketplace health-check system periodically calls `/v1/pricing` and `/v1/docs` to verify the provider is online.

## Phase 6: Git + PR

1. Create branch: `provider/community-{name}`
2. Stage all files EXCEPT `node_modules/`, `dist/`, `.env`, `*.log`, `package-lock.json`, `data/`
3. Commit: `feat(providers): add community-{name} provider`
4. Push and create PR to `Handshake58/HS58` with summary of what the provider does, which models it exposes, and the pricing model

## Quick Reference: Provider Categories

`llm` | `image` | `audio` | `video` | `code` | `multi-modal` | `scraping` | `search` | `data` | `scheduling` | `network` | `forecasting` | `other`
