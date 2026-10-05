const express = require('express');
const path = require('path');
const config = require('./config');
const { auth } = require('./lib/http');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });

  // Public routes first (Stripe needs the raw body, so it must precede express.json)
  app.use(require('./routes/public'));
  app.use('/api', (req, res, next) => (req.is('text/csv') ? next() : express.json({ limit: '2mb' })(req, res, next)));
  app.use('/api', require('./routes/auth'));
  app.use('/api', auth, require('./routes/resources'));
  app.use('/api', auth, require('./routes/outreach'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.prod ? '1h' : 0 }));

  app.use((err, req, res, next) => { // eslint-disable-line
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && config.prod ? 'Internal error' : err.message });
  });
  return app;
}
module.exports = { createApp };
