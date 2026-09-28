import test from 'node:test';import assert from 'node:assert/strict';import worker, { summary } from '../src/worker/index.js';
const env={APP_ENV:'test',ALLOWED_ORIGIN:'https://app.example',INGEST_API_TOKEN:'test-token-'.repeat(3),ASSETS:{fetch:async()=>new Response('asset')}};
test('health API runs through Worker fetch boundary with security headers',async()=>{const r=await worker.fetch(new Request('https://app.example/api/health'),env);assert.equal(r.status,200);assert.equal((await r.json()).ok,true);assert.equal(r.headers.get('x-content-type-options'),'nosniff')});
test('ingestion rejects missing credential before database access',async()=>{const r=await worker.fetch(new Request('https://app.example/api/ingest',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),env);assert.equal(r.status,401);assert.equal((await r.json()).error,'unauthorized')});
test('static request delegates to asset binding',async()=>{const r=await worker.fetch(new Request('https://app.example/'),env);assert.equal(await r.text(),'asset')});
test('CORS only reflects configured exact origin',async()=>{const ok=await worker.fetch(new Request('https://app.example/api/health',{headers:{origin:'https://app.example'}}),env);assert.equal(ok.headers.get('access-control-allow-origin'),'https://app.example');const no=await worker.fetch(new Request('https://app.example/api/health',{headers:{origin:'https://evil.example'}}),env);assert.equal(no.headers.get('access-control-allow-origin'),null)});

test('summary subtracts refunds from expense totals', async () => {
  const db = {
    prepare(sql) {
      return {
        bind() {
          if (sql.includes("CASE WHEN kind='income'")) {
            return { first: async () => ({ income: 10000, expense: 5000, refund: 1000 }) };
          }
          return { all: async () => ({ results: [] }) };
        }
      };
    }
  };
  const response = await summary(db, '2026-08');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    month: '2026-08', income: 10000, expense: 4000, balance: 6000, byCategory: [], byPayment: []
  });
});
