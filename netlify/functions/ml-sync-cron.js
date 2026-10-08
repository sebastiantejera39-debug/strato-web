// Netlify Scheduled Function: cada hora sincroniza con Mercado Libre los
// productos ya publicados (precio, stock por color, pausar/reactivar y
// descripción). El horario está en netlify.toml.
//
// Empieza por los que hace más tiempo que no se sincronizan y corta a los
// ~22 segundos (el límite de Netlify es 30): lo que no llegue, va en la
// siguiente vuelta.

'use strict';

const ml = require('../lib/ml');

exports.handler = async () => {
  const started = Date.now();
  const deadline = started + 22000;
  try {
    const cfg = await ml.getConfig();
    if (!cfg.sync_auto) return { statusCode: 200, body: 'sync automática apagada' };
    const acc = await ml.getAccount();
    if (!acc) return { statusCode: 200, body: 'sin cuenta conectada' };

    const pubs = (await ml.sb('ml_publicaciones?select=producto_id,ultima_sync&ml_item_id=not.is.null')) || [];
    const oldest = new Map();
    pubs.forEach((p) => {
      const t = p.ultima_sync ? new Date(p.ultima_sync).getTime() : 0;
      if (!oldest.has(p.producto_id) || t < oldest.get(p.producto_id)) oldest.set(p.producto_id, t);
    });
    const ids = Array.from(oldest.keys()).sort((a, b) => oldest.get(a) - oldest.get(b));

    let hechos = 0, actualizados = 0, creados = 0, pausados = 0, errores = 0;
    for (const id of ids) {
      if (Date.now() > deadline - 3000) break;
      try {
        const r = await ml.reconcile(id, { create: false, deadline });
        hechos++;
        actualizados += r.actualizados;
        creados += r.creados;
        pausados += r.pausados;
        errores += r.errores.length;
      } catch (e) {
        errores++;
        console.error('[ml-sync-cron] producto', id, e.message);
        if (e.code === 'RECONNECT' || e.code === 'NOT_CONNECTED') break;
      }
    }
    const resumen = hechos + ' de ' + ids.length + ' productos revisados · ' + actualizados + ' actualizados · ' +
      creados + ' avisos nuevos · ' + pausados + ' pausados' + (errores ? ' · ' + errores + ' con error' : '');
    await ml.sb('ml_config?id=eq.1', {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { ultima_sync_at: new Date().toISOString(), ultima_sync_resumen: resumen },
    });
    return { statusCode: 200, body: resumen };
  } catch (e) {
    console.error('[ml-sync-cron]', e);
    return { statusCode: 500, body: e.message };
  }
};
