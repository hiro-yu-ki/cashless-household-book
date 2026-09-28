import { adaptPayload, classifyTransaction, csvEscape, duplicateDecision, fingerprintOf, normalizeMerchant, parseCsv, validateTransaction } from '../domain/core.js';
import { D1Repository } from '../domain/repository.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const error = (message, status = 400, details) => json({ error: message, details }, status);
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function cors(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((x) => x.trim());
  return allowed.includes(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', vary: 'Origin' } : {};
}

function authorized(request, env, external = false) {
  if (!external && !request.headers.get('origin')) return true;
  const expected = env.INGEST_API_TOKEN;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return external ? Boolean(expected && token && token.length >= 24 && timingSafe(token, expected)) : true;
}
function timingSafe(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i); return diff === 0; }

async function body(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 1_000_000) throw new Error('payload too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 1_000_000) throw new Error('payload too large');
  try { return JSON.parse(text); } catch { throw new Error('invalid JSON'); }
}

async function ingest(request, env, forcedSource) {
  if (!authorized(request, env, true)) return error('unauthorized', 401);
  const payload = await body(request); const input = adaptPayload(payload, forcedSource);
  const errors = validateTransaction(input); if (errors.length) return error('validation failed', 422, errors);
  const repo = new D1Repository(env.DB); const merchantNormalized = normalizeMerchant(input.merchant);
  const candidate = { ...input, merchantNormalized, fingerprint: await fingerprintOf(input) };
  const matches = await repo.existingFor(candidate);
  const decision = matches.map((x) => duplicateDecision(candidate, { ...x, occurredAt:x.occurred_at, sourceEventId:x.source_event_id })).find((x) => x === 'exact') ||
    matches.map((x) => duplicateDecision(candidate, { ...x, occurredAt:x.occurred_at, sourceEventId:x.source_event_id })).find((x) => x === 'suspected');
  if (decision === 'exact') return json({ duplicate: true, transactionId: matches[0]?.id }, 200);
  const prediction = classifyTransaction(input, await repo.merchantHistory(merchantNormalized));
  const status = decision === 'suspected' ? 'duplicate_suspected' : prediction.confidence >= 0.82 ? 'confirmed' : 'inbox';
  const tx = { ...candidate, id:id('tx'), status, confidence:prediction.confidence };
  const splits = input.splits || [{ id:id('split'), categoryId:prediction.categoryId, amount:input.amount }];
  await repo.createTransaction(tx, splits.map((s) => ({ id:s.id || id('split'), ...s })));
  console.log(JSON.stringify({ event:'transaction_ingested', id:tx.id, source:tx.source, status, confidence:tx.confidence }));
  return json({ transaction:{ ...tx, rawPayload:undefined }, prediction, duplicate:decision === 'suspected' }, 201);
}

async function createOrUpdateTransaction(request, env, transactionId, createId) {
  const input = adaptPayload(await body(request)); const errors = validateTransaction(input);
  if (errors.length) return error('validation failed', 422, errors);
  const txId = transactionId || createId || id('tx'); const normalized = normalizeMerchant(input.merchant); const fingerprint = await fingerprintOf(input);
  const splits = input.splits || [];
  if (transactionId) {
    const statements = [env.DB.prepare(`UPDATE transactions SET kind=?,amount=?,merchant=?,merchant_normalized=?,occurred_at=?,payment_method_id=?,note=?,fingerprint=?,status='confirmed',updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL`).bind(input.kind,input.amount,input.merchant,normalized,input.occurredAt,input.paymentMethodId,input.note,fingerprint,txId), env.DB.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').bind(txId)];
    for (const s of splits) statements.push(env.DB.prepare('INSERT INTO transaction_splits (id,transaction_id,category_id,amount,memo) VALUES (?,?,?,?,?)').bind(id('split'),txId,s.categoryId,s.amount,s.memo || ''));
    await env.DB.batch(statements); await learn(env.DB, txId, normalized, splits); return json({ id:txId });
  }
  const prediction = classifyTransaction(input, []); const chosen = splits.length ? splits : [{categoryId:prediction.categoryId,amount:input.amount}];
  await new D1Repository(env.DB).createTransaction({ ...input,id:txId,merchantNormalized:normalized,fingerprint,status:'confirmed',confidence:splits.length?1:prediction.confidence }, chosen.map((s)=>({id:id('split'),...s})));
  await learn(env.DB, txId, normalized, chosen); return json({ id:txId }, 201);
}

async function learn(db, txId, merchant, splits) {
  for (const split of splits) await db.prepare(`INSERT INTO merchant_history (merchant_normalized,category_id,chosen_count,last_used_at) VALUES (?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(merchant_normalized,category_id) DO UPDATE SET chosen_count=chosen_count+1,last_used_at=CURRENT_TIMESTAMP`).bind(merchant,split.categoryId).run();
  if (splits[0]) await db.prepare('INSERT INTO classification_feedback (id,transaction_id,merchant_normalized,chosen_category_id) VALUES (?,?,?,?)').bind(id('feedback'),txId,merchant,splits[0].categoryId).run();
}

async function route(request, env) {
  const url = new URL(request.url); const path = url.pathname; const method = request.method;
  if (method === 'OPTIONS') return new Response(null, { status:204, headers:cors(request,env) });
  if (path === '/api/health') return json({ok:true,version:'1.0.0'});
  if (path === '/api/ingest' && method === 'POST') return ingest(request,env);
  const shortcut = path.match(/^\/api\/ingest\/(shortcuts|wallet|paypay|suica|aeonpay|credit-card)$/);
  if (shortcut && method === 'POST') return ingest(request,env,shortcut[1].replace('credit-card','credit_card'));
  if (path === '/api/transactions' && method === 'GET') return json({items:await new D1Repository(env.DB).allTransactions(Object.fromEntries(url.searchParams))});
  if (path === '/api/transactions' && method === 'POST') return createOrUpdateTransaction(request,env);
  const txMatch = path.match(/^\/api\/transactions\/([^/]+)$/);
  if (txMatch && method === 'PUT') return createOrUpdateTransaction(request,env,txMatch[1]);
  if (txMatch && method === 'DELETE') { await env.DB.prepare('UPDATE transactions SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(txMatch[1]).run(); return new Response(null,{status:204}); }
  if (path === '/api/meta' && method === 'GET') {
    const [categories,payments] = await Promise.all([env.DB.prepare('SELECT * FROM categories WHERE archived=0 ORDER BY kind,name').all(),env.DB.prepare('SELECT * FROM payment_methods WHERE archived=0 ORDER BY name').all()]);
    return json({categories:categories.results,paymentMethods:payments.results});
  }
  const entityMatch = path.match(/^\/api\/(categories|payment-methods)(?:\/([^/]+))?$/);
  if (entityMatch) return entityCrud(request,env,entityMatch[1],entityMatch[2]);
  if (path === '/api/budgets' && method === 'GET') return json({items:(await env.DB.prepare('SELECT * FROM budgets WHERE month=?').bind(url.searchParams.get('month')).all()).results});
  if (path === '/api/budgets' && method === 'POST') { const x=await body(request); if(!/^\d{4}-\d{2}$/.test(x.month)||!x.categoryId||!Number.isSafeInteger(Number(x.amount))||x.amount<0)return error('invalid budget',422); await env.DB.prepare(`INSERT INTO budgets(id,month,category_id,amount) VALUES(?,?,?,?) ON CONFLICT(month,category_id) DO UPDATE SET amount=excluded.amount`).bind(id('budget'),x.month,x.categoryId,x.amount).run(); return json({ok:true},201); }
  if (path === '/api/summary' && method === 'GET') return summary(env.DB,url.searchParams.get('month')||new Date().toISOString().slice(0,7));
  if (path === '/api/import/csv/preview' && method === 'POST') {
    const x=await body(request); const items=parseCsv(x.csv,x.mapping).slice(0,200); const repo=new D1Repository(env.DB); const duplicates=[];
    for(let n=0;n<items.length;n++){const item=items[n];if(validateTransaction(item).length)continue;const candidate={...item,merchantNormalized:normalizeMerchant(item.merchant),fingerprint:await fingerprintOf(item)};const matches=await repo.existingFor(candidate);const decision=matches.map(m=>duplicateDecision(candidate,{...m,occurredAt:m.occurred_at,sourceEventId:m.source_event_id})).find(d=>d!=='different');if(decision)duplicates.push({row:n+2,decision,transactionId:matches[0]?.id});}
    return json({items,errors:items.map((i,n)=>({row:n+2,errors:validateTransaction(i)})).filter(x=>x.errors.length),duplicates});
  }
  if (path === '/api/export.csv' && method === 'GET') return exportCsv(env.DB);
  if (path === '/api/backup' && method === 'GET') return backup(env.DB);
  if (path === '/api/restore' && method === 'POST') return restore(env.DB,await body(request));
  if (path === '/api/sync' && method === 'POST') return sync(env.DB,await body(request));
  return error('not found',404);
}

async function entityCrud(request,env,type,entityId) {
  const category = type==='categories'; const table=category?'categories':'payment_methods';
  if(request.method==='POST'){const x=await body(request);if(!x.name||String(x.name).length>50)return error('invalid name',422);const newId=id(category?'cat':'pm'); if(category)await env.DB.prepare('INSERT INTO categories(id,name,kind,parent_id,color,icon) VALUES(?,?,?,?,?,?)').bind(newId,x.name,x.kind||'expense',x.parentId||null,x.color||'#64748b',x.icon||'tag').run();else await env.DB.prepare('INSERT INTO payment_methods(id,name,type) VALUES(?,?,?)').bind(newId,x.name,x.type||'other').run();return json({id:newId},201);}
  if(entityId&&request.method==='PUT'){const x=await body(request);if(!x.name)return error('invalid name',422);await env.DB.prepare(`UPDATE ${table} SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(x.name,entityId).run();return json({id:entityId});}
  if(entityId&&request.method==='DELETE'){await env.DB.prepare(`UPDATE ${table} SET archived=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(entityId).run();return new Response(null,{status:204});}
  return error('method not allowed',405);
}

export async function summary(db,month){
  const totals=(await db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='income' THEN amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN kind='expense' THEN amount ELSE 0 END),0) expense,COALESCE(SUM(CASE WHEN kind='refund' THEN amount ELSE 0 END),0) refund FROM transactions WHERE deleted_at IS NULL AND status='confirmed' AND substr(occurred_at,1,7)=?`).bind(month).first());
  const byCategory=(await db.prepare(`SELECT c.id,c.name,c.color,SUM(s.amount) amount FROM transaction_splits s JOIN transactions t ON t.id=s.transaction_id JOIN categories c ON c.id=s.category_id WHERE t.deleted_at IS NULL AND t.status='confirmed' AND t.kind='expense' AND substr(t.occurred_at,1,7)=? GROUP BY c.id ORDER BY amount DESC`).bind(month).all()).results;
  const byPayment=(await db.prepare(`SELECT COALESCE(p.name,'未設定') name,SUM(t.amount) amount FROM transactions t LEFT JOIN payment_methods p ON p.id=t.payment_method_id WHERE t.deleted_at IS NULL AND t.status='confirmed' AND t.kind='expense' AND substr(t.occurred_at,1,7)=? GROUP BY p.id ORDER BY amount DESC`).bind(month).all()).results;
  return json({month, income:totals.income,expense:totals.expense-totals.refund,balance:totals.income-totals.expense+totals.refund,byCategory,byPayment});
}
async function exportCsv(db){const rows=(await db.prepare(`SELECT t.occurred_at,t.kind,t.amount,t.merchant,p.name payment_method,t.status,t.note,GROUP_CONCAT(c.name||':'||s.amount,' / ') categories FROM transactions t LEFT JOIN payment_methods p ON p.id=t.payment_method_id LEFT JOIN transaction_splits s ON s.transaction_id=t.id LEFT JOIN categories c ON c.id=s.category_id WHERE t.deleted_at IS NULL GROUP BY t.id ORDER BY t.occurred_at`).all()).results;const cols=['occurred_at','kind','amount','merchant','payment_method','status','note','categories'];const text='\ufeff'+[cols.join(','),...rows.map(r=>cols.map(c=>csvEscape(r[c])).join(','))].join('\r\n');return new Response(text,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="cashless-book.csv"'}});}
async function backup(db){const tables=['categories','payment_methods','transactions','transaction_splits','budgets','merchant_history','classification_feedback'];const data={version:1,exportedAt:new Date().toISOString(),tables:{}};for(const t of tables)data.tables[t]=(await db.prepare(`SELECT * FROM ${t}`).all()).results;return json(data);}
async function restore(db,data){if(data?.version!==1||!data.tables)return error('unsupported backup',422);const allowed={categories:['id','name','kind','parent_id','color','icon','archived','created_at','updated_at'],payment_methods:['id','name','type','archived','created_at','updated_at'],transactions:['id','kind','amount','merchant','merchant_normalized','occurred_at','payment_method_id','source','source_event_id','fingerprint','status','confidence','note','raw_payload','deleted_at','created_at','updated_at'],transaction_splits:['id','transaction_id','category_id','amount','memo'],budgets:['id','month','category_id','amount'],merchant_history:['merchant_normalized','category_id','chosen_count','corrected_count','last_used_at'],classification_feedback:['id','transaction_id','merchant_normalized','predicted_category_id','chosen_category_id','created_at']};let count=0;for(const [table,cols] of Object.entries(allowed)){for(const row of data.tables[table]||[]){await db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).bind(...cols.map(c=>row[c]??null)).run();count++;}}return json({restored:count});}
async function sync(db,x){if(!x.deviceId||!Array.isArray(x.operations)||x.operations.length>500)return error('invalid sync payload',422);let applied=0;for(const op of x.operations){if(!op.id||!['upsert','delete'].includes(op.operation))continue;const exists=await db.prepare('SELECT id FROM sync_operations WHERE device_id=? AND id=?').bind(x.deviceId,op.id).first();if(exists)continue;if(op.entityType==='transaction'&&op.operation==='upsert')await createOrUpdateTransaction(new Request('http://local',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(op.data)}),{DB:db},undefined,op.entityId);else if(op.entityType==='transaction'&&op.operation==='delete')await db.prepare('UPDATE transactions SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').bind(op.entityId).run();await db.prepare('INSERT INTO sync_operations(id,device_id,entity_type,entity_id,operation,client_updated_at) VALUES(?,?,?,?,?,?)').bind(op.id,x.deviceId,op.entityType,op.entityId,op.operation,op.clientUpdatedAt||new Date().toISOString()).run();applied++;}return json({applied,serverTime:new Date().toISOString()});}

export default { async fetch(request,env){try{const url=new URL(request.url);if(url.pathname.startsWith('/api/')){const response=await route(request,env);const headers=new Headers(response.headers);for(const [k,v] of Object.entries(cors(request,env)))headers.set(k,v);headers.set('x-content-type-options','nosniff');headers.set('referrer-policy','no-referrer');return new Response(response.body,{status:response.status,headers});}return env.ASSETS.fetch(request);}catch(e){console.error(JSON.stringify({event:'request_error',message:e.message,stack:env.APP_ENV==='development'?e.stack:undefined}));return error(e.message==='payload too large'?e.message:'internal error',e.message==='payload too large'?413:500);}}};
