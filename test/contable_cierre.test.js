const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { preparar } = require('./ayudas_contable');
const { usuario } = require('./ayudas_financiero');
const Plantillas = require('../src/contable/plantillaService');
const Libros = require('../src/contable/libroService');

let api, pool, cerrar, c, k = 0, contador;
before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  c = await preparar(api, pool);
  contador = await usuario(api, pool, 'cont', 'contador');
});
after(async () => { await cerrar(); });

const g = () => ({ token: c.gerente.token });
const ct = () => ({ token: contador.token });
const sol = () => ({ 'X-ID-Solicitud': `cie-${++k}-${Math.random().toString(36).slice(2, 10)}` });
const manual = (leyenda, lineas, fecha = c.hoy) => api('POST', '/api/contable/asientos-manuales', { ...g(), headers: sol(), body: { fecha, leyenda, lineas } });
const funcion = (id, on) => api('POST', '/api/funciones/cambiar', { token: c.adm.token, body: { [on ? 'activar' : 'desactivar']: [id], motivo: 'prueba' } });
const periodos = async () => (await api('GET', '/api/contable/periodos', g())).json;
const mes = (p) => `${p.anio}-${String(p.mes).padStart(2, '0')}`;
const nuevaCuenta = async (codigo, nombre, tipo, padreCodigo, moneda) => {
  const padre = c.cuentas.find((x) => x.codigo === padreCodigo);
  const r = await api('POST', '/api/contable/cuentas', { ...g(), body: { codigo, nombre, tipo, padre_id: padre.id, moneda } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
};

test('Contable.EX05/RF09: sin la función no hay revaluación; sin cotización de cierre no se genera y se pide', async () => {
  const mesHoy = c.hoy.slice(0, 7);
  assert.equal((await api('GET', `/api/contable/revaluacion?periodo=${mesHoy}`, g())).json.codigo, 'FUNCION_DESACTIVADA');
  assert.equal((await funcion('CON-REVALUACION', true)).status, 200);
  const usd = await nuevaCuenta('1.1.30', 'Caja en dólares', 'activo', '1.1', 'USD');
  const prov = await nuevaCuenta('2.1.30', 'Proveedores del exterior', 'pasivo', '2.1', 'USD');
  // 100 USD en caja a $1000 y una deuda de 50 USD a $1000.
  assert.equal((await manual('Dólares', [{ cuenta_id: usd.id, debe: 100000, importe_divisa: 100, cotizacion: 1000 }, { cuenta_id: c.clave('capital').id, haber: 100000 }])).status, 201);
  assert.equal((await manual('Deuda en dólares', [{ cuenta_id: c.clave('capital').id, debe: 50000 }, { cuenta_id: prov.id, haber: 50000, importe_divisa: 50, cotizacion: 1000 }])).status, 201);
  const sin = await api('GET', `/api/contable/revaluacion?periodo=${mesHoy}`, g());
  assert.equal(sin.status, 409);
  assert.equal(sin.json.codigo, 'SIN_COTIZACION');
  assert.deepEqual(sin.json.monedas, ['USD']);
  c.usd = usd; c.prov = prov;
});

test('Contable.RN10/RF09: la revaluación usa la cotización comprador para activos y vendedor para pasivos, y se registra una sola vez por período', async () => {
  const mesHoy = c.hoy.slice(0, 7);
  const cotizaciones = { USD: { comprador: 1100, vendedor: 1200 } };
  const r = await api('POST', '/api/contable/revaluacion', { ...g(), headers: sol(), body: { periodo: mesHoy, cotizaciones } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const a = (await api('GET', `/api/contable/asientos/${r.json.asiento_id}`, g())).json;
  assert.equal(a.tipo, 'revaluacion');
  const linea = (id, lado) => a.lineas.filter((l) => l.cuenta_id === id).reduce((s, l) => s + l[lado], 0);
  assert.equal(linea(c.usd.id, 'debe'), 10000); // 100 USD x 1100 = 110000 contra 100000
  assert.equal(linea(c.clave('diferencias_cambio_pos').id, 'haber'), 10000);
  assert.equal(linea(c.prov.id, 'haber'), 10000); // 50 USD x 1200 = 60000 contra 50000: la deuda sube
  assert.equal(linea(c.clave('diferencias_cambio').id, 'debe'), 10000);
  assert.equal((await api('POST', '/api/contable/revaluacion', { ...g(), headers: sol(), body: { periodo: mesHoy, cotizaciones } })).json.codigo, 'YA_REGISTRADA');
});

test('Contable.RF12/EX07: la plantilla de exportación define columnas, separadores y equivalencias, y sin equivalencia no hay archivo', async () => {
  assert.equal((await api('GET', '/api/contable/plantillas', g())).json.codigo, 'FUNCION_DESACTIVADA'); // CON-EXPORT-PLANTILLAS es opcional y viene apagada
  assert.equal((await funcion('CON-EXPORT-PLANTILLAS', true)).status, 200);
  const mala = await api('POST', '/api/contable/plantillas', { ...ct(), body: { nombre: 'Mala', columnas: ['fecha', 'inventada'] } });
  assert.equal(mala.status, 400);
  assert.equal(mala.json.codigo, 'PLANTILLA_INVALIDA');
  const equivalencias = {};
  for (const cta of (await api('GET', '/api/contable/cuentas', g())).json.filter((x) => x.imputable)) equivalencias[cta.codigo] = `E${cta.codigo.replace(/\./g, '')}`;
  const parcial = { ...equivalencias }; delete parcial[c.clave('capital').codigo];
  const p = await api('POST', '/api/contable/plantillas', { ...ct(), body: { nombre: 'Estudio Pérez', separador: ';', decimal: ',', formato_fecha: 'dmy', columnas: ['fecha', 'numero', 'cuenta', 'debe', 'haber', 'leyenda'], equivalencias: parcial } });
  assert.equal(p.status, 201, JSON.stringify(p.json));
  const falta = await api('GET', `/api/contable/exportar/diario?plantilla=${p.json.id}&periodo=${c.hoy.slice(0, 7)}`, g());
  assert.equal(falta.status, 409);
  assert.equal(falta.json.codigo, 'SIN_EQUIVALENCIA');
  assert.ok(falta.json.cuentas.some((x) => x.codigo === c.clave('capital').codigo));
  // Con la equivalencia completa el archivo coincide con el diario.
  assert.equal((await api('PUT', `/api/contable/plantillas/${p.json.id}`, { ...ct(), body: { ...p.json, equivalencias } })).status, 200);
  const ok = await Plantillas.exportarDiario(p.json.id, { periodo: c.hoy.slice(0, 7) });
  const diario = await Libros.diario({ periodo: c.hoy.slice(0, 7) });
  const filas = ok.texto.trim().split('\r\n');
  assert.equal(filas[0], 'fecha;numero;cuenta;debe;haber;leyenda');
  assert.equal(filas.length - 1, diario.asientos.reduce((s, a) => s + a.lineas.length, 0));
  const total = filas.slice(1).reduce((s, f) => s + Number(f.split(';')[3].replace(',', '.')), 0);
  assert.equal(Math.round(total * 100) / 100, diario.total_debe);
  assert.match(filas[1], /^\d{2}\/\d{2}\/\d{4};1;E/); // fecha dd/mm/aaaa, asiento 1, código externo
  assert.equal((await api('GET', `/api/contable/exportar/diario?plantilla=${p.json.id}&periodo=${c.hoy.slice(0, 7)}`, g())).status, 200);
  assert.equal((await api('GET', `/api/contable/exportar/diario?plantilla=${p.json.id}&periodo=${c.hoy.slice(0, 7)}`, { token: c.cajero.token })).status, 403);
});

test('Contable.RN08: un período no se cierra con pendientes de imputar salvo que se acepten con motivo, y pasan al período siguiente', async () => {
  const regla = (await pool.query("SELECT id FROM con_reglas WHERE formulario = 'venta' AND componente = 'iva'"))[0][0].id;
  await pool.query('UPDATE con_reglas SET activa = 0 WHERE id = ?', [regla]);
  const id = await c.vender('efectivo');
  const [pend] = (await api('GET', '/api/contable/pendientes', g())).json;
  assert.equal(pend.id_documento, id);
  const mesActual = (await periodos()).find((p) => mes(p) === c.hoy.slice(0, 7));
  const bloqueo = await api('POST', `/api/contable/periodos/${mesActual.id}/cerrar`, { ...g(), body: {} });
  assert.equal(bloqueo.status, 409);
  assert.equal(bloqueo.json.codigo, 'PENDIENTES_SIN_RESOLVER');
  assert.equal(bloqueo.json.pendientes.length, 1);
  // Sin motivo no vale; con motivo el cierre exige además el permiso de aceptar.
  assert.equal((await api('POST', `/api/contable/periodos/${mesActual.id}/cerrar`, { token: c.adm.token, body: { aceptar: [{ pendiente_id: pend.id, motivo: 'x' }] } })).status, 409);
  assert.equal((await api('POST', `/api/contable/periodos/${mesActual.id}/cerrar`, { ...g(), body: { aceptar: [{ pendiente_id: pend.id, motivo: 'Se resuelve con el contador' }] } })).status, 403);
  const ok = await api('POST', `/api/contable/periodos/${mesActual.id}/cerrar`, { token: c.adm.token, body: { aceptar: [{ pendiente_id: pend.id, motivo: 'Se resuelve con el contador' }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const [[p]] = await pool.query('SELECT fecha, fecha_original, aceptado_motivo, estado FROM con_pendientes WHERE id = ?', [pend.id]);
  assert.equal(p.estado, 'abierto'); // sigue pendiente, ahora en el período siguiente
  assert.notEqual(p.fecha_original, null);
  assert.match(p.aceptado_motivo, /contador/);
  // Se resuelve creando la regla: el asiento cae en el primer período abierto.
  await pool.query('UPDATE con_reglas SET activa = 1 WHERE id = ?', [regla]);
  assert.equal((await api('POST', `/api/contable/pendientes/${pend.id}/reintentar`, { ...g(), body: {} })).status, 200);
  await esperarMensajes(pool);
  const a = await c.asientoDe(id);
  assert.ok(a);
  assert.match(a.leyenda, /fecha original/);
});

test('Contable.RN12/EX09: el ejercicio no se cierra con períodos abiertos, pendientes o balance descuadrado y la vista previa lista lo que falta', async () => {
  const [ej] = (await api('GET', '/api/contable/ejercicios', g())).json;
  const previa = (await api('GET', `/api/contable/ejercicios/${ej.id}/cierre`, g())).json;
  assert.equal(previa.puede_cerrar, false);
  assert.ok(previa.faltan.periodos_abiertos.length >= 1);
  const r = await api('POST', `/api/contable/ejercicios/${ej.id}/cerrar`, { ...ct(), headers: sol(), body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'CIERRE_BLOQUEADO');
  assert.ok(r.json.faltan.periodos_abiertos);
});

test('Contable.RF10: el cierre genera la refundición de resultados, el cierre patrimonial y la apertura del ejercicio siguiente; después el ejercicio solo se consulta', async () => {
  // Un gasto manual en un período todavía abierto, para tener resultado negativo además de las ventas.
  const [primero] = (await api('GET', '/api/contable/ejercicios', g())).json;
  const abierto = (await periodos()).find((p) => p.ejercicio_id === primero.id && p.estado === 'abierto');
  if (abierto) assert.equal((await manual('Compra de insumos', [{ cuenta_id: c.clave('compras').id, debe: 100 }, { cuenta_id: c.clave('caja').id, haber: 100 }], `${mes(abierto)}-01`)).status, 201);
  const [ej] = (await api('GET', '/api/contable/ejercicios', g())).json;
  const balanceAntes = (await api('GET', `/api/contable/libros/balance?desde=${ej.desde}&hasta=${ej.hasta}`, g())).json;
  assert.equal(balanceAntes.cuadra, true);
  const resultadoEsperado = Math.round((balanceAntes.filas.filter((f) => f.tipo === 'resultado_positivo').reduce((s, f) => s + f.saldo_acreedor - f.saldo_deudor, 0)
    + balanceAntes.filas.filter((f) => f.tipo === 'resultado_negativo').reduce((s, f) => s + f.saldo_acreedor - f.saldo_deudor, 0)) * 100) / 100;
  for (const p of (await periodos()).filter((x) => x.ejercicio_id === ej.id && x.estado === 'abierto')) assert.equal((await api('POST', `/api/contable/periodos/${p.id}/cerrar`, { ...g(), body: {} })).status, 200);
  assert.equal((await api('GET', `/api/contable/ejercicios/${ej.id}/cierre`, g())).json.puede_cerrar, true);
  assert.equal((await api('POST', `/api/contable/ejercicios/${ej.id}/cerrar`, { token: c.cajero.token, headers: sol(), body: {} })).status, 403);
  const cierre = await api('POST', `/api/contable/ejercicios/${ej.id}/cerrar`, { ...ct(), headers: sol(), body: {} });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.json));
  assert.equal(cierre.json.resultado, resultadoEsperado);
  assert.ok(cierre.json.refundicion && cierre.json.cierre && cierre.json.apertura);
  // Los asientos: las cuentas de resultado y las patrimoniales quedan en cero al fin del ejercicio.
  const despues = (await api('GET', `/api/contable/libros/balance?desde=${ej.desde}&hasta=${ej.hasta}`, g())).json;
  assert.equal(despues.cuadra, true);
  assert.equal(despues.filas.filter((f) => f.saldo_deudor !== 0 || f.saldo_acreedor !== 0).length, 0);
  // La apertura del ejercicio siguiente reproduce el patrimonio, con el resultado pasado a Resultados acumulados.
  const ap = (await api('GET', `/api/contable/asientos/${cierre.json.apertura.id}`, g())).json;
  assert.equal(ap.tipo, 'apertura_ejercicio');
  assert.equal(ap.fecha, cierre.json.siguiente_ejercicio.desde);
  const acum = ap.lineas.filter((l) => l.cuenta_id === c.clave('resultados_acumulados').id);
  assert.equal(Math.round(acum.reduce((s, l) => s + l.haber - l.debe, 0) * 100) / 100, resultadoEsperado);
  assert.equal(ap.lineas.reduce((s, l) => s + l.debe, 0).toFixed(2), ap.lineas.reduce((s, l) => s + l.haber, 0).toFixed(2));
  // El balance acumulado a mitad del ejercicio siguiente conserva los saldos.
  const sig = (await api('GET', `/api/contable/libros/balance?hasta=${cierre.json.siguiente_ejercicio.hasta}`, g())).json;
  assert.equal(sig.cuadra, true);
  assert.equal(sig.filas.find((f) => f.cuenta_id === c.clave('caja').id).saldo_deudor, balanceAntes.filas.find((f) => f.cuenta_id === c.clave('caja').id).saldo_deudor);
  // Solo se consulta: no se reabre un período ni se cierra dos veces.
  const periodoViejo = (await periodos()).find((p) => p.ejercicio_id === ej.id);
  assert.equal((await api('POST', `/api/contable/periodos/${periodoViejo.id}/reabrir`, { ...ct(), body: { motivo: 'Quiero corregir algo' } })).json.codigo, 'EJERCICIO_CERRADO');
  assert.equal((await api('POST', `/api/contable/ejercicios/${ej.id}/cerrar`, { ...ct(), headers: sol(), body: {} })).status, 409);
  assert.equal((await manual('En el ejercicio cerrado', [{ cuenta_id: c.clave('caja').id, debe: 1 }, { cuenta_id: c.clave('capital').id, haber: 1 }], c.hoy)).status, 409);
});
