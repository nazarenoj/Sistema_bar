const crypto = require('crypto');
const pool = require('../config/db');
const Catalogo = require('./catalogoService');
const Cuentas = require('./cuentaService');
const Cupones = require('./cuponService');
const { TiendaInvalida } = require('./tiendaService');

// Carrito (Ventas Online RF06, RN05, RN23, EX09, EX12): se guarda N días para invitados y para cuentas, y se recalcula (precio, disponibilidad, cupón) cada vez que se muestra. Un artículo
// despublicado desaparece del carrito con un aviso (EX12); un cambio de precio se informa con el precio anterior y el nuevo; el precio recién queda fijo al confirmar el checkout.
const invalida = (m, status = 400, extra = {}) => Object.assign(new TiendaInvalida(m), { status, ...extra });
const r2 = (x) => Math.round(Number(x) * 100) / 100;
const MAX_LINEAS = 50;

const cargar = async (token, db = pool) => {
  const [[c]] = await db.query('SELECT * FROM onl_carritos WHERE token = ?', [String(token ?? '')]);
  if (!c || Number(c.vence_ms) <= Date.now()) return null;
  return { ...c, items: JSON.parse(c.items), cliente_online_id: c.cliente_online_id };
};
const guardar = async (c) => {
  const [[t]] = await pool.query('SELECT carrito_dias FROM onl_tienda WHERE id = 1');
  const ahora = Date.now();
  await pool.query('UPDATE onl_carritos SET items = ?, cupon = ?, cliente_online_id = ?, actualizado_ms = ?, vence_ms = ? WHERE token = ?', [JSON.stringify(c.items), c.cupon ?? null, c.cliente_online_id ?? null, ahora, ahora + t.carrito_dias * 86400000, c.token]);
};
const nuevo = async (cuenta) => {
  const token = crypto.randomBytes(24).toString('hex');
  const [[t]] = await pool.query('SELECT carrito_dias FROM onl_tienda WHERE id = 1');
  const ahora = Date.now();
  await pool.query('INSERT INTO onl_carritos (token, cliente_online_id, items, creado_ms, actualizado_ms, vence_ms) VALUES (?, ?, ?, ?, ?, ?)', [token, cuenta?.id ?? null, '[]', ahora, ahora, ahora + t.carrito_dias * 86400000]);
  return cargar(token);
};
const exigirCarrito = async (token) => {
  const c = await cargar(token);
  if (!c) throw invalida('El carrito no existe o venció.', 404, { codigo: 'CARRITO_NO_EXISTE' });
  return c;
};

const pesable = async (productoId) => ((await pool.query("SELECT tipo FROM productos WHERE id = ?", [productoId]))[0][0]?.tipo ?? '') === 'pesable';
const mismaSeleccion = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Recalcula el carrito completo: quita lo despublicado, reprecia y compara con el precio que se había mostrado, marca lo que no alcanza y valida el cupón. Guarda los precios vistos.
const calcular = async (c, cuenta = null) => {
  const listaId = await Cuentas.listaDe(cuenta);
  const quien = cuenta ? `c:${cuenta.id}` : null;
  const avisos = [], lineas = [], quitadas = [];
  for (const it of c.items) {
    const f = await Catalogo.publicado(it.producto_id);
    if (!f) { quitadas.push(it); avisos.push({ tipo: 'articulo_quitado', linea: it.linea, mensaje: `"${it.titulo ?? 'Un artículo'}" ya no está disponible y se quitó del carrito.` }); continue; } // EX12
    let sel;
    try { sel = await Catalogo.seleccion(it.producto_id, it.opciones, { listaId }); } catch (err) { quitadas.push(it); avisos.push({ tipo: 'articulo_quitado', linea: it.linea, mensaje: `"${f.titulo || f.nombre}" cambió sus opciones y se quitó: volvé a agregarlo.` }); continue; }
    const ficha = await Catalogo.ficha(f, { listaId });
    const [[prod]] = await pool.query('SELECT categoria_id FROM productos WHERE id = ?', [it.producto_id]);
    const l = { linea: it.linea, producto_id: it.producto_id, titulo: sel.titulo, opciones: sel.opciones.map((o) => ({ id: o.opcion_id, nombre: o.nombre, ajuste: Number(o.ajuste_precio_aplicado) })), observaciones: it.observaciones ?? null,
      cantidad: it.cantidad, precio_unitario: sel.precio_unitario, importe: r2(sel.precio_unitario * it.cantidad), alergenos: sel.alergenos, categoria_id: prod?.categoria_id ?? null,
      disponible: ficha.disponible, sin_stock: !ficha.vendible, faltante: ficha.vendible && ficha.disponible !== null && it.cantidad > ficha.disponible };
    if (it.precio_visto !== undefined && Math.abs(it.precio_visto - sel.precio_unitario) > 0.004) {
      l.precio_anterior = it.precio_visto;
      avisos.push({ tipo: 'cambio_precio', linea: it.linea, mensaje: `El precio de "${sel.titulo}" cambió de ${it.precio_visto} a ${sel.precio_unitario}.`, anterior: it.precio_visto, nuevo: sel.precio_unitario });
    }
    if (l.sin_stock) avisos.push({ tipo: 'sin_stock', linea: it.linea, mensaje: `"${sel.titulo}" está agotado.` });
    else if (l.faltante) avisos.push({ tipo: 'cantidad_excedida', linea: it.linea, mensaje: `De "${sel.titulo}" quedan ${ficha.disponible}.`, disponible: ficha.disponible });
    lineas.push(l);
  }
  const subtotal = r2(lineas.reduce((a, l) => a + l.importe, 0));
  let cupon = null, descuento = 0;
  if (c.cupon) {
    const e = await Cupones.evaluar(c.cupon, lineas.map((l) => ({ linea: l.linea, producto_id: l.producto_id, categoria_id: l.categoria_id, importe: l.importe })), { quien });
    if (e.valido) { cupon = e.cupon; descuento = e.descuento; }
    else { cupon = { codigo: c.cupon, valido: false, motivo: e.motivo, causa: e.codigo }; avisos.push({ tipo: 'cupon_invalido', mensaje: e.motivo }); }
  }
  const total = Math.max(0, r2(subtotal - descuento));
  const envio = await Cupones.envioGratis(subtotal);
  return { lineas, quitadas, avisos, subtotal, cupon, descuento, total, envio_gratis: envio, cambios: avisos.length > 0, listaId };
};

// Muestra el carrito: recalcula, descarta lo que ya no se vende y guarda los precios que se acaban de mostrar.
const mostrar = async (token, cuenta = null) => {
  const c = await exigirCarrito(token);
  const r = await calcular(c, cuenta);
  const quedan = c.items.filter((i) => !r.quitadas.includes(i)).map((i) => ({ ...i, precio_visto: r.lineas.find((l) => l.linea === i.linea).precio_unitario }));
  const cuponVence = c.cupon && r.cupon?.valido === false && ['CUPON_VENCIDO', 'CUPON_AGOTADO', 'CUPON_NO_EXISTE', 'CUPONES_INACTIVOS'].includes(r.cupon.causa);
  await guardar({ ...c, items: quedan, cupon: cuponVence ? null : c.cupon });
  const { quitadas, listaId, ...vista } = r;
  void quitadas; void listaId;
  return { token: c.token, vence_ms: Number(c.vence_ms), ...vista };
};

const agregar = async (token, d, cuenta = null) => {
  let c = token ? await exigirCarrito(token) : await nuevo(cuenta);
  if (cuenta && !c.cliente_online_id) c.cliente_online_id = cuenta.id;
  const cantidad = Number(d.cantidad ?? 1);
  const productoId = Number(d.producto_id);
  if (!Number.isInteger(productoId)) throw invalida('Indicá el artículo.');
  const esPesable = await pesable(productoId);
  if (!(cantidad > 0) || (!esPesable && !Number.isInteger(cantidad)) || cantidad > 999) throw invalida(esPesable ? 'La cantidad debe ser mayor a cero.' : 'La cantidad es un entero entre 1 y 999.');
  const opciones = d.opciones ?? [];
  const listaId = await Cuentas.listaDe(cuenta);
  const sel = await Catalogo.seleccion(productoId, opciones, { listaId }); // EX23: grupo obligatorio incompleto o artículo no publicado
  const f = await Catalogo.publicado(productoId);
  const ficha = await Catalogo.ficha(f, { listaId });
  if (!ficha.vendible) throw invalida(`"${sel.titulo}" está agotado.`, 409, { codigo: 'SIN_STOCK' });
  const previa = c.items.find((i) => i.producto_id === productoId && mismaSeleccion(i.opciones, opciones) && (i.observaciones ?? null) === (d.observaciones ?? null));
  const total = (previa?.cantidad ?? 0) + cantidad;
  if (ficha.disponible !== null && total > ficha.disponible) throw invalida(`De "${sel.titulo}" quedan ${ficha.disponible}.`, 409, { codigo: 'CANTIDAD_EXCEDIDA', disponible: ficha.disponible });
  if (previa) { previa.cantidad = total; previa.precio_visto = sel.precio_unitario; } else {
    if (c.items.length >= MAX_LINEAS) throw invalida(`El carrito admite hasta ${MAX_LINEAS} líneas.`);
    c.items.push({ linea: (c.items.reduce((m, i) => Math.max(m, i.linea), 0)) + 1, producto_id: productoId, titulo: sel.titulo, opciones, observaciones: d.observaciones ? String(d.observaciones).slice(0, 255) : null, cantidad, precio_visto: sel.precio_unitario });
  }
  await guardar(c);
  return mostrar(c.token, cuenta);
};

const modificar = async (token, linea, cantidad, cuenta = null) => {
  const c = await exigirCarrito(token);
  const it = c.items.find((i) => i.linea === Number(linea));
  if (!it) throw invalida('La línea no existe.', 404);
  if (Number(cantidad) === 0) c.items = c.items.filter((i) => i !== it);
  else {
    const esPesable = await pesable(it.producto_id);
    if (!(Number(cantidad) > 0) || (!esPesable && !Number.isInteger(Number(cantidad))) || Number(cantidad) > 999) throw invalida('La cantidad no es válida.');
    const f = await Catalogo.publicado(it.producto_id);
    const ficha = f ? await Catalogo.ficha(f, {}) : null;
    if (ficha && ficha.disponible !== null && Number(cantidad) > ficha.disponible) throw invalida(`Quedan ${ficha.disponible}.`, 409, { codigo: 'CANTIDAD_EXCEDIDA', disponible: ficha.disponible });
    it.cantidad = Number(cantidad);
  }
  await guardar(c);
  return mostrar(token, cuenta);
};
const quitar = (token, linea, cuenta) => modificar(token, linea, 0, cuenta);

const ponerCupon = async (token, codigo, cuenta = null) => {
  const c = await exigirCarrito(token);
  const r = await calcular({ ...c, cupon: String(codigo ?? '').trim() }, cuenta);
  if (r.cupon && r.cupon.valido === false) throw invalida(r.cupon.motivo, 400, { codigo: 'CUPON_INVALIDO' }); // EX10: el carrito sigue como estaba, sin descuento
  await guardar({ ...c, cupon: String(codigo).trim().toUpperCase() });
  return mostrar(token, cuenta);
};
const sacarCupon = async (token, cuenta) => { const c = await exigirCarrito(token); await guardar({ ...c, cupon: null }); return mostrar(token, cuenta); };

// Al iniciar sesión el carrito pasa a la cuenta y se recalcula con su lista (RF08, RN47): se informa el precio anterior y el nuevo.
const asociar = async (token, cuenta) => {
  const c = await exigirCarrito(token);
  await guardar({ ...c, cliente_online_id: cuenta.id });
  return mostrar(token, cuenta);
};

const limpiarVencidos = async () => (await pool.query('DELETE FROM onl_carritos WHERE vence_ms < ?', [Date.now()]))[0].affectedRows;

module.exports = { mostrar, agregar, modificar, quitar, ponerCupon, sacarCupon, asociar, calcular, cargar, exigirCarrito, limpiarVencidos };
