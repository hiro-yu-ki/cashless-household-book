export class D1Repository {
  constructor(db) { this.db = db; }
  async allTransactions(filters = {}) {
    const clauses = ['t.deleted_at IS NULL']; const binds = [];
    if (filters.month) { clauses.push("substr(t.occurred_at,1,7)=?"); binds.push(filters.month); }
    if (filters.status) { clauses.push('t.status=?'); binds.push(filters.status); }
    if (filters.kind) { clauses.push('t.kind=?'); binds.push(filters.kind); }
    if (filters.q) { clauses.push('(t.merchant LIKE ? OR t.note LIKE ?)'); binds.push(`%${filters.q}%`, `%${filters.q}%`); }
    const sql = `SELECT t.*, p.name payment_method_name FROM transactions t LEFT JOIN payment_methods p ON p.id=t.payment_method_id WHERE ${clauses.join(' AND ')} ORDER BY t.occurred_at DESC LIMIT 500`;
    return (await this.db.prepare(sql).bind(...binds).all()).results;
  }
  async existingFor(candidate) {
    const result = await this.db.prepare("SELECT * FROM transactions WHERE deleted_at IS NULL AND ((source=? AND source_event_id=? AND ? IS NOT NULL) OR fingerprint=? OR (amount=? AND merchant_normalized=? AND occurred_at BETWEEN ? AND ?)) LIMIT 10")
      .bind(candidate.source, candidate.sourceEventId, candidate.sourceEventId, candidate.fingerprint, candidate.amount, candidate.merchantNormalized,
        new Date(Date.parse(candidate.occurredAt)-36e5).toISOString(), new Date(Date.parse(candidate.occurredAt)+36e5).toISOString()).all();
    return result.results;
  }
  async merchantHistory(merchantNormalized) {
    return (await this.db.prepare('SELECT merchant_normalized merchantNormalized, category_id categoryId, chosen_count chosenCount, corrected_count correctedCount FROM merchant_history WHERE merchant_normalized=?').bind(merchantNormalized).all()).results;
  }
  async createTransaction(tx, splits) {
    const statements = [this.db.prepare(`INSERT INTO transactions (id,kind,amount,merchant,merchant_normalized,occurred_at,payment_method_id,source,source_event_id,fingerprint,status,confidence,note,raw_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(tx.id,tx.kind,tx.amount,tx.merchant,tx.merchantNormalized,tx.occurredAt,tx.paymentMethodId,tx.source,tx.sourceEventId,tx.fingerprint,tx.status,tx.confidence,tx.note,JSON.stringify(tx.rawPayload || null))];
    for (const split of splits) statements.push(this.db.prepare('INSERT INTO transaction_splits (id,transaction_id,category_id,amount,memo) VALUES (?,?,?,?,?)').bind(split.id,tx.id,split.categoryId,split.amount,split.memo || ''));
    await this.db.batch(statements); return tx;
  }
}
