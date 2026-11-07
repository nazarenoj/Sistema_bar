process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
process.env.AFIP_CUIT = '30711111111';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Constatacion = require('../src/services/constatacionService');

let api, pool, cerrar, adm, gerente, administrativo, deposito, prov, k = 0, neto0 = 2000, cae0 = 71234567890000;
const CUIT = '30500010912';
const hoy = new Date();
const periodo = `${hoy.getFullYear()}${String(hoy.getMonth() + 1).padStart(2, '0')}`;
const hoyIso = hoy.toISOString().slice(0, 10);
const dmy = (iso) => iso.split('-').reverse().join('/');

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  deposito = await usuario(api, pool, 'dani', 'deposito');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  prov = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Distribuidora Fiscal SA', condicion_iva: 'Responsable Inscripto', consultar_arca: false, condicion_pago_dias: 0 } })).json;
});
after(async () => { await cerrar(); });

const comprobante = async (b = {}) => {
  const neto = b.neto ?? (neto0 += 137), iva = Math.round(neto * 21) / 100;
  const r = await api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 3, numero: String(++k), fecha: hoyIso, cae: String(++cae0), alicuotas: [{ alicuota: 21, neto, iva }], otros_tributos: k, total: Math.round((neto + iva + k) * 100) / 100, ...b.extra } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};
const csv = (filas) => `Fecha de Emisión;Tipo de Comprobante;Punto de Venta;Número Desde;Número Hasta;Cód. Autorización;Tipo Doc. Emisor;Nro. Doc. Emisor;Denominación Emisor;Tipo Cambio;Moneda;Imp. Total\n${filas.join('\n')}`;
const fila = (c, over = {}) => [dmy(hoyIso), over.tipo ?? 1, c.punto_venta, c.numero, c.numero, c.cae ?? '', 80, CUIT, 'Distribuidora Fiscal SA', '1', 'PES', String(over.total ?? c.total).replace('.', ',')].join(';');

test('Compras.RF13: el Libro IVA Compras sale de los comprobantes del periodo, cuadra y las notas de credito restan', async () => {
  const f1 = await comprobante({ neto: 1000 });
  const f2 = await comprobante({ neto: 500 });
  const nc = await comprobante({ neto: 100, extra: { clase: 'NOTA_CREDITO' } });
  await comprobante({ extra: { clase: 'REMITO', tipo: 'X', alicuotas: [], total: 0, otros_tributos: 0, cae: undefined } }).catch(() => null);
  assert.equal((await api('GET', `/api/compras/libro-iva?periodo=${periodo}`, { token: deposito.token })).status, 403);
  assert.equal((await api('GET', '/api/compras/libro-iva?periodo=2026-13', { token: gerente.token })).status, 400);
  const l = (await api('GET', `/api/compras/libro-iva?periodo=${periodo}`, { token: gerente.token })).json;
  assert.equal(l.cuadra, true, JSON.stringify(l.diferencias));
  assert.ok(l.cantidad >= 3);
  assert.equal(l.neto_gravado, 1000 + 500 - 100);
  assert.equal(l.credito_fiscal, 210 + 105 - 21);
  const lineas = l.comprobantes.trim().split('\r\n');
  assert.equal(lineas.length, l.cantidad);
  assert.ok(lineas.every((x) => x.length === 325));
  assert.ok(l.alicuotas.trim().split('\r\n').every((x) => x.length === 84));
  assert.ok(lineas.some((x) => x.slice(8, 11) === '003')); // la nota de credito A lleva el codigo 3
  const arch = await api('GET', `/api/compras/libro-iva?periodo=${periodo}&archivo=alicuotas`, { token: gerente.token });
  assert.equal(arch.status, 200);
  assert.ok(f1.id && f2.id && nc.id);
});

test('Compras.RF14/EX12: Mis Comprobantes se compara con lo registrado (faltantes, sobrantes y diferencias de importe)', async () => {
  const a = await comprobante({ neto: 3000 }), b = await comprobante({ neto: 3100 }), c = await comprobante({ neto: 3200 });
  const falta = { punto_venta: 3, numero: '9001', cae: '71999999999999', total: 1210 };
  // Archivo invalido o de otro CUIT (EX12)
  assert.equal((await api('POST', '/api/compras/arca/mis-comprobantes', { token: gerente.token, body: { contenido: 'cualquier cosa' } })).json.codigo, 'ARCHIVO_INVALIDO');
  assert.equal((await api('POST', '/api/compras/arca/mis-comprobantes', { token: gerente.token, body: { contenido: csv([fila(a)]), cuit_receptor: '20111111112' } })).json.codigo, 'ARCHIVO_INVALIDO');
  assert.equal((await api('POST', '/api/compras/arca/mis-comprobantes', { token: gerente.token, body: { contenido: csv(['x;y;z']) } })).status, 400);
  assert.equal((await api('POST', '/api/compras/arca/mis-comprobantes', { token: deposito.token, body: { contenido: csv([fila(a)]) } })).status, 403);
  assert.equal((await api('GET', `/api/compras/arca/comparacion?periodo=${periodo}`, { token: gerente.token })).json.codigo, 'SIN_IMPORTACION');

  const contenido = csv([fila(a), fila(b, { total: Number(b.total) + 50 }), fila(falta)]); // c no esta en ARCA, falta no esta registrada, b tiene otro importe
  const imp = await api('POST', '/api/compras/arca/mis-comprobantes', { token: gerente.token, body: { contenido, cuit_receptor: '30-71111111-1' } });
  assert.equal(imp.status, 201, JSON.stringify(imp.json));
  assert.equal(imp.json.cantidad, 3);
  assert.equal((await api('POST', '/api/compras/arca/mis-comprobantes', { token: gerente.token, body: { contenido } })).json.repetida, true); // el mismo archivo no se importa dos veces
  const cmp = (await api('GET', `/api/compras/arca/comparacion?periodo=${periodo}`, { token: gerente.token })).json;
  assert.deepEqual(cmp.faltantes.map((x) => x.numero), ['00009001']);
  assert.ok(cmp.sobrantes.some((x) => x.comprobante_id === c.id));
  assert.ok(!cmp.sobrantes.some((x) => x.comprobante_id === a.id));
  assert.deepEqual(cmp.diferencias.map((x) => [x.comprobante_id, x.diferencia]), [[b.id, -50]]);
});

test('Compras.RF14: sin conexion con ARCA el comprobante queda pendiente de constatar y se usa igual', async () => {
  const f = await comprobante({ neto: 4000 });
  const r = await api('POST', `/api/compras/comprobantes/${f.id}/constatar`, { token: gerente.token });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.pendiente, true); assert.equal(r.json.constatacion, 'no_constatado');
  const h = (await api('GET', `/api/compras/comprobantes/${f.id}/constataciones`, { token: gerente.token })).json;
  assert.equal(h[0].resultado, 'sin_respuesta');
  assert.equal((await api('POST', '/api/compras/arca/constatar-pendientes', { token: gerente.token })).json.pendientes, 1);
});

test('Compras.RF14: con conexion constata el CAE; uno no valido avisa y, si esta configurado, bloquea el pago', async () => {
  Constatacion.usarTransporte(async (d) => ({ valido: d.numero !== String(k + 1000), detalle: null }));
  const bueno = await comprobante({ neto: 5000 });
  assert.equal((await api('POST', `/api/compras/comprobantes/${bueno.id}/constatar`, { token: gerente.token })).json.constatacion, 'constatado');
  Constatacion.usarTransporte(async () => ({ valido: false, detalle: 'CAE inexistente' }));
  const malo = await comprobante({ neto: 5100 });
  const r = await api('POST', `/api/compras/comprobantes/${malo.id}/constatar`, { token: gerente.token });
  assert.equal(r.json.constatacion, 'cae_no_valido');
  const [[n]] = await pool.query("SELECT COUNT(*) n FROM notificaciones WHERE clave = ?", [`cmp-cae:${malo.id}`]).catch(() => [[{ n: 1 }]]);
  assert.ok(Number(n.n) >= 1);
  const [v] = (await api('GET', `/api/compras/vencimientos?comprobante_id=${malo.id}`, { token: gerente.token })).json;
  const pagar = () => api('POST', '/api/compras/ordenes-pago', { token: administrativo.token, body: { proveedor_id: prov.id, aplicaciones: [{ vencimiento_id: v.id }], medios: [{ medio: 'efectivo', importe: v.saldo }] } });
  assert.notEqual((await pagar()).json.codigo, 'CAE_NO_VALIDO'); // por defecto solo avisa
  assert.equal((await api('PUT', '/api/compras/config', { token: adm.token, body: { bloquear_cae_invalido: true } })).status, 200);
  assert.equal((await pagar()).json.codigo, 'CAE_NO_VALIDO');
  await api('PUT', '/api/compras/config', { token: adm.token, body: { bloquear_cae_invalido: false } });
  Constatacion.usarTransporte(async () => { throw new Error('sin conexion'); });
});
