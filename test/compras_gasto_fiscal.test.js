process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const M = require('../src/mensajeria/servicio');

let api, pool, cerrar, adm, administrativo, k = 0;
const CUIT = '30711111111';
const hoy = new Date().toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
});
after(async () => { await cerrar(); });

const publicar = async (contenido) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await M.publicar(conn, { origen: 'financiero', destino: 'compras', tipo: 'gasto_con_comprobante_fiscal', docTipo: 'gasto', docIdGlobal: contenido.gasto_id_global, contenido });
    await conn.commit();
  } finally { conn.release(); }
  M.despertar();
  await esperarMensajes(pool);
  return (await pool.query("SELECT estado, motivo_rechazo FROM mensajes_integracion WHERE doc_id_global = ? AND modulo_destino = 'compras'", [contenido.gasto_id_global]))[0][0];
};
const evento = (id, extra = {}) => ({ gasto_id_global: id, clave: `${CUIT}-FACTURA-A-00001-${String(++k).padStart(8, '0')}`, comprobante: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: k, neto: 1000, iva: 210 }, proveedor: 'Tostadores', importe: 1210, neto: 1000, iva: 210, fecha: hoy, ...extra });

test('Compras.RF03/Financiero.RN13: el gasto con comprobante fiscal entra al Libro IVA, una sola vez, sin deuda; sin proveedor queda rechazado hasta darlo de alta', async () => {
  const sinProv = await publicar(evento('GASTO-1'));
  assert.equal(sinProv.estado, 'rechazado');
  assert.match(sinProv.motivo_rechazo, /no está dado de alta como proveedor/);
  assert.equal((await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Tostadores del Sur SA', condicion_iva: 'Responsable Inscripto', consultar_arca: false } })).status, 201);
  // Con el proveedor dado de alta, el reintento desde la bandeja lo incorpora.
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', intentos = 0, proximo_intento_ms = 0, motivo_rechazo = NULL WHERE doc_id_global = 'GASTO-1'");
  await esperarMensajes(pool);
  const [[c]] = await pool.query("SELECT * FROM cmp_comprobantes WHERE id_solicitud = 'gasto:GASTO-1'");
  assert.ok(c, 'falta el comprobante');
  assert.deepEqual([c.origen, c.estado, Number(c.neto_gravado), Number(c.iva), Number(c.iva_computable), Number(c.total)], ['financiero', 'registrado', 1000, 210, 210, 1210]);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM cmp_comprobante_alicuotas WHERE comprobante_id = ?', [c.id]))[0][0].n), 1);
  assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM cmp_vencimientos WHERE comprobante_id = ?', [c.id]))[0][0].n), 0); // el gasto ya está pagado: no hay deuda
  // Idempotente: reprocesar no duplica.
  await pool.query("DELETE FROM operaciones_procesadas WHERE doc_id_global = 'GASTO-1'");
  await pool.query("UPDATE mensajes_integracion SET estado = 'pendiente', proximo_intento_ms = 0 WHERE doc_id_global = 'GASTO-1'");
  await esperarMensajes(pool);
  assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM cmp_comprobantes WHERE id_solicitud = 'gasto:GASTO-1'"))[0][0].n), 1);
  // Aparece en el Libro IVA Compras del período.
  const libro = await api('GET', `/api/compras/libro-iva?periodo=${hoy.slice(0, 7).replace("-", "")}`, { token: adm.token });
  assert.equal(libro.status, 200, JSON.stringify(libro.json));
  assert.equal(libro.json.cantidad, 1);
  assert.equal(libro.json.neto_gravado, 1000);
  assert.equal(libro.json.cuadra, true);
});

test('Compras.RN04: un gasto con factura B o C no computa el IVA', async () => {
  const r = await publicar(evento('GASTO-2', { comprobante: { cuit: CUIT, clase: 'FACTURA', tipo: 'B', punto_venta: 1, numero: 77, neto: 1000, iva: 210 } }));
  assert.equal(r.estado, 'confirmado');
  const [[c]] = await pool.query("SELECT iva, iva_computable FROM cmp_comprobantes WHERE id_solicitud = 'gasto:GASTO-2'");
  assert.deepEqual([Number(c.iva), Number(c.iva_computable)], [210, 0]);
});
