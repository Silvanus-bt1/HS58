/**
 * HS58-Resend Provider
 *
 * DRAIN payment gateway for the Resend email API.
 * Enables AI agents to send transactional emails with crypto micropayments.
 */

import express from 'express';
import cors from 'cors';
import { Resend } from 'resend';
import { loadConfig, loadModels, getModelPricing, isModelSupported, getSupportedModels } from './config.js';
import { DrainService } from './drain.js';
import { VoucherStorage } from './storage.js';
import { formatUnits } from 'viem';
import type { SendEmailParams } from './types.js';

const config = loadConfig();

const storage = new VoucherStorage(config.storagePath);
const drainService = new DrainService(config, storage);
const resend = new Resend(config.resendApiKey);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function validateEmailParams(params: any): { valid: boolean; error?: string; parsed?: SendEmailParams } {
  if (!params.to) {
    return { valid: false, error: '"to" field is required (string or array of strings)' };
  }
  if (!params.subject || typeof params.subject !== 'string') {
    return { valid: false, error: '"subject" field is required (string)' };
  }
  if (!params.html && !params.text) {
    return { valid: false, error: 'Either "html" or "text" field is required' };
  }

  const to = Array.isArray(params.to) ? params.to : [params.to];
  for (const addr of to) {
    if (typeof addr !== 'string' || !addr.includes('@')) {
      return { valid: false, error: `Invalid email address: ${addr}` };
    }
  }

  const from = params.from || config.defaultFrom;

  if (config.allowedDomains.length > 0) {
    const fromDomain = from.includes('@') ? from.split('@').pop()?.replace('>', '') : '';
    if (fromDomain && !config.allowedDomains.includes(fromDomain)) {
      return { valid: false, error: `From domain "${fromDomain}" is not allowed. Allowed: ${config.allowedDomains.join(', ')}` };
    }
  }

  return {
    valid: true,
    parsed: {
      from,
      to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      cc: params.cc,
      bcc: params.bcc,
      reply_to: params.reply_to,
      tags: params.tags,
    },
  };
}

/**
 * GET /v1/pricing
 */
app.get('/v1/pricing', (_req, res) => {
  const pricing: Record<string, any> = {};

  for (const modelId of getSupportedModels()) {
    const modelPricing = getModelPricing(modelId);
    if (modelPricing) {
      pricing[modelId] = {
        pricePerEmail: formatUnits(modelPricing.inputPer1k, 6),
        inputPer1kTokens: formatUnits(modelPricing.inputPer1k, 6),
        outputPer1kTokens: '0',
      };
    }
  }

  res.json({
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    currency: 'USDC',
    decimals: 6,
    type: 'email',
    note: 'Flat rate per email sent via Resend API.',
    models: pricing,
  });
});

/**
 * GET /v1/models
 */
app.get('/v1/models', (_req, res) => {
  const models = getSupportedModels().map(id => ({
    id,
    object: 'model',
    created: Date.now(),
    owned_by: 'resend',
    description: 'Send transactional emails via Resend',
  }));

  res.json({ object: 'list', data: models });
});

/**
 * GET /v1/docs
 */
app.get('/v1/docs', (_req, res) => {
  const price = getModelPricing('resend/send-email');
  const priceStr = price ? formatUnits(price.inputPer1k, 6) : '?';

  res.type('text/plain').send(`# HS58-Resend Provider — Agent Instructions

This provider sends transactional emails via the Resend API.

## How to use via DRAIN

1. Open a payment channel to this provider (drain_open_channel)
2. Call drain_chat with:
   - model: "resend/send-email"
   - messages: ONE user message containing valid JSON = the email parameters

## Email Parameters (JSON)

{
  "to": ["recipient@example.com"],
  "subject": "Your subject",
  "html": "<p>Email body in HTML</p>",
  "text": "Plain text fallback (optional if html is provided)",
  "from": "sender@yourdomain.com (optional, uses default)",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"],
  "reply_to": "reply@example.com"
}

## Example

model: "resend/send-email"
messages: [{"role": "user", "content": "{\\"to\\": [\\"user@example.com\\"], \\"subject\\": \\"Hello\\", \\"html\\": \\"<p>Hi!</p>\\"}"}]

## Pricing

$${priceStr} USDC per email sent.

## Alternative: Direct API

POST /v1/emails/send with JSON body (same parameters) and X-DRAIN-Voucher header.
`);
});

/**
 * POST /v1/emails/send
 *
 * Direct email sending endpoint (native Resend format).
 */
app.post('/v1/emails/send', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    res.status(402).json({
      error: { message: 'Payment required. Include X-DRAIN-Voucher header.' },
    });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({
      error: { message: 'Invalid voucher format.' },
    });
    return;
  }

  const validation = validateEmailParams(req.body);
  if (!validation.valid) {
    res.status(400).json({
      error: { message: validation.error },
    });
    return;
  }

  const cost = config.pricePerEmail;

  const voucherValidation = await drainService.validateVoucher(voucher, cost);
  if (!voucherValidation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${voucherValidation.error}` },
      ...(voucherValidation.error === 'insufficient_funds' && {
        required: cost.toString(),
      }),
    });
    return;
  }

  try {
    const emailParams = validation.parsed!;
    const { data, error } = await resend.emails.send({
      from: emailParams.from!,
      to: emailParams.to as string[],
      subject: emailParams.subject,
      html: emailParams.html,
      text: emailParams.text,
      cc: emailParams.cc as string[],
      bcc: emailParams.bcc as string[],
      replyTo: emailParams.reply_to as string,
      tags: emailParams.tags,
    });

    if (error) {
      res.status(502).json({
        error: { message: `Resend API error: ${error.message}` },
      });
      return;
    }

    drainService.storeVoucher(voucher, voucherValidation.channel!, cost);

    const totalCharged = voucherValidation.channel!.totalCharged + cost;
    const remaining = voucherValidation.channel!.deposit - totalCharged;

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      success: true,
      id: data?.id,
      from: emailParams.from,
      to: emailParams.to,
      subject: emailParams.subject,
    });
  } catch (error: any) {
    console.error('[resend] Send error:', error.message);
    res.status(502).json({
      error: { message: `Email send failed: ${error.message?.slice(0, 200)}` },
    });
  }
});

/**
 * POST /v1/chat/completions
 *
 * Chat-wrapper for email sending:
 * - model = "resend/send-email"
 * - last user message = JSON email parameters
 * - response = send result as assistant message
 */
app.post('/v1/chat/completions', async (req, res) => {
  const voucherHeader = req.headers['x-drain-voucher'] as string;
  if (!voucherHeader) {
    res.status(402).json({
      error: { message: 'Payment required. Include X-DRAIN-Voucher header.' },
    });
    return;
  }

  const voucher = drainService.parseVoucherHeader(voucherHeader);
  if (!voucher) {
    res.status(402).json({
      error: { message: 'Invalid voucher format.' },
    });
    return;
  }

  const modelId = req.body.model as string;
  if (!modelId || !isModelSupported(modelId)) {
    res.status(400).json({
      error: { message: `Model "${modelId}" not available. Use: ${getSupportedModels().join(', ')}` },
    });
    return;
  }

  const cost = config.pricePerEmail;

  const voucherValidation = await drainService.validateVoucher(voucher, cost);
  if (!voucherValidation.valid) {
    res.status(402).json({
      error: { message: `Voucher error: ${voucherValidation.error}` },
      ...(voucherValidation.error === 'insufficient_funds' && {
        required: cost.toString(),
      }),
    });
    return;
  }

  const messages = req.body.messages as Array<{ role: string; content: string }>;
  const lastUserMsg = messages?.filter(m => m.role === 'user').pop();

  if (!lastUserMsg?.content) {
    res.status(400).json({
      error: { message: 'No user message found. Send email parameters as JSON in the user message.' },
    });
    return;
  }

  let emailInput: any;
  try {
    emailInput = JSON.parse(lastUserMsg.content);
  } catch {
    res.status(400).json({
      error: {
        message: 'User message must be valid JSON with email parameters. ' +
          'Required: {"to": ["..."], "subject": "...", "html": "..."} or {"to": ["..."], "subject": "...", "text": "..."}',
      },
    });
    return;
  }

  const validation = validateEmailParams(emailInput);
  if (!validation.valid) {
    res.status(400).json({
      error: { message: validation.error },
    });
    return;
  }

  try {
    const emailParams = validation.parsed!;
    const { data, error } = await resend.emails.send({
      from: emailParams.from!,
      to: emailParams.to as string[],
      subject: emailParams.subject,
      html: emailParams.html,
      text: emailParams.text,
      cc: emailParams.cc as string[],
      bcc: emailParams.bcc as string[],
      replyTo: emailParams.reply_to as string,
      tags: emailParams.tags,
    });

    if (error) {
      res.status(502).json({
        error: { message: `Resend API error: ${error.message}` },
      });
      return;
    }

    drainService.storeVoucher(voucher, voucherValidation.channel!, cost);

    const totalCharged = voucherValidation.channel!.totalCharged + cost;
    const remaining = voucherValidation.channel!.deposit - totalCharged;

    const content = JSON.stringify({
      success: true,
      emailId: data?.id,
      from: emailParams.from,
      to: emailParams.to,
      subject: emailParams.subject,
    }, null, 2);

    res.set({
      'X-DRAIN-Cost': cost.toString(),
      'X-DRAIN-Total': totalCharged.toString(),
      'X-DRAIN-Remaining': remaining.toString(),
      'X-DRAIN-Channel': voucher.channelId,
    });

    res.json({
      id: `resend-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 1,
        total_tokens: 1,
      },
    });
  } catch (error: any) {
    console.error('[resend] Send error:', error.message);
    res.status(502).json({
      error: { message: `Email send failed: ${error.message?.slice(0, 200)}` },
    });
  }
});

/**
 * POST /v1/admin/claim
 */
app.post('/v1/admin/claim', async (req, res) => {
  try {
    const forceAll = req.body?.forceAll === true;
    const txHashes = await drainService.claimPayments(forceAll);
    res.json({ claimed: txHashes.length, transactions: txHashes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /v1/admin/stats
 */
app.get('/v1/admin/stats', (_req, res) => {
  const stats = storage.getStats();
  res.json({
    ...stats,
    totalEarned: stats.totalEarned.toString(),
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
  });
});

/**
 * GET /v1/admin/vouchers
 */
app.get('/v1/admin/vouchers', (_req, res) => {
  const unclaimed = storage.getUnclaimedVouchers();
  res.json({
    count: unclaimed.length,
    vouchers: unclaimed.map(v => ({
      channelId: v.channelId,
      amount: v.amount.toString(),
      nonce: v.nonce.toString(),
      consumer: v.consumer,
      receivedAt: new Date(v.receivedAt).toISOString(),
    })),
  });
});

app.post('/v1/close-channel', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId required' });

    const result = await drainService.signCloseAuthorization(channelId);
    res.json({
      channelId,
      finalAmount: result.finalAmount.toString(),
      signature: result.signature,
    });
  } catch (error: any) {
    console.error('[close-channel] Error:', error?.message || error);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Health check
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    provider: drainService.getProviderAddress(),
    providerName: config.providerName,
    chainId: config.chainId,
    defaultFrom: config.defaultFrom,
  });
});

async function start() {
  loadModels(config.markup);

  drainService.startAutoClaim(config.autoClaimIntervalMinutes, config.autoClaimBufferSeconds);

  app.listen(config.port, config.host, () => {
    console.log(`\n${config.providerName} running on http://${config.host}:${config.port}`);
    console.log(`Provider address: ${drainService.getProviderAddress()}`);
    console.log(`Chain: ${config.chainId === 137 ? 'Polygon' : 'Amoy Testnet'}`);
    console.log(`Default from: ${config.defaultFrom}`);
    console.log(`Price per email: $${(Number(config.pricePerEmail) / 1_000_000).toFixed(4)} USDC`);
    if (config.allowedDomains.length > 0) {
      console.log(`Allowed domains: ${config.allowedDomains.join(', ')}`);
    }
    console.log(`Auto-claim active: checking every ${config.autoClaimIntervalMinutes}min\n`);
  });
}

start().catch(error => {
  console.error('Failed to start:', error);
  process.exit(1);
});
