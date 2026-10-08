// Netlify Function: botones de la pestaña "Mercado Libre" del panel admin.
// Solo responde a un usuario con sesión iniciada en el panel (y, si está
// configurada ADMIN_EMAILS, solo a esos mails).
//
// POST /api/ml-admin  { action, ... }
//   status        → ¿está conectada la cuenta? (nickname, modelo de publicación)
//   auth-url      → link para "Conectar con Mercado Libre"
//   disconnect    → borra la conexión (los avisos en ML no se tocan)
//   preview       → { producto_id } arma el aviso y lo valida con ML SIN publicar
//   publish       → { producto_id } publica lo que falte y sincroniza lo que ya está
//   sync          → { producto_id, force? } actualiza precio/stock/estado/descr.
//   refresh       → { producto_id } trae el estado real de los avisos desde ML
//   unlink        → { publicacion_id } desvincula un aviso (no lo borra de ML)

'use strict';

const crypto = require('crypto');
const ml = require('../lib/ml');

const MAX_BODY = 4000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return ml.reply(405, { error: 'Método no permitido.' });
  try {
    await ml.requireAdmin(event);

    let raw = event.body || '';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
    if (raw.length > MAX_BODY) throw new ml.HttpError(413, 'Pedido demasiado grande.');
    let body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { throw new ml.HttpError(400, 'No pudimos leer el pedido.'); }
    const action = String(body.action || '');

    switch (action) {
      case 'status': {
        const acc = await ml.getAccount();
        if (!acc) return ml.reply(200, { conectado: false, redirect_uri: ml.redirectUri() });
        let me = null;
        try {
          const access = await ml.getAccess();
          me = await ml.readMe(access.token);
          if (me.user_products !== acc.user_products || me.nickname !== acc.nickname) {
            await ml.updateAccount({ user_products: me.user_products, nickname: me.nickname });
          }
        } catch (e) {
          return ml.reply(200, { conectado: true, valido: false, nickname: acc.nickname, error: e.message, redirect_uri: ml.redirectUri() });
        }
        return ml.reply(200, {
          conectado: true,
          valido: true,
          nickname: me.nickname,
          site_id: me.site_id,
          user_products: me.user_products,
          redirect_uri: ml.redirectUri(),
        });
      }

      case 'auth-url': {
        const { id } = ml.mlClient();
        const state = crypto.randomBytes(24).toString('hex');
        const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
        await ml.sb('ml_oauth_estados?created_at=lt.' + encodeURIComponent(hourAgo), { method: 'DELETE', prefer: 'return=minimal' });
        await ml.sb('ml_oauth_estados', { method: 'POST', prefer: 'return=minimal', body: { estado: state } });
        const url = ml.ML_AUTH_URL + '?response_type=code' +
          '&client_id=' + encodeURIComponent(id) +
          '&redirect_uri=' + encodeURIComponent(ml.redirectUri()) +
          '&state=' + state;
        return ml.reply(200, { url });
      }

      case 'disconnect': {
        await ml.sb('ml_cuenta?id=eq.1', { method: 'DELETE', prefer: 'return=minimal' });
        return ml.reply(200, { ok: true });
      }

      case 'preview':
        return ml.reply(200, await ml.preview(body.producto_id));

      case 'publish':
        return ml.reply(200, await ml.reconcile(body.producto_id, { create: true, force: !!body.force }));

      case 'sync':
        return ml.reply(200, await ml.reconcile(body.producto_id, { create: false, force: !!body.force }));

      case 'refresh':
        return ml.reply(200, { actualizados: await ml.refreshStatuses(body.producto_id) });

      case 'unlink': {
        if (!ml.UUID_RE.test(String(body.publicacion_id || ''))) throw new ml.HttpError(400, 'Publicación inválida.');
        await ml.sb('ml_publicaciones?id=eq.' + body.publicacion_id, { method: 'DELETE', prefer: 'return=minimal' });
        return ml.reply(200, { ok: true });
      }

      default:
        throw new ml.HttpError(400, 'Acción desconocida.');
    }
  } catch (e) {
    const status = e instanceof ml.HttpError ? e.status : 500;
    if (status >= 500) console.error('[ml-admin]', e);
    return ml.reply(status, { error: e.message || 'Error inesperado.', code: e.code || 'ERROR' });
  }
};
