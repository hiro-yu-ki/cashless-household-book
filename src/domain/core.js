const SOURCE_ALIASES = new Map([
  ['paypay', 'paypay'], ['pay pay', 'paypay'], ['suica', 'suica'], ['スイカ', 'suica'],
  ['aeon pay', 'aeonpay'], ['aeonpay', 'aeonpay'], ['イオンペイ', 'aeonpay'], ['credit', 'credit_card'],
  ['card', 'credit_card'], ['credit_card', 'credit_card'], ['クレジットカード', 'credit_card'], ['wallet', 'apple_wallet'],
  ['shortcut', 'ios_shortcuts'], ['csv', 'csv'], ['text', 'text'], ['manual', 'manual']
]);

export const PAYMENT_METHOD_BY_SOURCE = {
  paypay: 'pm-paypay', suica: 'pm-suica', aeonpay: 'pm-aeonpay',
  credit_card: 'pm-credit', apple_wallet: 'pm-credit'
};

export function normalizeSource(value = 'manual') {
  return SOURCE_ALIASES.get(String(value).trim().toLowerCase()) || 'generic';
}

export function normalizeMerchant(value = '') {
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/[（(].*?[）)]/g, ' ').replace(/(?:支店|店|店舗|station)$/giu, '')
    .replace(/(?:株式会社|有限会社|inc\.?|ltd\.?|co\.?)/giu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export async function fingerprintOf(input) {
  const minute = new Date(input.occurredAt).toISOString().slice(0, 16);
  const canonical = [input.kind || 'expense', Math.abs(Number(input.amount)), normalizeMerchant(input.merchant), minute, input.paymentMethodId || ''].join('|');
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function validateTransaction(input) {
  const errors = [];
  const amount = Number(input.amount);
  if (!['expense', 'income', 'refund'].includes(input.kind)) errors.push('kind must be expense, income, or refund');
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999) errors.push('amount must be a non-negative integer up to 999999999');
  if (!input.occurredAt || Number.isNaN(Date.parse(input.occurredAt))) errors.push('occurredAt must be an ISO-compatible date');
  if (String(input.merchant || '').length > 200) errors.push('merchant is too long');
  if (String(input.note || '').length > 2000) errors.push('note is too long');
  if (input.sourceEventId != null && (String(input.sourceEventId).length < 1 || String(input.sourceEventId).length > 200)) errors.push('sourceEventId length is invalid');
  if (input.splits) {
    if (!Array.isArray(input.splits) || input.splits.length > 20) errors.push('splits must contain at most 20 items');
    else {
      const total = input.splits.reduce((sum, split) => sum + Number(split.amount || 0), 0);
      if (input.splits.some((split) => !split.categoryId || !Number.isSafeInteger(Number(split.amount)) || Number(split.amount) <= 0)) errors.push('each split needs a category and positive integer amount');
      if (total !== amount) errors.push(`split total ${total} must equal transaction amount ${amount}`);
    }
  }
  return errors;
}

export function adaptPayload(payload, forcedSource) {
  const source = normalizeSource(forcedSource || payload.source || payload.paymentSource);
  const rawAmount = payload.amount ?? payload.total ?? payload.value;
  const kind = payload.kind || (Number(rawAmount) < 0 ? 'refund' : 'expense');
  return {
    kind, amount: Math.abs(Math.round(Number(rawAmount))),
    merchant: String(payload.merchant ?? payload.store ?? payload.shop ?? payload.description ?? '').trim(),
    occurredAt: payload.occurredAt ?? payload.datetime ?? payload.date ?? new Date().toISOString(),
    paymentMethodId: payload.paymentMethodId || PAYMENT_METHOD_BY_SOURCE[source] || 'pm-other',
    source, sourceEventId: payload.sourceEventId ?? payload.eventId ?? payload.id ?? null,
    note: String(payload.note || ''), splits: payload.splits,
    rawPayload: payload
  };
}

export function classifyTransaction(input, history = []) {
  if (input.kind === 'income') return { categoryId: 'cat-other-income', confidence: 0.55, reason: 'income-default' };
  const merchant = normalizeMerchant(input.merchant);
  const learned = history.filter((x) => x.merchantNormalized === merchant).sort((a, b) => b.chosenCount - a.chosenCount)[0];
  if (learned?.chosenCount >= 2) {
    const confidence = Math.min(0.98, 0.68 + learned.chosenCount * 0.04 - learned.correctedCount * 0.06);
    return { categoryId: learned.categoryId, confidence, reason: 'personal-history' };
  }
  const rules = [
    [/コンビニ|seven|7 eleven|lawson|ローソン|familymart|ファミリーマート|スーパー|market|restaurant|cafe|coffee|mcdonald|吉野家|すき家|食品/, 'cat-food'],
    [/drug|薬局|マツモトキヨシ|welcia|daiso|ダイソー|ホームセンター/, 'cat-daily'],
    [/jr |鉄道|metro|taxi|タクシー|bus|バス|高速|parking|駐車|suica/, 'cat-transport'],
    [/電気|ガス|水道|utility/, 'cat-utility'],
    [/cinema|映画|game|ゲーム|karaoke|カラオケ/, 'cat-fun']
  ];
  const matched = rules.find(([pattern]) => pattern.test(merchant));
  return matched ? { categoryId: matched[1], confidence: 0.78, reason: 'local-rule' }
    : { categoryId: 'cat-other-expense', confidence: 0.35, reason: 'fallback' };
}

export function duplicateDecision(candidate, existing) {
  if (candidate.kind === 'refund' || existing.kind === 'refund' || candidate.kind !== existing.kind) return 'different';
  if (candidate.sourceEventId && candidate.source === existing.source && candidate.sourceEventId === existing.sourceEventId) return 'exact';
  if (candidate.fingerprint && candidate.fingerprint === existing.fingerprint) return 'exact';
  const timeGap = Math.abs(Date.parse(candidate.occurredAt) - Date.parse(existing.occurredAt));
  const sameAmount = Number(candidate.amount) === Number(existing.amount);
  const sameMerchant = normalizeMerchant(candidate.merchant) === normalizeMerchant(existing.merchant);
  return sameAmount && sameMerchant && timeGap <= 36e5 ? 'suspected' : 'different';
}

export function parseTransactionText(text) {
  const normalized = String(text).normalize('NFKC');
  const amountMatch = normalized.match(/(?:¥|￥|金額[:：]?\s*)?([\d,]+)\s*円?/);
  const dateMatch = normalized.match(/(20\d{2})[\/.年-](\d{1,2})[\/.月-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  const source = [...SOURCE_ALIASES.keys()].find((key) => normalized.toLowerCase().includes(key));
  const lines = normalized.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const merchant = lines.find((line) => !/[\d,]+\s*円|20\d{2}[\/.年-]/.test(line) && !source?.includes(line.toLowerCase())) || '';
  let occurredAt = new Date().toISOString();
  if (dateMatch) occurredAt = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(dateMatch[4] || 12), Number(dateMatch[5] || 0)).toISOString();
  return adaptPayload({ amount: amountMatch ? Number(amountMatch[1].replaceAll(',', '')) : NaN, merchant, occurredAt, source: source || 'text' });
}

export function parseCsv(text, mapping = {}) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i] ?? '\n';
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r' && text[i + 1] !== '\n') && !quoted) { row.push(field); field = ''; if (row.some(Boolean)) rows.push(row); row = []; }
    else if (char !== '\r') field += char;
  }
  if (rows.length < 2) return [];
  const headers = rows.shift().map((x) => x.trim());
  const find = (name, aliases) => mapping[name] ? headers.indexOf(mapping[name]) : headers.findIndex((h) => aliases.includes(h.toLowerCase()));
  const indexes = {
    amount: find('amount', ['amount', '金額', '利用金額']), merchant: find('merchant', ['merchant', '店舗', '店名', '摘要']),
    occurredAt: find('occurredAt', ['date', 'datetime', '日時', '日付', '利用日']), source: find('source', ['source', '決済方法', '支払方法']),
    kind: find('kind', ['kind', '種別'])
  };
  return rows.map((values) => adaptPayload({
    amount: String(values[indexes.amount] || '').replace(/[¥￥,円]/g, ''), merchant: values[indexes.merchant],
    occurredAt: values[indexes.occurredAt], source: values[indexes.source] || 'csv', kind: values[indexes.kind] || 'expense'
  }));
}

export function csvEscape(value) { const s = String(value ?? ''); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
