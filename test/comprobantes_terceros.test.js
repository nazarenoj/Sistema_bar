const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const Claves = require('../src/servicios/comprobanteTerceroService');

let api, pool, cerrar, token, tokenDeposito, insumo, k = 0;
const CUIT = '30711111111'; // dígito verificador válido
const CUIT2 = '20123456786';

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenDeposito = await usuario('dep', 'deposito');
  insumo = (await api('POST', '/api/insumos', { token, body: { nombre: 'Harina', unidad: 'kg' } })).json;
});
after(async () => { await cerrar(); });

const comp = (extra = {}) => ({ cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 3, numero: '1234', ...extra });
const ingreso = (comprobante, t = token, proveedor = 'Molino SA') => api('POST', '/api/stock/ingresos', { token: t, headers: { 'X-ID-Solicitud': `ing-${++k}-abcdefgh` }, body: { motivo: 'compra', proveedor, comprobante, lineas: [{ item: { tipo: 'insumo', id: insumo.id }, cantidad: 1, costo_unitario: 10 }] } });
const estadoClave = async (clave) => (await pool.query('SELECT * FROM claves_comprobante WHERE clave = ? ORDER BY id_clave DESC', [clave]))[0][0];
const reservar = (body, headers = {}) => api('POST', '/api/comprobantes-terceros/reservar', { token, headers, body });

test('Usuarios.RN63/EX46: la clave se normaliza y un dato que no forma clave indica el campo a corregir', async () => {
  const n = (c) => api('POST', '/api/comprobantes-terceros/normalizar', { token, body: c });
  const ok = await n({ cuit: '30-71111111-1', clase: 'factura', tipo: 'a', punto_venta: '3', numero: '1.234' });
  assert.equal(ok.json.clave, `${CUIT}-FACTURA-A-00003-00001234`);
  assert.equal((await n({ ...comp(), clase: 'Nota de crédito' })).json.clave.includes('NOTA_CREDITO'), true);
  for (const [cambio, campo] of [[{ cuit: '30711111112' }, 'cuit'], [{ punto_venta: '123456' }, 'punto_venta'], [{ numero: '' }, 'numero'], [{ numero: '123456789' }, 'numero'], [{ clase: 'cheque' }, 'clase'], [{ tipo: 'Z' }, 'tipo'], [{ cae: '123' }, 'cae']]) {
    const r = await n({ ...comp(), ...cambio });
    assert.equal(r.status, 400, JSON.stringify(cambio));
    assert.equal(r.json.campo === campo || (campo === 'punto_venta' && /punto de venta/.test(r.json.error)) || (campo === 'numero' && /número/.test(r.json.error)), true, `${JSON.stringify(cambio)} → ${JSON.stringify(r.json)}`);
  }
  const sin = (await n({ razon_social: 'Panadería  "El Trigo" S.A.', clase: 'REMITO', tipo: 'X', punto_venta: 1, numero: 9 })).json; // RN68
  assert.deepEqual([sin.sin_cuit, sin.clave], [true, 'RS:PANADERIA_EL_TRIGO_S_A-REMITO-X-00001-00000009']);
});

test('Usuarios.RN64/EX42: el ingreso de Stock reserva y confirma la clave; el mismo comprobante después es un duplicado exacto y queda registrado', async () => {
  const r = await ingreso(comp());
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await esperarMensajes(pool);
  const c = await estadoClave(`${CUIT}-FACTURA-A-00003-00001234`);
  assert.deepEqual([c.estado, c.modulo_dueno, c.id_documento_dueno], ['vigente', 'stock', r.json.id_global]);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM clave_vinculos WHERE id_clave = ? AND modulo = ?', [c.id_clave, 'stock']))[0][0].n, 1);
  const dup = await ingreso(comp({ numero: '00001234' }));
  assert.deepEqual([dup.status, dup.json.codigo, dup.json.clave.modulo], [409, 'DUPLICADO_EXACTO', 'stock']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM clave_intentos WHERE resultado = 'duplicado_exacto'"))[0][0].n, 1);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM stock_ingresos'))[0][0].n, 1); // el duplicado no ingresó nada
});

test('Usuarios.EX57/RN83: una clave reservada por otra carga está "en proceso"; si no se confirma la reserva vence sola', async () => {
  const datos = comp({ numero: 2000 });
  const res = await reservar(datos, { 'X-ID-Solicitud': 'sol-reserva-1-abcdef' });
  assert.deepEqual([res.status, res.json.estado], [201, 'reservada']);
  const igual = await reservar(datos, { 'X-ID-Solicitud': 'sol-reserva-1-abcdef' }); // reintento de la misma carga
  assert.equal(igual.json.id_reserva, res.json.id_reserva);
  const otra = await ingreso(datos, tokenDeposito);
  assert.deepEqual([otra.status, otra.json.codigo], [409, 'EN_PROCESO']);
  assert.equal(otra.json.clave.usuario, 'adm');
  assert.ok(otra.json.clave.hasta);
  // Vence: la clave queda libre para otra carga, que ahora sí puede continuar.
  await pool.query("UPDATE claves_comprobante SET reservada_hasta = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id_reserva = ?", [res.json.id_reserva]);
  assert.equal((await ingreso(datos)).status, 201);
  await esperarMensajes(pool);
  assert.equal((await pool.query("SELECT estado FROM claves_comprobante WHERE id_reserva = ?", [res.json.id_reserva]))[0][0].estado, 'vencida');
  // Confirmar con la reserva vencida: la toma de nuevo si sigue libre, y si otra carga ya la tomó se rechaza como duplicado.
  const x = (await reservar(comp({ numero: 3000 }))).json;
  await pool.query("UPDATE claves_comprobante SET reservada_hasta = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id_reserva = ?", [x.id_reserva]);
  await Claves.vencerReservas();
  const conn = await pool.getConnection();
  const c1 = await Claves.confirmar(conn, { id_reserva: x.id_reserva, id_documento: 'DOC-1', modulo: 'stock' });
  conn.release();
  assert.deepEqual([c1.vigente, c1.reservada_de_nuevo], [true, true]);
  const y = (await reservar(comp({ numero: 3100 }))).json;
  await pool.query("UPDATE claves_comprobante SET reservada_hasta = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id_reserva = ?", [y.id_reserva]);
  await Claves.vencerReservas();
  assert.equal((await reservar(comp({ numero: 3100 }))).status, 201); // otra carga la toma
  const conn2 = await pool.getConnection();
  await assert.rejects(Claves.confirmar(conn2, { id_reserva: y.id_reserva, id_documento: 'DOC-2', modulo: 'stock' }), /Duplicado/);
  conn2.release();
});

test('Usuarios.RN65/EX43: un casi duplicado advierte y se continúa con permiso y motivo; el par confirmado no vuelve a advertirse', async () => {
  // El número 1234 ya está cargado con punto de venta 3: el mismo con punto de venta 4 es casi duplicado.
  const casi = await ingreso(comp({ punto_venta: 4 }));
  assert.deepEqual([casi.status, casi.json.codigo], [409, 'CASI_DUPLICADO']);
  assert.match(casi.json.clave.coincidentes[0].motivo, /otro punto de venta/);
  const sinMotivo = await ingreso(comp({ punto_venta: 4, confirmar_casi_duplicado: {} }));
  assert.equal(sinMotivo.status, 400);
  assert.equal((await ingreso(comp({ punto_venta: 4, confirmar_casi_duplicado: { motivo: 'Es de otra sucursal del proveedor' } }), tokenDeposito)).status, 403); // Depósito: requiere autorización
  const ok = await ingreso(comp({ punto_venta: 4, confirmar_casi_duplicado: { motivo: 'Es de otra sucursal del proveedor' } }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  await esperarMensajes(pool);
  assert.equal((await estadoClave(`${CUIT}-FACTURA-A-00004-00001234`)).motivo_confirmacion, 'Es de otra sucursal del proveedor');
  // Se anula y se vuelve a cargar: ya no advierte por el mismo par.
  await api('POST', '/api/comprobantes-terceros/anular', { token, body: { modulo: 'stock', id_documento: ok.json.id_global } });
  assert.equal((await estadoClave(`${CUIT}-FACTURA-A-00004-00001234`)).estado, 'liberada');
  assert.equal((await ingreso(comp({ punto_venta: 4 }))).status, 201);
  // Mismo emisor, fecha e importe con ±0,01.
  assert.equal((await ingreso(comp({ numero: 5000, fecha: '2026-05-01', importe: 100 }))).status, 201);
  const imp = await ingreso(comp({ numero: 5001, fecha: '2026-05-01', importe: 100.01 }));
  assert.deepEqual([imp.status, imp.json.codigo], [409, 'CASI_DUPLICADO']);
  assert.equal((await ingreso(comp({ numero: 5002, fecha: '2026-05-01', importe: 100.5 }))).status, 201); // fuera de tolerancia
});

test('Usuarios.RN66/EX44: dos claves distintas con el mismo CAE se bloquean y alertan; el CAEA ampara varios comprobantes', async () => {
  const cae = '70123456789012';
  assert.equal((await ingreso(comp({ numero: 6000, cae }))).status, 201);
  const otro = await ingreso(comp({ numero: 6001, cae }));
  assert.deepEqual([otro.status, otro.json.codigo], [409, 'BLOQUEADO_CAE']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'cae_repetido'"))[0][0].n, 1);
  assert.equal((await ingreso(comp({ numero: 6002, cae: '70999999999999', cae_tipo: 'CAEA' }))).status, 201);
  assert.equal((await ingreso(comp({ numero: 6003, cae: '70999999999999', cae_tipo: 'CAEA' }))).status, 201); // mismo CAEA con otra clave: no bloquea
  assert.equal((await ingreso(comp({ numero: 6003, cae: '70999999999999', cae_tipo: 'CAEA' }))).json.codigo, 'DUPLICADO_EXACTO'); // con la misma clave sí
});

test('Usuarios.RN67/RN84: remito y factura son claves distintas y vinculadas; los vínculos de varios módulos y la anulación', async () => {
  const rem = await ingreso(comp({ cuit: CUIT2, clase: 'REMITO', tipo: 'X', numero: 100 }));
  const fac = await ingreso(comp({ cuit: CUIT2, clase: 'FACTURA', tipo: 'A', numero: 100 })); // mismo número, otra clase: no es casi duplicado
  assert.deepEqual([rem.status, fac.status], [201, 201]);
  await esperarMensajes(pool);
  const idRem = (await estadoClave(`${CUIT2}-REMITO-X-00003-00000100`)).id_clave;
  const idFac = (await estadoClave(`${CUIT2}-FACTURA-A-00003-00000100`)).id_clave;
  assert.equal((await api('POST', '/api/comprobantes-terceros/vincular-remito', { token, body: { id_remito: idFac, id_factura: idRem } })).status, 400);
  assert.equal((await api('POST', '/api/comprobantes-terceros/vincular-remito', { token, body: { id_remito: idRem, id_factura: idFac } })).json.id_clave_vinculada, idFac);
  // RN84: Compras adopta la clave de la factura con el ID_Clave y pasa a ser el dueño, sin duplicar.
  const vinc = await reservar(comp({ cuit: CUIT2, numero: 100, id_clave: idFac }));
  assert.deepEqual([vinc.json.estado, vinc.json.modulo_dueno], ['vinculable', 'stock']);
  const ad = await api('POST', `/api/comprobantes-terceros/${idFac}/vincular`, { token, body: { modulo: 'compras', id_documento: 'COMPRA-1', rol: 'registro_fiscal' } });
  assert.equal(ad.json.modulo_dueno, 'compras');
  assert.equal(ad.json.vinculos.length, 2);
  // Se anula el documento del dueño: la clave sigue vigente mientras tenga otros vínculos; con todos anulados queda liberada y el remito sin vincular.
  await api('POST', '/api/comprobantes-terceros/anular', { token, body: { modulo: 'compras', id_documento: 'COMPRA-1' } });
  assert.equal((await estadoClave(`${CUIT2}-FACTURA-A-00003-00000100`)).estado, 'vigente');
  await api('POST', '/api/comprobantes-terceros/anular', { token, body: { modulo: 'stock', id_documento: fac.json.id_global } });
  assert.equal((await estadoClave(`${CUIT2}-FACTURA-A-00003-00000100`)).estado, 'liberada');
  assert.equal((await estadoClave(`${CUIT2}-REMITO-X-00003-00000100`)).id_clave_vinculada, null);
});

test('Usuarios.RN68/EX45: un proveedor sin CUIT advierte siempre y pide confirmación con motivo; al informar el CUIT se recalcula la clave', async () => {
  const sin = { clase: 'FACTURA', tipo: 'B', punto_venta: 1, numero: 77 };
  const a = await ingreso(sin, token, 'Verdulería  Don José');
  assert.deepEqual([a.status, a.json.codigo], [409, 'CASI_DUPLICADO']);
  assert.match(a.json.clave.coincidentes[0].motivo, /sin CUIT/);
  const ok = await ingreso({ ...sin, confirmar_casi_duplicado: { motivo: 'El proveedor no tiene CUIT cargado todavía' } }, token, 'Verdulería  Don José');
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  await esperarMensajes(pool);
  const c = await estadoClave('RS:VERDULERIA_DON_JOSE-FACTURA-B-00001-00000077');
  assert.equal(c.estado, 'vigente');
  const dup = await api('POST', `/api/comprobantes-terceros/${c.id_clave}/cuit`, { token, body: { cuit: '30711111112' } });
  assert.equal(dup.status, 400);
  const r = await api('POST', `/api/comprobantes-terceros/${c.id_clave}/cuit`, { token, body: { cuit: CUIT } });
  assert.deepEqual([r.json.recalculada, r.json.clave], [true, `${CUIT}-FACTURA-B-00001-00000077`]);
});
