const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.AFIP_CONDICION_IVA_EMISOR = 'monotributista';
process.env.AFIP_PUNTO_VENTA = '1';
const { iniciarApp, esperarMensajes } = require('./ayudas');
const M = require('../src/mensajeria/servicio');

let api, pool, cerrar, token, tokenBarista, cliente, cuenta, n = 0, k = 0;
const dia = (hace) => { const f = new Date(Date.now() - hace * 86400000); const p = (x) => String(x).padStart(2, '0'); return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`; };
const horas = (h) => { const d = new Date(Date.now() - h * 3600000); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  const usuario = async (username, rol) => {
    const [r] = await pool.query('INSERT INTO users (username, password_hash, rol) VALUES (?, ?, ?)', [username, await bcrypt.hash('clave-larga-1', 4), rol === 'administrador' ? 'admin' : 'empleado']);
    await pool.query('INSERT INTO usuario_roles (user_id, rol_id) SELECT ?, id FROM roles WHERE codigo = ?', [r.insertId, rol]);
    return (await api('POST', '/api/auth/login', { body: { username, password: 'clave-larga-1' } })).json.token;
  };
  token = await usuario('adm', 'administrador');
  tokenBarista = await usuario('bea', 'barista');
  const wsfe = require('../src/afip/wsfeClient');
  let ultimo = 0;
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.solicitarCAE = async ({ item }) => { ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: '70000000000001', CAEFchVto: '20261231' }] } }; };
  await api('POST', '/api/modulos/clientes/instalar', { token });
  cliente = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'CUIT', nro_documento: '30711111111', razon_social: 'Café del Centro SRL', consultar_arca: false } })).json;
});
after(async () => { await cerrar(); });

const debito = async (importe, hace, extra = {}, cli = cliente) => {
  const docId = `VTA-${++k}`;
  const conn = await pool.getConnection();
  await M.publicar(conn, { origen: 'ventas', destino: 'clientes', tipo: 'debito_venta', docTipo: 'venta', docIdGlobal: docId, contenido: { cliente_id: cli.id, importe, venta_id_global: docId, fecha: dia(hace), ...extra } });
  conn.release();
  await esperarMensajes(pool);
  return docId;
};
const cc = (ruta, metodo = 'GET', body, t = token) => api(metodo, `/api/cuentas-corrientes${ruta}`, { token: t, body });
const recibo = (cuentaId, body, t = token) => api('POST', '/api/recibos', { token: t, headers: { 'X-ID-Solicitud': `rec-m-${++k}-abcdefgh` }, body: { cuenta_id: cuentaId, ...body } });
const activar = (f) => api('POST', '/api/funciones/cambiar', { token, body: { activar: [f], motivo: 'prueba' } });

test('Clientes.RF10/RN12: CLI-MORA calcula los intereses de lo vencido con la tasa de la cuenta y propone la nota; un usuario con permiso la confirma; sin anatocismo ni doble cobro', async () => {
  assert.equal((await api('POST', '/api/ajustes-cc/calcular-mora', { token, body: {} })).status, 409); // CLI-MORA apagada
  assert.equal((await activar('CLI-MORA')).status, 200);
  cuenta = (await cc('', 'POST', { cliente_id: cliente.id, limite_credito: 1000000, plazo_dias: 15, tasa_mora: 3 })).json; // 3 % mensual
  const vencido = await debito(1000, 45); // vence hace 30 días
  await debito(2000, 10); // todavía no vence
  assert.equal((await api('POST', '/api/ajustes-cc/calcular-mora', { token: tokenBarista, body: {} })).status, 403);
  const calc = (await api('POST', '/api/ajustes-cc/calcular-mora', { token, body: {} })).json;
  assert.equal(calc.creadas, 1);
  const p = calc.propuestas[0];
  assert.deepEqual([p.comprobante_ref, p.importe, p.base_calculo, p.estado], [vencido, 30, 1000, 'pendiente']); // 1000 × 3 % × 30 / 30
  assert.equal((await api('POST', '/api/ajustes-cc/calcular-mora', { token, body: {} })).json.creadas, 0); // no duplica la propuesta pendiente
  // Una nota de débito de intereses vencida no devenga intereses (RN12).
  await pool.query("INSERT INTO movimientos_cc (id_global, cuenta_id, tipo, naturaleza, comprobante_ref, motivo, fecha, fecha_vencimiento, importe, saldo_pendiente, estado) VALUES ('ND-VIEJA', ?, 'nd', 'debito', 'ND-VIEJA', 'intereses_mora', ?, ?, 500, 500, 'pendiente')", [cuenta.id, dia(60), dia(40)]);
  assert.equal((await api('POST', '/api/ajustes-cc/calcular-mora', { token, body: {} })).json.propuestas.length, 1);
  const saldoAntes = (await cc(`/${cuenta.id}`)).json.saldo;
  assert.equal((await api('POST', `/api/ajustes-cc/${p.id}/confirmar`, { token, body: { importe: 31 } })).status, 400); // no supera lo propuesto
  const ok = await api('POST', `/api/ajustes-cc/${p.id}/confirmar`, { token, body: {} });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.nota.tipo, ok.json.nota.motivo, ok.json.nota.importe, ok.json.propuesta.estado], ['nd', 'intereses_mora', 30, 'emitida']);
  assert.equal((await cc(`/${cuenta.id}`)).json.saldo, saldoAntes + 30);
  assert.equal((await api('POST', `/api/ajustes-cc/${p.id}/confirmar`, { token, body: {} })).status, 409);
  assert.equal((await api('POST', '/api/ajustes-cc/calcular-mora', { token, body: {} })).json.creadas, 0); // el período ya cobrado no se vuelve a cobrar
  // Condonar: descartar exige permiso y motivo; el período descartado tampoco se cobra después.
  await pool.query("UPDATE propuestas_ajuste_cc SET periodo_hasta = DATE_SUB(CURDATE(), INTERVAL 10 DAY) WHERE id = ?", [p.id]); // simula que pasaron 10 días desde el último cálculo
  const otra = (await api('POST', '/api/ajustes-cc/calcular-mora', { token, body: {} })).json;
  assert.equal(otra.creadas, 1);
  const nueva = otra.propuestas[0];
  assert.equal(nueva.importe, 10); // 1000 × 3 % × 10 / 30
  assert.equal((await api('POST', `/api/ajustes-cc/${nueva.id}/descartar`, { token: tokenBarista, body: { motivo: 'x' } })).status, 403);
  assert.equal((await api('POST', `/api/ajustes-cc/${nueva.id}/descartar`, { token, body: {} })).status, 400);
  assert.equal((await api('POST', `/api/ajustes-cc/${nueva.id}/descartar`, { token, body: { motivo: 'Cliente histórico, acuerdo comercial' } })).json.estado, 'descartada');
});

test('Clientes.RF08/RN13: CLI-RETENCIONES — el recibo registra retenciones con certificado, cancelan deuda como un pago y se informan', async () => {
  const deudas = (await cc(`/${cuenta.id}/pendientes`)).json;
  assert.ok(deudas.length >= 2);
  const base = { valores: [{ forma: 'efectivo', importe: 700 }], retenciones: [{ impuesto: 'iva', nro_certificado: 'C-0001-123', fecha: dia(0), importe: 300 }] };
  assert.equal((await recibo(cuenta.id, base)).status, 409); // CLI-RETENCIONES apagada
  assert.equal((await activar('CLI-RETENCIONES')).status, 200);
  assert.equal((await recibo(cuenta.id, { ...base, retenciones: [{ impuesto: 'iva', fecha: dia(0), importe: 300 }] })).status, 400); // sin certificado
  assert.equal((await recibo(cuenta.id, { ...base, retenciones: [{ impuesto: 'iibb', nro_certificado: 'X1', fecha: dia(0), importe: 300 }] })).status, 400); // IIBB sin jurisdicción
  assert.equal((await recibo(cuenta.id, { ...base, imputacion: 'ninguna' })).status, 400);
  assert.equal((await recibo(cuenta.id, { valores: [{ forma: 'efectivo', importe: 100 }], retenciones: [{ impuesto: 'ganancias', nro_certificado: 'G-9', fecha: dia(0), importe: 99999999 }] })).status, 400); // supera la deuda (RN13)
  const antes = (await cc(`/${cuenta.id}`)).json.saldo;
  const r = await recibo(cuenta.id, { ...base, retenciones: [...base.retenciones, { impuesto: 'iibb', regimen: 'Percepción', jurisdiccion: 'Buenos Aires', nro_certificado: 'IB-77', fecha: dia(0), importe: 50 }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.total, r.json.retenciones.length, r.json.imputaciones.reduce((a, i) => a + i.importe, 0)], [1050, 2, 1050]); // total = formas + retenciones, y cancelan deuda
  assert.equal((await cc(`/${cuenta.id}`)).json.saldo, antes - 1050);
  const inf = (await api('GET', '/api/clientes-informes/retenciones', { token })).json;
  assert.deepEqual([inf.total, inf.por_impuesto.iva, inf.por_impuesto.iibb, inf.retenciones[0].recibo], [350, 300, 50, r.json.numero_completo]);
  assert.equal((await api('GET', '/api/clientes-informes/retenciones?impuesto=iva', { token })).json.total, 300);
  assert.equal((await api('GET', '/api/clientes-informes/retenciones?formato=csv', { token })).status, 200);
});

test('Clientes.RF11/RN11: CLI-MONEDA-EXT — cuenta en dólares: comprobantes con su equivalente a la cotización del día, cobros convertidos a la del cobro y diferencia de cambio propuesta', async () => {
  assert.equal((await cc('', 'POST', { cliente_id: cliente.id, moneda: 'USD', limite_credito: 1000 })).status, 409); // CLI-MONEDA-EXT apagada
  assert.equal((await activar('CLI-MONEDA-EXT')).status, 200);
  assert.equal((await api('POST', '/api/monedas/cotizaciones', { token, body: { moneda: 'USD', comprador: 1000, vendedor: 1100 } })).status, 201);
  const usd = (await cc('', 'POST', { cliente_id: cliente.id, moneda: 'USD', limite_credito: 1000, plazo_dias: 15 })).json;
  assert.equal(usd.moneda, 'USD');
  // Un débito de Ventas ya convertido: importe en dólares, equivalente en pesos y la cotización usada.
  const v1 = await debito(100, 5, { moneda: 'USD', importe_pesos: 110000, cotizacion: 1100 });
  const m = (await cc(`/${usd.id}/movimientos`)).json[0];
  assert.deepEqual([m.importe, m.importe_pesos, m.cotizacion, m.comprobante_ref], [100, 110000, 1100, v1]);
  assert.equal((await cc(`/${usd.id}`)).json.saldo, 100); // la deuda se mide en dólares
  // Una venta en pesos a la cuenta en dólares: Ventas convierte con la cotización vendedora (RN87).
  const p = (await api('POST', '/api/productos', { token, body: { nombre: 'Pan de campo', precio: 55000 } })).json;
  const mesa = (await api('POST', '/api/mesas', { token, body: { numero_mesa: 1, salon_id: 1 } })).json;
  const pedido = (await api('POST', '/api/pedidos', { token, body: { mesa_id: mesa.id } })).json;
  await api('POST', `/api/pedidos/${pedido.id}/productos`, { token, body: { productos: [{ producto_id: p.id, cantidad: 1 }] } });
  await api('POST', '/api/funciones/cambiar', { token, body: { activar: ['VEN-CC'], motivo: 'prueba' } });
  const venta = await api('POST', `/api/mesas/${mesa.id}/cerrar`, { token, headers: { 'X-ID-Solicitud': 'cierre-usd-1-abcdef' }, body: { pagos: [{ forma: 'cuenta_corriente', importe: 55000 }], cliente_id: cliente.id, cuenta_moneda: 'USD' } });
  assert.equal(venta.status, 200, JSON.stringify(venta.json));
  await esperarMensajes(pool);
  const mv = (await cc(`/${usd.id}/movimientos`)).json[0];
  assert.deepEqual([mv.importe, mv.importe_pesos, mv.cotizacion], [50, 55000, 1100]);
  assert.equal((await cc(`/${usd.id}`)).json.saldo, 150);
  assert.equal((await cc('/veredicto', 'POST', { cliente_id: cliente.id, moneda: 'USD', importe: 900 })).json.veredicto, 'requiere_autorizacion'); // el límite es de 1000 USD: quedan 850
  // El dólar sube: se cobra en pesos a 1.210 y el cobro se convierte a la cotización del día del cobro.
  await api('POST', '/api/monedas/cotizaciones', { token, body: { moneda: 'USD', comprador: 1100, vendedor: 1210 } });
  const r = await recibo(usd.id, { valores: [{ forma: 'efectivo', importe: 121000 }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.total, r.json.valores[0].importe, r.json.valores[0].importe_original, r.json.valores[0].cotizacion], [100, 100, 121000, 1210]);
  assert.equal((await cc(`/${usd.id}`)).json.saldo, 50);
  const dif = (await api('GET', '/api/ajustes-cc?tipo=diferencia_cambio&estado=pendiente', { token })).json;
  assert.equal(dif.length, 1);
  assert.deepEqual([dif[0].naturaleza, dif[0].importe, dif[0].base_calculo], ['debito', 11000, 100]); // 100 USD × (1.210 − 1.100): el cobro en pesos es mayor, ND
  // La nota se documenta en la cuenta en pesos del cliente (la hay desde el primer caso).
  const conf = await api('POST', `/api/ajustes-cc/${dif[0].id}/confirmar`, { token, body: {} });
  assert.equal(conf.status, 200, JSON.stringify(conf.json));
  assert.deepEqual([conf.json.nota.tipo, conf.json.nota.importe, conf.json.nota.cuenta_id, conf.json.nota.motivo], ['nd', 11000, cuenta.id, 'diferencia_cambio']);
});

test('Clientes.EX07/EX11: sin cotización o con la cotización vencida se advierte o se bloquea según la configuración; unificar fichas con cuentas en distintas monedas las mantiene separadas', async () => {
  const eur = (await cc('', 'POST', { cliente_id: cliente.id, moneda: 'EUR', limite_credito: 500 })).json;
  assert.equal((await recibo(eur.id, { valores: [{ forma: 'efectivo', importe: 1000 }], imputacion: 'ninguna' })).json.codigo, 'SIN_COTIZACION'); // no hay ninguna
  assert.equal((await api('POST', '/api/monedas/cotizaciones', { token, body: { moneda: 'EUR', comprador: 1500, vendedor: 1600, fecha_hora: horas(30) } })).status, 201);
  const conAviso = await recibo(eur.id, { valores: [{ forma: 'efectivo', importe: 1600 }], imputacion: 'ninguna' }); // 30 h: vencida, advierte y usa la última
  assert.equal(conAviso.status, 201, JSON.stringify(conAviso.json));
  assert.match(conAviso.json.aviso, /última cotización de EUR/);
  await pool.query("UPDATE parametros SET valor = 'bloquear' WHERE clave = 'cc_cotizacion_vencida'");
  assert.equal((await recibo(eur.id, { valores: [{ forma: 'efectivo', importe: 1600 }], imputacion: 'ninguna' })).json.codigo, 'SIN_COTIZACION');
  await pool.query("UPDATE parametros SET valor = 'advertir' WHERE clave = 'cc_cotizacion_vencida'");
  // Unificación: dos fichas del mismo cliente, una con cuenta en pesos y otra en dólares.
  const a = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '20111000', razon_social: 'Juan Gomez', consultar_arca: false } })).json;
  const b = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '20111001', razon_social: 'Juan Gómez', consultar_arca: false } })).json;
  const c = (await api('POST', '/api/clientes', { token, body: { tipo_documento: 'DNI', nro_documento: '20111002', razon_social: 'J. Gómez', consultar_arca: false } })).json;
  await cc('', 'POST', { cliente_id: a.id, limite_credito: 100 });
  await cc('', 'POST', { cliente_id: b.id, moneda: 'USD', limite_credito: 100 });
  await cc('', 'POST', { cliente_id: c.id, limite_credito: 100 });
  const unir = (abs, res) => api('POST', '/api/clientes/unificar', { token, body: { absorbido_id: abs, resultante_id: res, motivo: 'Misma persona' } });
  assert.equal((await unir(c.id, a.id)).status, 409); // las dos tienen cuenta en pesos: se cierra una antes
  assert.equal((await unir(b.id, a.id)).status, 200);
  const cuentas = (await cc(`?cliente_id=${a.id}`)).json;
  assert.deepEqual(cuentas.map((x) => x.moneda), ['ARS', 'USD']); // separadas bajo la ficha resultante
  assert.deepEqual((await cc(`?cliente_id=${b.id}`)).json.map((x) => x.moneda), ['ARS', 'USD']); // el alias resuelve a la resultante
});

test('Clientes.RF25/RN32: el indicador de deuda convierte las cuentas en moneda extranjera a la cotización del día', async () => {
  const Informes = require('../src/clientes/informesService');
  const ind = await Informes.indicadorDeuda();
  const [filas] = await pool.query("SELECT cc.moneda, SUM(m.saldo_pendiente) AS s FROM movimientos_cc m JOIN cuentas_corrientes cc ON cc.id = m.cuenta_id WHERE m.naturaleza = 'debito' AND m.estado = 'pendiente' AND m.saldo_pendiente > 0 GROUP BY cc.moneda");
  const ars = Number(filas.find((f) => f.moneda === 'ARS')?.s ?? 0), usd = Number(filas.find((f) => f.moneda === 'USD')?.s ?? 0);
  assert.ok(usd > 0);
  assert.equal(ind.valor, Math.round((ars + usd * 1210) * 100) / 100);
});
