// Netlify Function: Mercado Libre vuelve acá después de que tocás "Autorizar".
// URL que hay que cargar en tu aplicación de ML como "URI de redirect":
//   https://storgelab.netlify.app/api/ml-callback
//
// Valida el código de un solo uso ("state") que generó el panel, cambia el
// "code" por los tokens, los guarda en Supabase (tabla privada ml_cuenta) y te
// devuelve al panel.

'use strict';

const ml = require('../lib/ml');

function back(ok, msg) {
  const q = ok ? 'ml=ok' : 'ml=error&msg=' + encodeURIComponent(String(msg || 'Error').slice(0, 300));
  return { statusCode: 302, headers: { Location: '/admin.html?' + q, 'Cache-Control': 'no-store' }, body: '' };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (q.error) return back(false, 'Mercado Libre canceló la conexión (' + q.error + ').');
  const code = String(q.code || '');
  const state = String(q.state || '');
  if (!code || !/^[0-9a-f]{48}$/.test(state)) return back(false, 'Faltan datos de Mercado Libre. Probá conectar de nuevo.');
  try {
    const rows = await ml.sb('ml_oauth_estados?estado=eq.' + state + '&select=estado,created_at');
    if (!rows || !rows[0]) return back(false, 'El link de conexión ya se usó o venció. Tocá "Conectar" de nuevo.');
    await ml.sb('ml_oauth_estados?estado=eq.' + state, { method: 'DELETE', prefer: 'return=minimal' });
    if (Date.now() - new Date(rows[0].created_at).getTime() > 20 * 60 * 1000) {
      return back(false, 'El link de conexión venció. Tocá "Conectar" de nuevo.');
    }
    const me = await ml.connectWithCode(code);
    if (me.site_id && me.site_id !== 'MLU') {
      return back(false, 'Conectaste una cuenta de ' + me.site_id + '; tiene que ser una cuenta de Mercado Libre Uruguay.');
    }
    return back(true);
  } catch (e) {
    console.error('[ml-callback]', e);
    return back(false, e.message);
  }
};
