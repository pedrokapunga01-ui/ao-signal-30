async function iniciar() {
  if (!DATABASE_URL) throw new Error('Configura DATABASE_URL no servidor.');
  if (!BOT_TOKEN) throw new Error('Configura BOT_TOKEN no servidor.');
  if (!CHAT_ID) throw new Error('Configura CHAT_ID no servidor.');

  const tick = require('./bot/tick');
  const tg = require('./bot/telegram');
  const db = require('./bot/db');
  const mig = require('./bot/migrate');

  bot = {
    tickAndSnapshot: tick.tickAndSnapshot,
    telegramConfigurado: tg.telegramConfigurado,
    getSql: db.getSql,
    closeDb: db.closeDb
  };

  await mig.migrate();
  console.log('[DB] Tabelas verificadas');

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Servidor iniciado na porta ${PORT}`);
  });

  if (KEEP_ALIVE_URLS.length) {
    keepAliveTimer = setInterval(() => {
      keepAliveTick().catch(() => {});
    }, KEEP_ALIVE_MS);
    if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
  }

  setTimeout(() => keepAliveTick().catch(() => {}), 12000);

  ciclo();
  console.log('[BOT] CAPUNGA DADOS iniciado');
}