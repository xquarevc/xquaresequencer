const config = require('./config');
const { createApp } = require('./app');
const engine = require('./services/engine');

const app = createApp();
app.listen(config.port, () => {
  console.log(`XquareSequencer listening on ${config.baseUrl} (send mode: ${config.sendMode})`);
  if (config.secret.startsWith('dev-insecure')) console.warn('! Using the insecure dev APP_SECRET. Set APP_SECRET before deploying.');
  engine.start();
});
