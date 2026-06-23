// OCR / document understanding for buyer's orders and sales invoices.
//
// Uses Claude vision to read an uploaded proof-of-sale (image or PDF) and pull out
// the structured fields Built Trailers needs:
//   • saleDate    — confirms the warranty registration date with NO manual step
//   • salePrice   — staff-only margin intelligence (what the dealer sold for)
//   • accessories — staff-only; what add-ons buyers are choosing
//
// No-ops cleanly when ANTHROPIC_API_KEY isn't set, and returns null on any failure,
// so a registration is NEVER blocked on OCR — anything we can't read auto-falls back
// to the manual verification queue.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.OCR_MODEL || 'claude-sonnet-4-6';
const ACCEPTED_IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function ocrConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// Split a data URL into { mediaType, base64 }; null if it isn't one.
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl || '');
  return m ? { mediaType: m[1].toLowerCase(), base64: m[2] } : null;
}

// Extract { saleDate, salePrice, accessories } from a buyer's order / invoice.
// Returns null when OCR is unavailable or the document can't be parsed — callers
// MUST treat null as "couldn't read it" and fall back to the manual queue.
export async function extractBuyersOrder(dataUrl) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  let block;
  if (parsed.mediaType === 'application/pdf') {
    block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: parsed.base64 } };
  } else if (ACCEPTED_IMAGE.has(parsed.mediaType)) {
    block = { type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.base64 } };
  } else {
    return null; // e.g. HEIC / unknown — leave it for a human
  }

  const prompt = `You are reading a trailer BUYER'S ORDER or SALES INVOICE. Extract exactly these fields and reply with ONLY a JSON object (no markdown, no prose):
{"saleDate": "YYYY-MM-DD or null", "salePrice": number or null, "accessories": "comma-separated list or null"}
- saleDate: the invoice / order / sale date printed on the document.
- salePrice: the total trailer sale price the customer paid, digits only (no $ or commas). If both a subtotal and a grand total exist, use the trailer's selling price line.
- accessories: add-on items beyond the base trailer (e.g. spare tire, toolbox, ramps, LED light kit, upgraded axles, winch). Null if none are itemized.
Use null for anything not clearly present. Do not guess.`;

  try {
    const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }],
    });
    const text = (resp.content || []).map(c => c.text || '').join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const o = JSON.parse(match[0]);
    return {
      saleDate: typeof o.saleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.saleDate) ? o.saleDate : null,
      salePrice: o.salePrice != null && o.salePrice !== '' && !isNaN(Number(o.salePrice)) ? Number(o.salePrice) : null,
      accessories: typeof o.accessories === 'string' && o.accessories.trim() ? o.accessories.trim() : null,
    };
  } catch (e) {
    console.warn('OCR extract failed:', e.message);
    return null;
  }
}
