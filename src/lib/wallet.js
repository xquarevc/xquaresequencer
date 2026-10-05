const { one, run, tx, now } = require('../db');

class InsufficientFunds extends Error {
  constructor() { super('Insufficient wallet balance'); this.status = 402; }
}
function balance(userId) { return one('SELECT balance_micros b FROM users WHERE id=?', userId)?.b ?? 0; }

function credit(userId, micros, description, ref) {
  if (!(micros > 0)) throw new Error('amount must be positive');
  return tx(() => {
    run('UPDATE users SET balance_micros = balance_micros + ? WHERE id=?', micros, userId);
    const bal = balance(userId);
    run('INSERT INTO wallet_transactions (user_id,type,amount_micros,balance_after_micros,description,ref,created_at) VALUES (?,?,?,?,?,?,?)',
      userId, 'credit', micros, bal, description, ref ?? null, now());
    return bal;
  });
}
function debit(userId, micros, description, ref) {
  if (!(micros > 0)) return balance(userId);
  return tx(() => {
    const r = run('UPDATE users SET balance_micros = balance_micros - ? WHERE id=? AND balance_micros >= ?', micros, userId, micros);
    if (r.changes === 0) throw new InsufficientFunds();
    const bal = balance(userId);
    run('INSERT INTO wallet_transactions (user_id,type,amount_micros,balance_after_micros,description,ref,created_at) VALUES (?,?,?,?,?,?,?)',
      userId, 'debit', micros, bal, description, ref ?? null, now());
    return bal;
  });
}
module.exports = { balance, credit, debit, InsufficientFunds };
