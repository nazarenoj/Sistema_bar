process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
process.env.AFIP_PUNTO_VENTA = '1';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Conectores = require('../src/ventas_online/conectorService');
const wsfe = require('../src/afip/wsfeClient');

let api, pool, cerrar, adm, gerente, cajero, contador, B, E, SC, token, conector, k = 0, ultimo = 0;
const T = '/tienda/cafe-pla';
const enviados = [];

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  wsfe.compUltimoAutorizado = async () => ultimo;
  wsfe.compConsultar = async () => null;
  wsfe.solicitarCAE = async ({ item }) => { ultimo = item.CbteDesde; return { FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CAE: `7000000000${String(ultimo).padStart(4, '0')}`, CAEFchVto: '20261231' }] } }; };
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  cajero = await usuario(api, pool, 'cami', 'cajero');
  contador = await usuario(api, pool, 'cora', 'contador');
  await api('POST', '/api/modulos/ventas_online/instalar', { token: adm.token });
  await api('PUT', '/api/ventas-online/tienda', { token: gerente.token, body: { codigo: 'cafe-pla', nombre: 'Cafe', razon_social: 'Cafe SA', cuit: '30711111111', domicilio: 'Mitre 1', activa: true } });
  B = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Medialuna', precio: 300, stock: 0 } })).json;
  E = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Torta del dia', precio: 5000, stock: 0 } })).json;
  await pool.query("UPDATE productos SET tipo = 'elaborado' WHERE id = ?", [E.id]);
  SC = (await api('POST', '/api/productos', { token: adm.token, body: { nombre: 'Scon de queso', precio: 400, stock: 0 } })).json;
  for (const x of [B, E, SC]) await api('PUT', `/api/ventas-online/catalogo/${x.id}`, { token: gerente.token, body: { categoria_online: 'Menu' } });
});
const local = (ms) => { const d = new Date(ms), p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
after(async () => { Conectores.usarTransporte(null); await cerrar(); });

const cambiar = (b) => api('POST', '/api/funciones/cambiar', { token: adm.token, body: { motivo: 'prueba', ...b } });
const pedido = (cuerpo, tk = token, cod = 'rappi') => api('POST', `${T}/plataformas/${cod}/pedidos`, { headers: tk ? { 'X-Conector-Token': tk } : {}, body: cuerpo });
const ext = () => `RP-${++k}`;
const detalle = async (id) => (await api('GET', `/api/ventas-online/pedidos/${id}`, { token: gerente.token })).json;
const estado = (id, e) => api('POST', `/api/ventas-online/pedidos/${id}/estado`, { token: gerente.token, body: { estado: e } });

test('Ventas Online.RF18: ONL-MARKETPLACES necesita Financiero para activarse', async () => {
  assert.equal((await api('POST', '/api/ventas-online/plataformas', { token: gerente.token, body: { codigo: 'rappi', nombre: 'Rappi' } })).json.codigo, 'FUNCION_INACTIVA'); // nace apagada
  const sin = await cambiar({ activar: ['ONL-MARKETPLACES'] });
  assert.notEqual(sin.status, 200, JSON.stringify(sin.json)); // sin Financiero el conector no se activa
  await api('POST', '/api/modulos/financiero/instalar', { token: adm.token });
  const ok = await cambiar({ activar: ['ONL-MARKETPLACES'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('Ventas Online.RF18: el conector define comision, precio propio y articulos, y su secreto se muestra una sola vez', async () => {
  const c = (b, t = gerente) => api('POST', '/api/ventas-online/plataformas', { token: t.token, body: b });
  assert.equal((await c({ codigo: 'rappi', nombre: 'Rappi' }, cajero)).status, 403);
  assert.equal((await c({ codigo: 'R', nombre: 'Rappi' })).status, 400);
  assert.equal((await c({ codigo: 'rappi', nombre: 'Rappi', comision_pct: 150 })).status, 400);
  const ok = await c({ codigo: 'rappi', nombre: 'Rappi', comision_pct: 20, ajuste_pct: 10 });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.match(ok.json.token, /^[0-9a-f]{48}$/); token = ok.json.token; conector = ok.json;
  assert.equal((await c({ codigo: 'rappi', nombre: 'Otra' })).status, 409);
  assert.ok(!('token' in (await api('GET', '/api/ventas-online/plataformas', { token: gerente.token })).json[0]));
  const v = (b) => api('POST', `/api/ventas-online/plataformas/${conector.id}/articulos`, { token: gerente.token, body: b });
  assert.equal((await v({ producto_id: 99999, id_externo: 'X' })).status, 409);
  assert.equal((await v({ producto_id: B.id, id_externo: 'RP-MEDIALUNA' })).status, 201);
  await v({ producto_id: E.id, id_externo: 'RP-TORTA' });
  assert.equal((await v({ producto_id: E.id, id_externo: 'RP-MEDIALUNA' })).status, 409); // el ID de la plataforma es de otro articulo
  const menu = (await api('GET', `/api/ventas-online/plataformas/${conector.id}/menu`, { token: gerente.token })).json;
  assert.equal(menu.items.find((i) => i.id_externo === 'RP-MEDIALUNA').precio, 330); // el precio de Ventas mas el ajuste propio del conector
});

test('Ventas Online.RF18/EX15: publicar el menu necesita conexion; el conector pausado a mano no publica y los elaborados se pausan con la disponibilidad vieja', async () => {
  const pub = () => api('POST', `/api/ventas-online/plataformas/${conector.id}/publicar`, { token: gerente.token });
  assert.equal((await pub()).json.codigo, 'DESCONECTADO');
  assert.equal((await api('GET', '/api/ventas-online/plataformas', { token: gerente.token })).json[0].conexion, 'desconectado');
  Conectores.usarTransporte(async (tipo, cod, payload) => { enviados.push({ tipo, cod, payload }); });
  const ok = await pub();
  assert.equal(ok.json.publicados, 2); assert.equal((await api('GET', '/api/ventas-online/plataformas', { token: gerente.token })).json[0].conexion, 'conectado');
  assert.equal(enviados[0].tipo, 'menu');
  await pool.query('UPDATE onl_sync SET ultima_ms = ? WHERE id = 1', [Date.now() - 40 * 60000]);
  const m = (await api('GET', `/api/ventas-online/plataformas/${conector.id}/menu`, { token: gerente.token })).json;
  assert.equal(m.items.find((i) => i.id_externo === 'RP-TORTA').vendible, false); // RN26: el elaborado se pausa
  assert.equal(m.items.find((i) => i.id_externo === 'RP-MEDIALUNA').vendible, true);
  await pool.query('UPDATE onl_sync SET ultima_ms = ? WHERE id = 1', [Date.now()]);
  assert.equal((await api('POST', `/api/ventas-online/plataformas/${conector.id}/pausa`, { token: gerente.token, body: { pausado: true } })).status, 400); // la pausa pide motivo
  assert.equal((await api('POST', `/api/ventas-online/plataformas/${conector.id}/pausa`, { token: gerente.token, body: { motivo: 'Cocina saturada' } })).json.pausado, true);
  assert.equal((await pub()).json.codigo, 'CONECTOR_PAUSADO');
  await api('POST', `/api/ventas-online/plataformas/${conector.id}/pausa`, { token: gerente.token, body: { pausado: false } });
});

test('Ventas Online.RN27: el pedido de plataforma se identifica por su ID externo, no se duplica, pasa a Ventas con «Cobro por plataforma» y se factura', async () => {
  const id = ext();
  const cuerpo = { id_externo: id, nombre_comprador: 'Luis', items: [{ id_externo_articulo: 'RP-MEDIALUNA', cantidad: 3, precio: 330 }], total: 990, entrega: 'delivery' };
  assert.equal((await pedido(cuerpo, null)).status, 401);
  assert.equal((await pedido(cuerpo, 'x'.repeat(48))).json.codigo, 'CONECTOR_NO_AUTORIZADO');
  assert.equal((await pedido({ ...cuerpo, id_externo: ext(), total: 5 })).json.codigo, 'TOTAL_NO_CIERRA');
  assert.equal((await pedido({ ...cuerpo, items: [] })).status, 400);
  const r = await pedido(cuerpo);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.estado, r.json.total], ['pagado', 990]); // la plataforma ya cobro y la aceptacion es automatica
  const otra = await pedido(cuerpo);
  assert.equal(otra.status, 200); assert.equal(otra.json.repetido, true); assert.equal(otra.json.id, r.json.id);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM onl_pedidos WHERE id_externo = ?', [id]))[0][0].n, 1);
  const d = await detalle(r.json.id);
  assert.equal(d.entrega_ventas.estado, 'entregado');
  const [[v]] = await pool.query('SELECT v.id, v.total FROM ventas v WHERE v.id_global = ?', [d.entrega_ventas.venta_id_global]);
  assert.deepEqual((await pool.query('SELECT metodo_pago, importe FROM pago_venta WHERE venta_id = ?', [v.id]))[0].map((x) => [x.metodo_pago, Number(x.importe)]), [['cobro_plataforma', 990]]);
  assert.equal(d.comprobantes.length, 1); assert.equal(d.comprobantes[0].tipo_comprobante, 6); // consumidor final
  assert.equal(d.alineacion, 'alineado');
  const lista = (await api('GET', '/api/ventas-online/pedidos?origen=plataforma', { token: gerente.token })).json;
  assert.ok(lista.length >= 1 && lista.every((x) => x.estado !== undefined));
  assert.equal((await api('GET', '/api/ventas-online/pedidos?origen=tienda', { token: gerente.token })).json.length, 0);
});

test('Ventas Online.RF19: se acepta o rechaza a mano con aceptacion automatica apagada; un articulo sin vincular deja el pedido pendiente (EX16)', async () => {
  await api('PUT', `/api/ventas-online/plataformas/${conector.id}`, { token: gerente.token, body: { aceptacion_auto: false } });
  const a = await pedido({ id_externo: ext(), items: [{ id_externo_articulo: 'RP-MEDIALUNA', cantidad: 1, precio: 330 }], total: 330 });
  assert.equal(a.json.estado, 'pendiente_aceptacion');
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${a.json.id}/aceptar-plataforma`, { token: cajero.token })).status, 403);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${a.json.id}/aceptar-plataforma`, { token: gerente.token })).json.estado, 'pagado');
  assert.equal((await detalle(a.json.id)).entrega_ventas.estado, 'entregado');
  const b = await pedido({ id_externo: ext(), items: [{ id_externo_articulo: 'RP-MEDIALUNA', cantidad: 1, precio: 330 }], total: 330 });
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${b.json.id}/rechazar-plataforma`, { token: gerente.token, body: {} })).status, 400);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${b.json.id}/rechazar-plataforma`, { token: gerente.token, body: { motivo: 'Cocina saturada' } })).json.estado, 'cancelado');
  // EX16
  const c = await pedido({ id_externo: ext(), items: [{ id_externo_articulo: 'RP-NUEVO', titulo: 'Scon de queso', cantidad: 2, precio: 400 }], total: 800 });
  assert.equal(c.json.estado, 'pendiente_vinculacion');
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM notificaciones WHERE tipo = 'pedido_sin_vincular'"))[0][0].n >= 1);
  assert.equal((await api('POST', `/api/ventas-online/pedidos/${c.json.id}/vincular-articulos`, { token: gerente.token, body: { vinculos: [] } })).json.codigo, 'FALTAN_VINCULOS');
  const vinc = await api('POST', `/api/ventas-online/pedidos/${c.json.id}/vincular-articulos`, { token: gerente.token, body: { vinculos: [{ id_externo: 'RP-NUEVO', producto_id: SC.id }] } });
  assert.equal(vinc.status, 200, JSON.stringify(vinc.json));
  assert.equal(vinc.json.estado, 'pendiente_aceptacion');
  await api('PUT', `/api/ventas-online/plataformas/${conector.id}`, { token: gerente.token, body: { aceptacion_auto: true } });
});

test('Ventas Online.RF19: los cambios de estado se informan a la plataforma y, sin conexion, quedan en cola hasta reintentar', async () => {
  const antes = enviados.filter((e) => e.tipo === 'estado').length;
  const p = await pedido({ id_externo: ext(), items: [{ id_externo_articulo: 'RP-MEDIALUNA', cantidad: 1, precio: 330 }], total: 330 });
  await estado(p.json.id, 'en_preparacion');
  assert.deepEqual(enviados.filter((e) => e.tipo === 'estado').slice(antes).map((e) => e.payload.estado), ['en_preparacion']);
  Conectores.usarTransporte(async (tipo) => { if (tipo === 'estado') throw new Error('plataforma sin respuesta'); });
  await estado(p.json.id, 'listo');
  assert.equal((await pool.query("SELECT estado FROM onl_conector_eventos WHERE pedido_id = ? AND evento = 'listo'", [p.json.id]))[0][0].estado, 'fallido');
  assert.equal((await api('GET', '/api/ventas-online/plataformas', { token: gerente.token })).json[0].conexion, 'desconectado');
  Conectores.usarTransporte(async (tipo, cod, payload) => { enviados.push({ tipo, cod, payload }); });
  const r = await api('POST', '/api/ventas-online/plataformas/eventos/reintentar', { token: gerente.token });
  assert.equal(r.json.enviados >= 1, true);
  assert.equal((await api('GET', '/api/ventas-online/plataformas', { token: gerente.token })).json[0].conexion, 'conectado');
});

test('Ventas Online.RN28: la comision de cada pedido entregado va a Financiero, una sola vez, por porcentaje o por el importe que informe la plataforma', async () => {
  const a = await pedido({ id_externo: ext(), items: [{ id_externo_articulo: 'RP-MEDIALUNA', cantidad: 10, precio: 330 }], total: 3300 });
  const b = await pedido({ id_externo: ext(), items: [{ id_externo_articulo: 'RP-MEDIALUNA', cantidad: 10, precio: 330 }], total: 3300, comision: 500 });
  for (const p of [a, b]) for (const e of ['en_preparacion', 'listo', 'entregado']) assert.equal((await estado(p.json.id, e)).status, 200);
  await esperarMensajes(pool);
  const [filas] = await pool.query('SELECT pedido_global, bruto, comision FROM fin_plataforma_comisiones WHERE pedido_global IN (?, ?) ORDER BY id', [a.json.id_global, b.json.id_global]);
  assert.deepEqual(filas.map((x) => [Number(x.bruto), Number(x.comision)]), [[3300, 660], [3300, 500]]); // 20 % y el importe informado
  await Conectores.entregarComision(a.json.id);
  await esperarMensajes(pool);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM fin_plataforma_comisiones WHERE pedido_global = ?', [a.json.id_global]))[0][0].n, 1);
  const lista = (await api('GET', '/api/financiero/plataformas/comisiones?plataforma=rappi', { token: gerente.token })).json;
  assert.ok(lista.length >= 2);
  assert.equal((await api('GET', '/api/financiero/plataformas/comisiones', { token: cajero.token })).status, 403);
  const est = (await api('GET', '/api/ventas-online/plataformas-comisiones-estimadas', { token: gerente.token })).json; // el informe de estimadas existe aunque no haya Financiero
  assert.equal(est[0].plataforma, 'rappi');
});

test('Ventas Online.EX18: la liquidacion de la plataforma se concilia contra los pedidos entregados; la diferencia se senala y la resuelve una persona', async () => {
  const [[tot]] = await pool.query("SELECT SUM(bruto) AS b, SUM(comision) AS c FROM fin_plataforma_comisiones WHERE plataforma = 'rappi' AND liquidacion_id IS NULL");
  const hoy = new Date().toISOString().slice(0, 10);
  const liq = (b) => api('POST', '/api/ventas-online/plataformas/rappi/liquidaciones', { token: gerente.token, body: b });
  assert.equal((await liq({ id_liquidacion: 'L1' })).status, 400);
  assert.equal((await api('POST', '/api/ventas-online/plataformas/rappi/liquidaciones', { token: cajero.token, body: {} })).status, 403);
  // Una liquidacion que no coincide queda con diferencia y no se ajusta sola.
  assert.equal((await liq({ id_liquidacion: 'L1', desde: hoy, hasta: hoy, bruto: Number(tot.b) - 330, comision: Number(tot.c) - 66 })).status, 202);
  await esperarMensajes(pool);
  const l1 = (await api('GET', '/api/financiero/plataformas/liquidaciones', { token: gerente.token })).json.find((x) => x.id_liquidacion === 'rappi:L1');
  assert.deepEqual([l1.estado, l1.diferencia_bruto], ['con_diferencia', -330]);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM fin_plataforma_comisiones WHERE liquidacion_id IS NOT NULL"))[0][0].n, 0);
  assert.equal((await api('POST', `/api/financiero/plataformas/liquidaciones/${l1.id}/resolver`, { token: contador.token, body: { nota: 'ajuste' } })).status, 403);
  assert.equal((await api('POST', `/api/financiero/plataformas/liquidaciones/${l1.id}/resolver`, { token: gerente.token, body: {} })).status, 400);
  assert.equal((await api('POST', `/api/financiero/plataformas/liquidaciones/${l1.id}/resolver`, { token: gerente.token, body: { nota: 'La plataforma descontó un pedido en disputa' } })).json.estado, 'resuelta');
  // La que coincide queda conciliada y marca los pedidos como liquidados; repetirla no duplica nada.
  assert.equal((await liq({ id_liquidacion: 'L2', desde: hoy, hasta: hoy, bruto: Number(tot.b), comision: Number(tot.c) })).status, 202);
  await liq({ id_liquidacion: 'L2', desde: hoy, hasta: hoy, bruto: Number(tot.b), comision: Number(tot.c) });
  await esperarMensajes(pool);
  const todas = (await api('GET', '/api/financiero/plataformas/liquidaciones', { token: gerente.token })).json;
  assert.deepEqual(todas.filter((x) => x.id_liquidacion === 'rappi:L2').map((x) => x.estado), ['conciliada']);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM fin_plataforma_comisiones WHERE liquidacion_id IS NULL"))[0][0].n, 0);
});

test('Ventas Online.RF20: reserva de mesa desde la tienda (auto o a mano), turnos con cupo y cancelacion con el enlace del correo', async () => {
  const cupos0 = await api('GET', `${T}/reservas/cupos`);
  assert.equal(cupos0.json.codigo, 'FUNCION_INACTIVA'); // nace apagada
  const act = await cambiar({ activar: ['VEN-RESERVAS', 'ONL-RESERVAS'] });
  assert.equal(act.status, 200, JSON.stringify(act.json));
  const cuando = (dias, hora = '20:00') => local(Date.now() + dias * 86400000).slice(0, 10) + ` ${hora}`;
  const mesa = (b) => api('POST', `${T}/reservas/mesa`, { body: { nombre: 'Marta', email: 'marta@mail.test', personas: 4, fecha_hora: cuando(3), ...b } });
  assert.equal((await mesa({ email: 'no' })).status, 400);
  assert.equal((await mesa({ personas: 0 })).status, 400);
  assert.equal((await mesa({ fecha_hora: '2020-01-01 20:00' })).status, 400);
  const r = await mesa({});
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'confirmada'); // por defecto se confirma sola
  const [[rm]] = await pool.query("SELECT estado, origen FROM reservas_mesa ORDER BY id DESC LIMIT 1");
  assert.deepEqual([rm.estado, rm.origen], ['confirmada', 'tienda']); // quedo en la funcion Reservas de Ventas con origen tienda
  assert.equal((await api('GET', `${T}/reservas/${r.json.token}`)).json.estado, 'confirmada');
  assert.equal((await api('GET', `${T}/reservas/${'0'.repeat(32)}`)).status, 404);
  // A mano: nace pendiente hasta que el comercio la confirma.
  assert.equal((await api('PUT', '/api/ventas-online/reservas-tienda/configuracion', { token: gerente.token, body: { reservas_confirmacion: 'manual' } })).json.reservas_confirmacion, 'manual');
  const m2 = await mesa({ fecha_hora: cuando(4) });
  assert.equal(m2.json.estado, 'pendiente');
  assert.equal((await api('POST', `/api/ventas-online/reservas-tienda/${m2.json.id}/confirmar`, { token: cajero.token })).status, 403);
  assert.equal((await api('POST', `/api/ventas-online/reservas-tienda/${m2.json.id}/confirmar`, { token: gerente.token })).json.estado, 'confirmada');
  await api('PUT', '/api/ventas-online/reservas-tienda/configuracion', { token: gerente.token, body: { reservas_confirmacion: 'auto' } });
  // Cancelar con el enlace: hasta N horas antes.
  assert.equal((await api('DELETE', `${T}/reservas/${r.json.token}`)).json.estado, 'cancelada');
  assert.equal((await api('DELETE', `${T}/reservas/${r.json.token}`)).status, 409);
  const cerca = await mesa({ fecha_hora: local(Date.now() + 3600000) });
  assert.equal((await api('DELETE', `${T}/reservas/${cerca.json.token}`)).json.codigo, 'FUERA_DE_PLAZO'); // falta 1 hora y se cancela hasta 2 antes
  // Turnos con cupo
  const Reservas = require('../src/services/reservaService');
  const turno = await Reservas.crearTurno({ nombre: 'Cata de cafe', tipo: 'cata', fecha_hora: `${cuando(6, '18:00')}`, cupo: 3 });
  const otro = await Reservas.crearTurno({ nombre: 'Taller de latte art', tipo: 'taller', fecha_hora: `${cuando(7, '18:00')}`, cupo: 10 });
  assert.ok((await api('GET', `${T}/reservas/cupos`)).json.turnos.some((t) => t.id === turno.id));
  const t1 = await api('POST', `${T}/reservas/turnos/${turno.id}`, { body: { nombre: 'Ana', email: 'ana@mail.test', personas: 2 } });
  assert.equal(t1.status, 201, JSON.stringify(t1.json));
  const lleno = await api('POST', `${T}/reservas/turnos/${turno.id}`, { body: { nombre: 'Beto', email: 'beto@mail.test', personas: 2 } });
  assert.equal(lleno.status, 409); assert.equal(lleno.json.codigo, 'SIN_CUPO'); assert.equal(lleno.json.alternativas[0].id, otro.id); // EX19: ofrece los turnos mas cercanos con lugar
  assert.equal((await api('DELETE', `${T}/reservas/${t1.json.token}`)).json.estado, 'cancelada');
  assert.equal((await api('POST', `${T}/reservas/turnos/${turno.id}`, { body: { nombre: 'Beto', email: 'beto@mail.test', personas: 2 } })).status, 201); // el lugar se libero
});

test('Ventas Online.RN30: el encargo respeta la anticipacion minima y maxima y el cupo diario del obrador; las reservas de mesa se pausan con la disponibilidad vieja', async () => {
  const torta = E;
  const cfg = (b) => api('PUT', `/api/ventas-online/catalogo/${torta.id}/encargo`, { token: gerente.token, body: b });
  assert.equal((await cfg({ por_encargo: true, anticipacion_min_h: -1 })).status, 400);
  assert.equal((await cfg({ por_encargo: true, anticipacion_min_h: 48, anticipacion_max_dias: 30, cupo_diario_encargos: 2 })).status, 200);
  const enc = (horas, cant = 1, id = torta.id) => api('POST', `${T}/reservas/encargos`, { body: { nombre: 'Lia', email: 'lia@mail.test', fecha_entrega: local(Date.now() + horas * 3600000), personalizacion: 'Feliz cumple', items: [{ producto_id: id, cantidad: cant, personalizacion: 'Texto: Feliz cumple' }] } });
  assert.equal((await enc(24)).json.codigo, 'ANTICIPACION_MINIMA');
  assert.equal((await enc(24 * 40)).json.codigo, 'ANTICIPACION_MAXIMA');
  assert.equal((await enc(72, 1, B.id)).json.codigo, 'NO_ES_POR_ENCARGO');
  const ok = await enc(24 * 5);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const [[pe]] = await pool.query('SELECT origen, estado FROM pedidos_especiales ORDER BY id DESC LIMIT 1');
  assert.deepEqual([pe.origen, pe.estado], ['tienda', 'pendiente']);
  assert.equal((await enc(24 * 5, 2)).json.codigo, 'SIN_CUPO'); // ya hay 1 de 2 ese dia
  assert.equal((await api('DELETE', `${T}/reservas/${ok.json.token}`)).json.estado, 'cancelada');
  assert.equal((await enc(24 * 5, 2)).status, 201);
  await pool.query('UPDATE onl_sync SET ultima_ms = ? WHERE id = 1', [Date.now() - 40 * 60000]);
  const pausada = await api('POST', `${T}/reservas/mesa`, { body: { nombre: 'Marta', email: 'm@mail.test', personas: 2, fecha_hora: local(Date.now() + 5 * 86400000).slice(0, 10) + ' 21:00' } });
  assert.equal(pausada.json.codigo, 'RESERVAS_PAUSADAS');
  assert.equal((await api('GET', `${T}/reservas/cupos`)).json.mesas_pausadas, true);
  await pool.query('UPDATE onl_sync SET ultima_ms = ? WHERE id = 1', [Date.now()]);
  assert.ok((await api('GET', '/api/ventas-online/reservas-tienda', { token: gerente.token })).json.length >= 4);
});

test('Ventas Online.RF17: los informes se filtran y exportan; la conversion usa las visitas de la tienda', async () => {
  for (let i = 0; i < 5; i++) await api('GET', T);
  await pool.query("INSERT INTO onl_carritos (token, items, creado_ms, actualizado_ms, vence_ms) VALUES (?, ?, ?, ?, ?)", ['a'.repeat(48), JSON.stringify([{ linea: 1, producto_id: B.id, cantidad: 2, precio_visto: 330 }]), Date.now() - 3 * 86400000, Date.now() - 2 * 86400000, Date.now() + 86400000]);
  const inf = (t, q = '') => api('GET', `/api/ventas-online/informes/${t}${q}`, { token: gerente.token });
  assert.equal((await api('GET', '/api/ventas-online/informes', { token: cajero.token })).status, 403);
  assert.ok((await api('GET', '/api/ventas-online/informes', { token: contador.token })).json.includes('conversion'));
  const v = (await inf('ventas')).json;
  assert.ok(v.filas[0].pedidos >= 5 && v.filas[0].total > 0);
  assert.equal((await inf('ventas', '?desde=2020-01-01&hasta=2020-01-31')).json.filas.length, 0);
  assert.equal((await inf('ventas', '?desde=hoy')).status, 400);
  const filas = (await inf('conversion')).json.filas;
  assert.equal(filas.find((x) => x.dia === local(Date.now()).slice(0, 10)).visitas, 5);
  assert.equal(filas.find((x) => x.dia === local(Date.now()).slice(0, 10)).visitantes, 1); // las cinco cargas son del mismo visitante (misma IP y navegador)
  assert.ok(filas.every((x) => x.carritos >= x.pedidos)); // los pedidos de la tienda salen de un carrito; los de plataforma no cuentan
  assert.equal((await inf('mas-vendidos')).json.filas[0].articulo, 'Medialuna');
  const ab = (await inf('carritos-abandonados')).json.filas;
  assert.equal(ab.length, 1); assert.equal(ab[0].importe, 660);
  assert.ok((await inf('cupones')).json.filas !== undefined);
  assert.ok((await inf('plataformas')).json.filas.some((x) => x.plataforma === 'rappi'));
  assert.equal((await inf('transportistas')).status, 404);
  assert.equal((await api('GET', '/api/ventas-online/informes/ventas?formato=csv', { token: gerente.token })).status, 200);
});

test('Ventas Online.RF28: los indicadores de la tienda aparecen en el tablero solo para quien tiene permiso', async () => {
  await cambiar({ activar: ['USU-TABLERO'] });
  const disp = (t) => api('GET', '/api/tablero/indicadores', { token: t.token });
  const ids = (await disp(gerente)).json.map((i) => i.id);
  for (const id of ['online.pedidos', 'online.ventas', 'online.ticket', 'online.preparar', 'online.sincronizacion', 'online.faltantes', 'online.agotados', 'online.comisiones', 'online.conversion']) assert.ok(ids.includes(id), id);
  assert.ok(!(await disp(cajero)).json.some((i) => i.id.startsWith('online.')));
  await api('PUT', '/api/tablero', { token: gerente.token, body: { indicadores: ['online.pedidos', 'online.ventas', 'online.preparar', 'online.comisiones', 'online.conversion'], periodo: 'mes' } });
  const tab = (await api('GET', '/api/tablero', { token: gerente.token })).json;
  const v = (id) => tab.indicadores.find((i) => i.id === id);
  assert.ok(v('online.pedidos').valor >= 5); assert.ok(v('online.ventas').valor > 0); assert.ok(v('online.ventas').comparacion);
  assert.equal(typeof v('online.preparar').detalle.prometido_min, 'number');
  assert.ok(v('online.comisiones').valor > 0);
  assert.ok(v('online.conversion').detalle.visitas >= 5);
});
