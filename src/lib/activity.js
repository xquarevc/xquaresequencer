const { run, now } = require('../db');
function log(userId, action, entity, entityId, detail, ip) {
  try {
    run('INSERT INTO activity_logs (user_id, action, entity, entity_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)',
      userId ?? null, action, entity ?? null, entityId ?? null,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), ip ?? null, now());
  } catch (e) { console.error('activity log failed', e.message); }
}
module.exports = { log };
