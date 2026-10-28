const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp } = require('./ayudas');
const { hashCodigo } = require('../src/utils/credenciales');

let api, pool, cerrar, M, Modulos, tokens;
const CLAVE = 'clave-larga-1';
let n = 0;
const doc = () => `TST01-DOC${String(++n).padStart(5, '0')}`; // ID_Global de un documento de origen

// Receptor de prueba del módulo Stock.
const aplicados = [];
let tecnico = null; // si es un Error, el receptor falla con él
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  M = require('../src/mensajeria/servicio');
  Modulos = require('../src/modulos/registro');
  M.registrarReceptor('stock', 'descuento', async (conn, c, ctx) => {
    if (tecnico) throw tecnico;
    if (c.rechazar) throw new M.RechazoNegocio(c.rechazar);
    aplicados.push(ctx.idOperacion);
    return { importe: c.importe ?? 0 };
  });
  M.registrarReceptor('stock', 'reversa_descuento', async (conn, c, ctx) => { aplicados.push(ctx.idOperacion); return {}; }, { revierte: 'descuento' });

  const crear = async (u, rolCodigo, pin) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol, pin_hash) VALUES (?, ?, ?, ?)', [u, await bcrypt.hash(CLAVE, 4), rolCodigo === 'administrador' ? 'admin' : 'empleado', pin ? hashCodigo(pin) : null]);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rolCodigo]);
  };
  await crear('admin1', 'administrador', '1111'); await crear('gere', 'gerente', '2222'); await crear('caja', 'cajero');
  const entrar = async (u) => (await api('POST', '/api/auth/login', { body: { username: u, password: CLAVE } })).json.token;
  tokens = { admin: await entrar('admin1'), gerente: await entrar('gere'), cajero: await entrar('caja') };
});
after(async () => { await cerrar(); });

// Emite un mensaje dentro de una transacción local del documento, como lo haría Ventas.
const emitir = async (docId, { tipo = 'descuento', secuencia = 1, contenido = {}, commit = true } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await M.publicar(conn, { origen: 'ventas', destino: 'stock', tipo, docTipo: 'venta', docIdGlobal: docId, secuencia, contenido });
    if (commit) await conn.commit(); else await conn.rollback();
    return r;
  } finally { conn.release(); }
};
const msg = async (docId, tipo = 'descuento') => (await pool.query('SELECT * FROM mensajes_integracion WHERE doc_id_global = ? AND tipo = ?', [docId, tipo]))[0][0];
const entregar = async () => M.procesarPendientes();
// La entrega inmediata (despertar) corre en segundo plano: se espera a que termine.
const esperar = async (docId, tipo = 'descuento') => {
  for (let i = 0; i < 50; i++) {
    const m = await msg(docId, tipo);
    if (m.estado !== 'enviado' && m.estado !== 'pendiente') return m;
    await new Promise((res) => setTimeout(res, 20));
  }
  return msg(docId, tipo);
};
const adelantar = (docId) => pool.query('UPDATE mensajes_integracion SET proximo_intento_ms = 0 WHERE doc_id_global = ? AND estado = \'pendiente\' AND retenido_por_orden = 0', [docId]);

test('Usuarios.RN50/EX36: el mensaje se graba con el documento: si la transacción se revierte, no existe', async () => {
  const d1 = doc();
  await emitir(d1, { commit: false });
  assert.equal(await msg(d1), undefined);
  const d2 = doc();
  const r = await emitir(d2);
  assert.equal(r.idOperacion, `ventas:descuento:${d2}:1`);
  const m = await msg(d2);
  assert.equal(m.estado, 'pendiente');
  assert.ok(m.config_version >= 0 && JSON.parse(m.config_instantanea).length > 0); // RN49: lleva la versión y las funciones
  assert.deepEqual((await M.estadoIntegracion(d2)).estado, 'parcial');
});

test('Usuarios.RF25: si el módulo receptor no está instalado, el efecto no existe y no se genera mensaje', async () => {
  await Modulos.desinstalar('stock');
  const d = doc();
  assert.equal(await emitir(d), null);
  assert.equal(await msg(d), undefined);
  await Modulos.instalar('stock');
});

test('Usuarios.RN59: se entrega y se confirma en menos de 2 segundos; el estado de integración queda Completa', async () => {
  const d = doc();
  await emitir(d, { contenido: { importe: 10 } });
  const t0 = Date.now();
  await entregar();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal((await msg(d)).estado, 'confirmado');
  assert.equal((await M.estadoIntegracion(d)).estado, 'completa');
  assert.ok(aplicados.includes(`ventas:descuento:${d}:1`));
});

test('Usuarios.RN51/EX34: un duplicado se aplica una sola vez y responde el resultado original', async () => {
  const d = doc();
  await emitir(d);
  await emitir(d); // misma ID_Operacion: no crea otro mensaje
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM mensajes_integracion WHERE doc_id_global = ?', [d]))[0][0].n, 1);
  await entregar();
  const veces = () => aplicados.filter((a) => a.includes(d)).length;
  assert.equal(veces(), 1);
  // Reenvío forzado: el receptor deduplica por ID_Operacion (EX39).
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', proximo_intento_ms = 0, confirmado_ms = NULL WHERE doc_id_global = ?", [d]);
  await entregar();
  assert.equal(veces(), 1);
  assert.equal((await msg(d)).estado, 'confirmado');
});

test('Usuarios.RN52/EX32: un rechazo de negocio no se reintenta, va a la bandeja y no revierte el documento', async () => {
  const d = doc();
  await emitir(d, { contenido: { rechazar: 'Artículo dado de baja' } });
  await entregar();
  const m = await msg(d);
  assert.equal(m.estado, 'rechazado');
  assert.equal(m.motivo_rechazo, 'Artículo dado de baja');
  assert.equal(m.intentos, 0);
  assert.deepEqual(await entregar(), []); // no se vuelve a intentar
  const [[b]] = await pool.query('SELECT * FROM bandeja_pendientes WHERE mensaje_id = ?', [m.id]);
  assert.equal(b.estado, 'abierto');
  assert.equal(b.causa, 'rechazado');
  // RN85: los efectos hacia Stock son del módulo Stock y el rol Depósito, con 24 horas de plazo.
  assert.equal(b.modulo_responsable, 'stock');
  assert.equal(b.rol_responsable, 'deposito');
  assert.equal(Number(b.limite_ms) - Number(b.ingreso_ms), 24 * 3600000);
  assert.equal((await M.estadoIntegracion(d)).estado, 'parcial');
  // Los rechazos abiertos se resumen en una alerta media (RN60).
  const [alertas] = await pool.query("SELECT severidad, estado FROM notificaciones WHERE clave = 'rechazos-abiertos'");
  assert.deepEqual(alertas.map((a) => [a.severidad, a.estado]), [['media', 'nueva']]);
});

test('Usuarios.RN52/EX31/EX33: los errores técnicos se reintentan con espera creciente y a las 24 h pasa a Fallido con alerta crítica', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((i) => M.proximoIntento(i, 0)), [5000, 30000, 120000, 600000, 600000, 600000]);

  const d = doc();
  await emitir(d);
  tecnico = new Error('módulo caído');
  await entregar();
  let m = await msg(d);
  assert.equal(m.estado, 'pendiente');
  assert.equal(m.intentos, 1);
  assert.ok(Number(m.proximo_intento_ms) > Date.now()); // todavía no le toca
  assert.deepEqual(await entregar(), []);
  assert.equal((await M.estadoIntegracion(d)).estado, 'parcial'); // EX31: el documento sigue confirmado, con el efecto pendiente

  await adelantar(d); await entregar();
  assert.equal((await msg(d)).intentos, 2);

  // Pasadas 24 horas desde el primer intento, se agota.
  await pool.query('UPDATE mensajes_integracion SET primer_intento_ms = ? WHERE doc_id_global = ?', [Date.now() - 25 * 3600000, d]);
  await adelantar(d); await entregar();
  m = await msg(d);
  assert.equal(m.estado, 'fallido');
  const [[crit]] = await pool.query("SELECT severidad, estado, roles_destinatarios FROM notificaciones WHERE clave = ?", [`mensaje-fallido:${m.id_operacion}`]);
  assert.equal(crit.severidad, 'critica');
  assert.equal(crit.estado, 'nueva');

  // Reintento manual (RN53): conserva la ID_Operacion, reinicia la secuencia; al confirmarse la alerta se resuelve sola.
  tecnico = null;
  const [[b]] = await pool.query("SELECT id FROM bandeja_pendientes WHERE mensaje_id = ? AND estado = 'abierto'", [m.id]);
  const r = await api('POST', `/api/integracion/pendientes/${b.id}/reintentar`, { token: tokens.gerente });
  assert.equal(r.status, 200);
  assert.equal((await api('POST', `/api/integracion/pendientes/${b.id}/reintentar`, { token: tokens.cajero })).status, 403);
  await new Promise((res) => setTimeout(res, 50));
  await entregar();
  m = await msg(d);
  assert.equal(m.estado, 'confirmado');
  assert.equal(m.intentos, 0);
  const [[despues]] = await pool.query('SELECT estado FROM notificaciones WHERE clave = ?', [`mensaje-fallido:${m.id_operacion}`]);
  assert.equal(despues.estado, 'resuelta');
});

test('Usuarios.RN54/EX35: una reversa nunca se aplica antes que su original: queda "Retenida por orden" hasta que la original se confirme', async () => {
  const d = doc();
  await emitir(d, { tipo: 'descuento', secuencia: 1, contenido: { rechazar: 'sin stock configurado' } });
  await emitir(d, { tipo: 'reversa_descuento', secuencia: 2 });
  await entregar();
  const original = await msg(d, 'descuento');
  const reversa = await msg(d, 'reversa_descuento');
  assert.equal(original.estado, 'rechazado');
  assert.equal(reversa.retenido_por_orden, 1);
  assert.ok(!aplicados.includes(reversa.id_operacion));
  assert.equal((await M.estadoIntegracion(d)).efectos.find((e) => e.tipo === 'reversa_descuento').estado, 'retenido_por_orden');

  // Se corrige la original y se reintenta: al confirmarse se libera la reversa y se aplica después.
  await pool.query("UPDATE mensajes_integracion SET contenido = '{}' WHERE id = ?", [original.id]);
  const [[b]] = await pool.query("SELECT id FROM bandeja_pendientes WHERE mensaje_id = ? AND estado = 'abierto'", [original.id]);
  await M.reintentar(b.id, { id: 1, username: 'admin1' });
  await new Promise((res) => setTimeout(res, 20));
  await entregar();
  assert.equal((await msg(d, 'descuento')).estado, 'confirmado');
  await entregar();
  assert.equal((await msg(d, 'reversa_descuento')).estado, 'confirmado');
  assert.ok(aplicados.indexOf(original.id_operacion) < aplicados.indexOf(reversa.id_operacion));
});

test('Usuarios.RN53/EX40: el descarte exige motivo y la autorización de otro usuario; el mensaje conserva su estado', async () => {
  const d = doc();
  await emitir(d, { contenido: { rechazar: 'no aplica' } });
  await entregar();
  const m = await msg(d);
  const [[b]] = await pool.query("SELECT id FROM bandeja_pendientes WHERE mensaje_id = ? AND estado = 'abierto'", [m.id]);
  const descartar = (token, body) => api('POST', `/api/integracion/pendientes/${b.id}/descartar`, { token, body });

  assert.equal((await descartar(tokens.cajero, { motivo: 'x' })).status, 403); // sin permiso
  const sinAut = await descartar(tokens.gerente, { motivo: 'prueba' });
  assert.equal(sinAut.status, 403);
  assert.equal(sinAut.json.codigo, 'REQUIERE_AUTORIZACION');
  const propia = await descartar(tokens.gerente, { motivo: 'prueba', autorizacion: { credencial: '2222' } }); // su propio PIN
  assert.equal(propia.json.codigo, 'AUTORIZACION_INVALIDA');
  const sinMotivo = await descartar(tokens.gerente, { autorizacion: { credencial: '1111' } });
  assert.equal(sinMotivo.status, 400);
  assert.equal((await pool.query('SELECT estado FROM bandeja_pendientes WHERE id = ?', [b.id]))[0][0].estado, 'abierto');

  const ok = await descartar(tokens.gerente, { motivo: 'artículo discontinuado', autorizacion: { credencial: '1111' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const [[despues]] = await pool.query('SELECT * FROM bandeja_pendientes WHERE id = ?', [b.id]);
  assert.equal(despues.estado, 'descartado');
  assert.equal(despues.motivo_descarte, 'artículo discontinuado');
  assert.ok(despues.autorizante_id);
  const conservado = await msg(d);
  assert.equal(conservado.estado, 'rechazado');
  assert.equal(conservado.descartado, 1);
  const integ = await M.estadoIntegracion(d);
  assert.equal(integ.estado, 'parcial');
  assert.equal(integ.efectos[0].estado, 'descartado');
  const [aud] = await pool.query("SELECT detalle FROM auditoria WHERE accion = 'descarte' ORDER BY id DESC LIMIT 1");
  assert.match(aud[0].detalle, /artículo discontinuado; autorizó admin1/);
});

test('Usuarios.RN85: un pendiente vencido se escala al Administrador con una notificación', async () => {
  const d = doc();
  await emitir(d, { contenido: { rechazar: 'x' } });
  await entregar();
  const m = await msg(d);
  await pool.query('UPDATE bandeja_pendientes SET limite_ms = 1 WHERE mensaje_id = ?', [m.id]);
  assert.ok((await M.escalarVencidos()) >= 1);
  const [[b]] = await pool.query('SELECT vencido, escalada_ms FROM bandeja_pendientes WHERE mensaje_id = ?', [m.id]);
  assert.equal(b.vencido, 1);
  assert.ok(b.escalada_ms);
  const [alertas] = await pool.query("SELECT roles_destinatarios FROM notificaciones WHERE tipo = 'pendiente_vencido'");
  assert.ok(alertas.every((a) => a.roles_destinatarios === ',administrador,'));
  assert.equal(await M.escalarVencidos(), 0); // no se escala dos veces
});

test('Usuarios.RN57/EX38: la conciliación lista las diferencias, genera alerta alta y no corrige sola', async () => {
  const d = doc();
  await emitir(d, { contenido: { importe: 100 } });
  await entregar();
  const m = await msg(d);
  // Un efecto confirmado sin que el receptor tenga su registro, y un efecto aplicado sin mensaje de origen (tras una restauración).
  await pool.query('DELETE FROM operaciones_procesadas WHERE id_operacion = ?', [m.id_operacion]);
  await pool.query("INSERT INTO operaciones_procesadas (id_operacion, modulo_receptor, doc_id_global, ts_ms, resultado, vence_ms) VALUES ('ventas:descuento:TST01-HUERFANO:1', 'stock', 'TST01-HUERFANO', ?, '{}', ?)", [Date.now(), Date.now() + 1e9]);

  const r = await api('POST', '/api/integracion/conciliar', { token: tokens.gerente });
  assert.equal(r.status, 200);
  const tipos = r.json.diferencias.map((x) => x.tipo);
  assert.ok(tipos.includes('efecto_faltante') && tipos.includes('efecto_sin_origen'));
  const [[alerta]] = await pool.query("SELECT severidad FROM notificaciones WHERE clave = 'conciliacion-diferencias'");
  assert.equal(alerta.severidad, 'alta');
  assert.equal((await msg(d)).estado, 'confirmado'); // no corrigió nada
  assert.equal((await api('POST', '/api/integracion/conciliar', { token: tokens.cajero })).status, 403);
  // Una segunda corrida no repite las diferencias ya abiertas.
  assert.equal((await api('POST', '/api/integracion/conciliar', { token: tokens.gerente })).json.diferencias.length, 0);
});

test('Usuarios.RN58/EX39: el Administrador reenvía los Confirmados desde una fecha y el receptor solo aplica lo que no tenía', async () => {
  const d = doc();
  await emitir(d);
  await entregar();
  const antes = aplicados.filter((a) => a.includes(d)).length;
  assert.equal((await api('POST', '/api/integracion/reenviar', { token: tokens.gerente, body: { desde: '2000-01-01' } })).status, 403);
  assert.equal((await api('POST', '/api/integracion/reenviar', { token: tokens.admin, body: { desde: 'nada' } })).status, 400);
  const r = await api('POST', '/api/integracion/reenviar', { token: tokens.admin, body: { desde: new Date(Date.now() - 86400000).toISOString() } });
  assert.equal(r.status, 200);
  assert.ok(r.json.reenviados >= 1);
  await new Promise((res) => setTimeout(res, 50));
  await entregar();
  assert.equal((await esperar(d)).estado, 'confirmado');
  assert.equal(aplicados.filter((a) => a.includes(d)).length, antes);
});

test('Usuarios.RN58: los Confirmados se archivan a los 30 días sin borrarse', async () => {
  const d = doc();
  await emitir(d);
  await entregar();
  await pool.query('UPDATE mensajes_integracion SET confirmado_ms = ? WHERE doc_id_global = ?', [Date.now() - 31 * 86400000, d]);
  const r = await M.archivarConfirmados();
  assert.ok(r.archivados >= 1);
  const m = await msg(d);
  assert.equal(m.archivado, 1);
  assert.equal(m.estado, 'confirmado');
});

test('Usuarios.RF17: cada persona ve las alertas de sus roles, y las marca leídas o resueltas', async () => {
  const gerente = (await api('GET', '/api/notificaciones', { token: tokens.gerente })).json;
  const cajero = (await api('GET', '/api/notificaciones', { token: tokens.cajero })).json;
  const admin = (await api('GET', '/api/notificaciones', { token: tokens.admin })).json;
  assert.equal(cajero.notificaciones.length, 0);
  assert.ok(gerente.notificaciones.length > 0 && gerente.notificaciones.every((x) => x.roles_destinatarios.includes('gerente')));
  assert.ok(admin.notificaciones.length >= gerente.notificaciones.length);
  assert.ok(gerente.nuevas > 0);

  const una = gerente.notificaciones.find((x) => x.estado === 'nueva');
  assert.equal((await api('POST', `/api/notificaciones/${una.id}/leida`, { token: tokens.gerente })).status, 200);
  assert.equal((await api('POST', `/api/notificaciones/${una.id}/leida`, { token: tokens.cajero })).status, 404); // no es suya
  assert.equal((await api('GET', '/api/notificaciones?estado=leida', { token: tokens.gerente })).json.notificaciones.some((x) => x.id === una.id), true);
  assert.equal((await api('POST', `/api/notificaciones/${una.id}/resuelta`, { token: tokens.gerente })).status, 200);
});
