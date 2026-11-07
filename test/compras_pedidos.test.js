process.env.AFIP_CONDICION_IVA_EMISOR = 'responsable_inscripto';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarApp, esperarMensajes } = require('./ayudas');
const { usuario } = require('./ayudas_financiero');
const Mov = require('../src/stock/movimientoService');
const Pedidos = require('../src/compras/pedidoService');
const Repo = require('../src/stock/reposicionAutoService');
const puertos = require('../src/modulos/puertos');

let api, pool, cerrar, adm, gerente, administrativo, deposito, prov, dep, harina, cafe, huerfano, bolsa, k = 0, g = 0;
const CUIT = '30711111111';
const DIA = 86400000;
const hoyMas = (d) => new Date(Date.now() + d * DIA).toISOString().slice(0, 10);

before(async () => {
  ({ api, pool, cerrar } = await iniciarApp());
  adm = await usuario(api, pool, 'adm', 'administrador');
  gerente = await usuario(api, pool, 'gero', 'gerente');
  administrativo = await usuario(api, pool, 'ana', 'administrativo');
  deposito = await usuario(api, pool, 'dani', 'deposito');
  await api('POST', '/api/modulos/compras/instalar', { token: adm.token });
  dep = (await api('GET', '/api/depositos', { token: adm.token })).json[0].id;
  prov = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: CUIT, razon_social: 'Molino Pedidos SA', condicion_iva: 'Responsable Inscripto', consultar_arca: false, contactos: [{ nombre: 'Ventas', email: 'ventas@molino.test' }], plazo_entrega_dias: 2, pedido_minimo: 100000 } })).json;
  const insumo = async (nombre) => (await api('POST', '/api/insumos', { token: adm.token, body: { nombre, unidad: 'kg' } })).json;
  harina = await insumo('Harina pedidos'); cafe = await insumo('Cafe pedidos'); huerfano = await insumo('Sin proveedor pedidos');
  bolsa = (await api('POST', '/api/presentaciones', { token: adm.token, body: { insumo_id: harina.id, nombre: 'bolsa 25 kg', factor: 25, usos: ['compra'] } })).json;
  await api('POST', '/api/funciones/cambiar', { token: adm.token, body: { activar: ['STK-REPO-AUTO', 'CMP-PEDIDO-SUGERIDO'], motivo: 'prueba' } });
});
after(async () => { await cerrar(); });

const pedido = (b = {}, t = administrativo) => api('POST', '/api/compras/pedidos', { token: t.token, body: { proveedor_id: prov.id, lineas: [{ item: { tipo: 'insumo', id: cafe.id }, cantidad: 10, precio_estimado: 100 }], ...b } });
const op = (id, ruta, body = {}, t = gerente) => api('POST', `/api/compras/pedidos/${id}/${ruta}`, { token: t.token, body });
const ver = async (id) => (await api('GET', `/api/compras/pedidos/${id}`, { token: gerente.token })).json;

test('Compras.RN22: la entrega prevista suma el plazo, respeta la hora de corte y busca el primer dia de entrega', () => {
  const f = hoyMas(0);
  const antes = new Date(); antes.setHours(8, 0, 0, 0);
  const despues = new Date(); despues.setHours(20, 0, 0, 0);
  assert.equal(Pedidos.entregaPrevista({ plazo_entrega_dias: 2, dias_entrega: [], hora_corte: '10:00' }, f, antes), hoyMas(2));
  assert.equal(Pedidos.entregaPrevista({ plazo_entrega_dias: 2, dias_entrega: [], hora_corte: '10:00' }, f, despues), hoyMas(3)); // pasada la hora de corte se cuenta desde manana
  assert.equal(Pedidos.entregaPrevista({ plazo_entrega_dias: null }, f, antes), null);
  const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
  const e = Pedidos.entregaPrevista({ plazo_entrega_dias: 0, dias_entrega: ['mar'], hora_corte: null }, f, antes);
  assert.equal(DIAS[new Date(`${e}T12:00:00Z`).getUTCDay()], 'mar');
  assert.ok(e >= f && e <= hoyMas(6));
});

test('Compras.RF12: el pedido nace en borrador, se confirma con permiso, avisa el minimo y se edita mientras no se envia', async () => {
  const r = await pedido();
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.estado, 'borrador'); assert.equal(r.json.entrega_prevista, hoyMas(2));
  assert.equal((await pedido({ lineas: [] })).status, 400);
  assert.equal((await pedido({ lineas: [{ descripcion: 'x', cantidad: 0 }] })).status, 400);
  assert.equal((await pedido({}, deposito)).status, 201); // el deposito arma
  assert.equal((await op(r.json.id, 'confirmar', {}, deposito)).status, 403); // pero no confirma
  const e = await api('PUT', `/api/compras/pedidos/${r.json.id}`, { token: administrativo.token, body: { lineas: [{ item: { tipo: 'insumo', id: cafe.id }, cantidad: 20, precio_estimado: 100 }] } });
  assert.equal(e.json.lineas[0].cantidad, 20);
  const c = await op(r.json.id, 'confirmar');
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.estado, 'pendiente');
  assert.equal(c.json.advertencias.length, 1); // 2.000 < pedido minimo 100.000, advierte sin bloquear
  assert.equal((await op(r.json.id, 'confirmar')).status, 409);
  assert.equal((await op(r.json.id, 'enviar', { via: 'correo' }, deposito)).status, 403);
});

test('Compras.RF12: un pedido enviado no se edita, se reemplaza; por correo entra a la cola y por PDF se genera sin conexion', async () => {
  const r = (await pedido()).json;
  assert.equal((await op(r.id, 'enviar', { via: 'correo' })).json.error, 'Confirmá el pedido antes de enviarlo.');
  await op(r.id, 'confirmar');
  const pdf = await api('GET', `/api/compras/pedidos/${r.id}/pdf`, { token: gerente.token });
  assert.equal(pdf.status, 200);
  const env = await op(r.id, 'enviar', { via: 'correo' });
  assert.equal(env.status, 200, JSON.stringify(env.json));
  assert.equal(env.json.enviado, true); assert.equal(env.json.enviado_a, 'ventas@molino.test');
  const [[cola]] = await pool.query("SELECT para, asunto FROM correo_cola WHERE para = 'ventas@molino.test' ORDER BY id DESC LIMIT 1");
  assert.match(cola.asunto, /Molino Pedidos/);
  assert.equal((await api('PUT', `/api/compras/pedidos/${r.id}`, { token: administrativo.token, body: { observacion: 'x' } })).json.codigo, 'PEDIDO_ENVIADO');
  assert.equal((await op(r.id, 'enviar', { via: 'pdf' })).json.codigo, 'PEDIDO_ENVIADO');
  assert.equal((await op(r.id, 'reemplazar', {})).status, 400); // pide motivo
  const n = await op(r.id, 'reemplazar', { motivo: 'cambio de cantidad', lineas: [{ item: { tipo: 'insumo', id: cafe.id }, cantidad: 5, precio_estimado: 100 }] });
  assert.equal(n.status, 201, JSON.stringify(n.json));
  assert.equal(n.json.estado, 'borrador'); assert.equal(n.json.reemplaza_id, r.id);
  const viejo = await ver(r.id);
  assert.equal(viejo.estado, 'cancelado'); assert.equal(viejo.reemplazado_por, n.json.id);
});

test('Compras.RF12: cancelar exige motivo y un pedido sin correo del proveedor no sale por correo', async () => {
  const sin = (await api('POST', '/api/compras/proveedores', { token: administrativo.token, body: { cuit: '30500010912', razon_social: 'Sin correo SA', consultar_arca: false } }));
  const r = (await pedido(sin.status === 201 ? { proveedor_id: sin.json.id } : {})).json;
  await op(r.id, 'confirmar');
  if (sin.status === 201) assert.equal((await op(r.id, 'enviar', { via: 'correo' })).json.codigo, 'SIN_CORREO');
  assert.equal((await op(r.id, 'cancelar', {})).status, 400);
  assert.equal((await op(r.id, 'cancelar', { motivo: 'ya no hace falta' })).json.estado, 'cancelado');
  assert.equal((await op(r.id, 'cancelar', { motivo: 'otra vez' })).status, 409);
});

test('Compras.RF17: el puerto plazosEntrega da el plazo del proveedor principal y Stock lo usa en la reposicion', async () => {
  await api('PUT', `/api/compras/costos/insumo/${harina.id}`, { token: gerente.token, body: { costo: 1000, motivo: 'precio de bolsa', proveedor_id: prov.id } });
  await api('PUT', `/api/compras/costos/insumo/${cafe.id}`, { token: gerente.token, body: { costo: 100, motivo: 'inicial', proveedor_id: prov.id } });
  const p = await puertos.obtener('plazosEntrega');
  assert.equal(await p.plazo({ item_tipo: 'insumo', item_id: harina.id }), 2);
  assert.equal(await p.plazo({ item_tipo: 'insumo', item_id: huerfano.id }), null);
});

const consumir = async (i, porDia) => {
  for (let d = 1; d <= 56; d++) await pool.query("INSERT INTO stock_movimientos (id_global, insumo_id, deposito_id, tipo, motivo, cantidad, documento_tipo, created_at) VALUES (?, ?, ?, 'venta', 'venta', ?, 'venta', ?)",
    [`HISTP-${i.id}-${d}-${++g}`, i.id, dep, -porDia, new Date(Date.now() - d * DIA + 3600000)]);
};

test('Compras.RF20/RN26/EX17: la sugerencia se agrupa por proveedor principal, redondea a la presentacion y nunca compra sola', async () => {
  await Mov.ingresar({ deposito_id: dep, motivo: 'compra', proveedor: 'x', lineas: [{ item: { tipo: 'insumo', id: harina.id }, cantidad: 8, costo_unitario: 1 }, { item: { tipo: 'insumo', id: huerfano.id }, cantidad: 8, costo_unitario: 1 }] }, { userId: 1 });
  await consumir(harina, 2); await consumir(huerfano, 2);
  await api('PUT', `/api/reposicion-auto/items/insumo/${huerfano.id}`, { token: adm.token, body: { plazo_entrega_dias: 3 } }); // sin proveedor, usa el plazo manual
  const antes = (await pool.query('SELECT COUNT(*) n FROM cmp_pedidos'))[0][0].n;
  const s = (await api('GET', '/api/compras/pedidos/sugerencia', { token: gerente.token }));
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const grupo = s.json.propuestas.find((x) => x.proveedor_id === prov.id);
  const l = grupo.lineas.find((x) => x.item.id === harina.id);
  assert.equal(l.presentacion_id, bolsa.id);
  assert.ok(l.cantidad_sugerida > 25 && l.cantidad === Math.ceil(l.cantidad_sugerida / 25)); // en bolsas, hacia arriba
  assert.ok(l.explicacion.consumo_diario > 0);
  assert.ok(s.json.sin_proveedor.some((x) => x.item_id === huerfano.id)); // sin proveedor queda afuera
  assert.equal((await pool.query('SELECT COUNT(*) n FROM cmp_pedidos'))[0][0].n, antes); // la sugerencia no genera pedidos
  const body = { proveedor_id: prov.id, calculada_ms: s.json.calculada_ms, lineas: [{ ...l, cantidad: l.cantidad + 1 }] };
  assert.equal((await api('POST', '/api/compras/pedidos/desde-sugerencia', { token: administrativo.token, body })).status, 201); // administrativo confirma
  const viejo = await api('POST', '/api/compras/pedidos/desde-sugerencia', { token: gerente.token, body: { ...body, calculada_ms: Date.now() - 25 * 3600000 } });
  assert.equal(viejo.json.codigo, 'SUGERENCIA_VIEJA');
  const sinProv = await api('POST', '/api/compras/pedidos/desde-sugerencia', { token: gerente.token, body: { ...body, lineas: [{ item: { tipo: 'insumo', id: huerfano.id }, cantidad: 1 }] } });
  assert.equal(sinProv.json.codigo, 'ITEM_SIN_PROVEEDOR');
  const ok = await api('POST', '/api/compras/pedidos/desde-sugerencia', { token: gerente.token, body });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.origen, 'sugerencia'); assert.equal(ok.json.estado, 'borrador');
  assert.equal(ok.json.lineas[0].cantidad_sugerida, l.cantidad_sugerida);
});

test('Compras.RF12: el pedido pendiente viaja a Stock como en transito (baja la sugerencia) y la recepcion lo cierra', async () => {
  const sug = async () => (await Repo.sugerir({})).find((x) => x.item_id === harina.id);
  const antes = await sug();
  const r = (await pedido({ lineas: [{ item: { tipo: 'insumo', id: harina.id }, presentacion_id: bolsa.id, cantidad: 2, precio_estimado: 1000 }] })).json; // 2 bolsas = 50 kg
  await op(r.id, 'confirmar');
  await esperarMensajes(pool);
  const [[t]] = await pool.query('SELECT cantidad FROM stock_pedidos_transito WHERE pedido_id_global = ?', [r.id_global]);
  assert.equal(Number(t.cantidad), 50);
  const despues = await sug();
  assert.equal(despues.en_transito, 50);
  assert.equal(despues.sugerida, Math.max(0, Math.round((antes.sugerida - 50) * 1000) / 1000));
  assert.equal((await op(r.id, 'recepcion', { estado: 'recibido' })).json.codigo, 'CON_STOCK'); // con Stock el estado lo mueve la recepcion

  // Llega 1 bolsa (25 kg) y se factura: el pedido queda recibido parcial; con la segunda queda recibido.
  const ingreso = async (kg) => (await Mov.ingresar({ deposito_id: dep, motivo: 'compra', proveedor: 'Molino Pedidos SA', comprobante: { cuit: CUIT, clase: 'REMITO', tipo: 'X', punto_venta: '1', numero: String(++k + 7000) },
    lineas: [{ item: { tipo: 'insumo', id: harina.id }, cantidad: kg, costo_unitario: 40 }] }, { userId: 1 })).id_global;
  const facturar = async (bolsas) => {
    const neto = bolsas * 1000, iva = neto * 0.21;
    const f = await api('POST', '/api/compras/comprobantes', { token: administrativo.token, body: { cuit: CUIT, clase: 'FACTURA', tipo: 'A', punto_venta: 1, numero: String(++k + 9000), fecha: hoyMas(0), alicuotas: [{ alicuota: 21, neto, iva }], otros_tributos: k, total: neto + iva + k,
      lineas: [{ tipo: 'mercaderia', item: { tipo: 'insumo', id: harina.id }, descripcion: 'Harina', presentacion_id: bolsa.id, cantidad: bolsas, precio_unitario: 1000 }] } });
    assert.equal(f.status, 201, JSON.stringify(f.json));
    return f.json;
  };
  const f1 = await facturar(1);
  const v1 = await api('POST', `/api/compras/comprobantes/${f1.id}/vincular`, { token: administrativo.token, body: { ingreso_ids: [await ingreso(25)] } });
  assert.equal(v1.status, 200, JSON.stringify(v1.json));
  let p = await ver(r.id);
  assert.equal(p.estado, 'recibido_parcial'); assert.equal(p.lineas[0].cantidad_recibida, 25);
  await esperarMensajes(pool);
  assert.equal((await sug()).en_transito, 25);
  const f2 = await facturar(1);
  await api('POST', `/api/compras/comprobantes/${f2.id}/vincular`, { token: administrativo.token, body: { ingreso_ids: [await ingreso(25)] } });
  p = await ver(r.id);
  assert.equal(p.estado, 'recibido');
  await esperarMensajes(pool);
  assert.equal((await sug())?.en_transito ?? 0, 0); // cerrado: ya no esta en transito
});
