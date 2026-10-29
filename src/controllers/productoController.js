const Producto = require('../models/productoModel');
const Insumo = require('../models/insumoModel');
const Presentacion = require('../models/presentacionModel');
const puertos = require('../modulos/puertos');
const logger = require('../utils/logger');

const TIPOS = ['estandar', 'variante', 'pesable', 'fraccionable', 'combo', 'elaborado', 'servicio'];
const IVA = [0, 2.5, 5, 10.5, 21, 27]; // alícuotas vigentes de ARCA
const CAMPOS_TEXTO = ['sku', 'codigo_barras'];
const CAMPOS_ENTEROS = ['categoria_id', 'sector_id', 'producto_base_id'];
const CAMPOS_PESO = ['tara', 'peso_minimo', 'peso_maximo'];

// Valida los campos del catálogo (B1) que vengan en el cuerpo; los que faltan no se tocan.
const validarCatalogo = (b) => {
  const e = [];
  const hay = (c) => b[c] !== undefined && b[c] !== null;
  if (b.tipo !== undefined && !TIPOS.includes(b.tipo)) e.push(`El campo "tipo" debe ser uno de: ${TIPOS.join(', ')}.`);
  if (b.alicuota_iva !== undefined && !IVA.includes(Number(b.alicuota_iva))) e.push(`El campo "alicuota_iva" debe ser una de: ${IVA.join(', ')}.`);
  for (const c of CAMPOS_TEXTO) if (hay(c) && typeof b[c] !== 'string') e.push(`El campo "${c}" debe ser texto.`);
  for (const c of CAMPOS_ENTEROS) if (hay(c) && !Number.isInteger(b[c])) e.push(`El campo "${c}" debe ser un entero.`);
  for (const c of CAMPOS_PESO) if (hay(c) && !(Number(b[c]) >= 0)) e.push(`El campo "${c}" debe ser un número mayor o igual a cero.`);
  if (hay('peso_minimo') && hay('peso_maximo') && Number(b.peso_minimo) > Number(b.peso_maximo))
    e.push('"peso_minimo" no puede ser mayor que "peso_maximo".');
  return e;
};

// Ventas RN04/EX55: el peso de un pesable debe ser una lectura estable, mayor que cero y dentro de [mínimo, máximo].
// Devuelve el peso neto (bruto - tara) o lanza con el motivo del rechazo.
const validarPeso = (producto, bruto, estable) => {
  if (!estable) throw new Error('La lectura de la balanza no es estable.');
  const neto = Number(bruto) - Number(producto.tara || 0);
  if (!(neto > 0)) throw new Error('El peso debe ser mayor que cero.');
  if (producto.peso_minimo !== null && neto < Number(producto.peso_minimo)) throw new Error(`El peso mínimo es ${producto.peso_minimo}.`);
  if (producto.peso_maximo !== null && neto > Number(producto.peso_maximo)) throw new Error(`El peso máximo es ${producto.peso_maximo}.`);
  return neto;
};

// Campos de catálogo del cuerpo; el texto se recorta y vacío = sin valor.
const catalogo = (b) => ({
  ...Object.fromEntries(['tipo', 'alicuota_iva', ...CAMPOS_TEXTO, ...CAMPOS_ENTEROS, ...CAMPOS_PESO]
    .filter((c) => b[c] !== undefined).map((c) => [c, typeof b[c] === 'string' ? b[c].trim() || null : b[c]])),
  ...(b.agotado !== undefined && { agotado: b.agotado ? 1 : 0 }),
});

// SKU o código repetido, o categoría/sector/producto base inexistente.
const errorDeClave = (err, res) => {
  if (err.code === 'ER_DUP_ENTRY') {
    const campo = /sku/.test(err.message) ? 'SKU' : 'código de barras';
    res.status(409).json({ error: `Ya existe un producto con ese ${campo}.`, codigo: 'CODIGO_DUPLICADO' });
    return true;
  }
  if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    res.status(400).json({ error: 'La categoría, el sector o el producto base indicado no existe.' });
    return true;
  }
  return false;
};

const validarCampos = ({ nombre, precio }) => {
  const errores = [];

  if (nombre === undefined || nombre === null) {
    errores.push('El campo "nombre" es obligatorio.');
  } else if (typeof nombre !== 'string' || nombre.trim() === '') {
    errores.push('El campo "nombre" no puede estar vacío.');
  }

  if (precio === undefined || precio === null) {
    errores.push('El campo "precio" es obligatorio.');
  } else if (typeof precio !== 'number' || isNaN(precio) || precio < 0) {
    errores.push('El campo "precio" debe ser un número mayor o igual a cero.');
  }

  return errores;
};

const getAll = async (req, res) => {
  try {
    const productos = await Producto.getAll();
    res.json(productos);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// GET /api/productos/:identifier — resuelve por ID (numérico) o por nombre (texto)
const getOne = async (req, res) => {
  const { identifier } = req.params;

  try {
    if (/^\d+$/.test(identifier)) {
      const id = parseInt(identifier, 10);
      const producto = await Producto.getById(id);
      if (!producto) {
        return res.status(404).json({ error: `Producto con id ${id} no encontrado.` });
      }
      return res.json(producto);
    }

    const productos = await Producto.getByNombre(identifier);
    if (!productos.length) {
      return res.status(404).json({ error: `No se encontraron productos con nombre "${identifier}".` });
    }
    return res.json(productos);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const create = async (req, res) => {
  const { nombre, precio, descripcion, stock } = req.body;

  const errores = [...validarCampos({ nombre, precio }), ...validarCatalogo(req.body)];
  if (errores.length) return res.status(400).json({ errores });

  if (stock !== undefined && (!Number.isInteger(stock) || stock < 0)) {
    return res.status(400).json({ errores: ['El campo "stock" debe ser un entero mayor o igual a cero.'] });
  }

  try {
    const nuevo = await Producto.create({
      nombre: nombre.trim(),
      precio,
      descripcion: descripcion?.trim() ?? null,
      stock: stock ?? 0,
      ...catalogo(req.body),
    });
    res.status(201).json(nuevo);
  } catch (err) {
    if (errorDeClave(err, res)) return;
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// El stock no se recibe acá: se fija al crear el producto y luego solo se descuenta
// automáticamente al cerrar cuentas (ver mesaController.cerrarCuenta).
const update = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });

  const { nombre, precio, descripcion } = req.body;

  const errores = [...validarCampos({ nombre, precio }), ...validarCatalogo(req.body)];
  if (errores.length) return res.status(400).json({ errores });

  try {
    const afectados = await Producto.update(id, {
      nombre: nombre.trim(),
      precio,
      descripcion: descripcion?.trim() ?? null,
      ...catalogo(req.body),
    });

    if (!afectados) return res.status(404).json({ error: `Producto con id ${id} no encontrado.` });

    const actualizado = await Producto.getById(id);
    res.json(actualizado);
  } catch (err) {
    if (errorDeClave(err, res)) return;
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const remove = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });

  try {
    const afectados = await Producto.remove(id);
    if (!afectados) return res.status(404).json({ error: `Producto con id ${id} no encontrado.` });

    res.status(200).json({ message: `Producto con id ${id} eliminado correctamente.` });
  } catch (err) {
    if (err.code === 'PRODUCTO_CON_PEDIDOS') {
      return res.status(409).json({
        error: 'Este producto ya fue usado en pedidos y no se puede eliminar. Marcalo como "no disponible" (stock 0) en su lugar.',
      });
    }
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// --- Combo: componentes (Ventas RN03)

const getComponentes = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });
  try {
    res.json(await Producto.getComponentes(id));
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// PUT /api/productos/:id/componentes  { componentes: [{ componente_id, cantidad }] } — reemplaza la lista completa.
const setComponentes = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });
  const { componentes } = req.body;
  if (!Array.isArray(componentes) || componentes.some((c) => !Number.isInteger(c.componente_id) || !(c.cantidad > 0)))
    return res.status(400).json({ error: 'El campo "componentes" debe ser una lista de { componente_id, cantidad > 0 }.' });
  if (new Set(componentes.map((c) => c.componente_id)).size !== componentes.length)
    return res.status(400).json({ error: 'Hay componentes repetidos.' });

  try {
    const combo = await Producto.getById(id);
    if (!combo) return res.status(404).json({ error: `Producto con id ${id} no encontrado.` });
    if (combo.tipo !== 'combo') return res.status(400).json({ error: 'Solo un producto de tipo "combo" tiene componentes.' });
    const rechazo = await Producto.setComponentes(id, componentes);
    if (rechazo) return res.status(400).json({ error: rechazo });
    res.json(await Producto.getComponentes(id));
  } catch (err) {
    if (errorDeClave(err, res)) return;
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// --- Receta: insumos que consume este producto (producto_insumos) ---

const getInsumosDeProducto = async (req, res) => {
  const producto_id = parseInt(req.params.id, 10);
  if (isNaN(producto_id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });

  try {
    const producto = await Producto.getById(producto_id);
    if (!producto) return res.status(404).json({ error: `Producto con id ${producto_id} no encontrado.` });

    const insumos = await Insumo.getByProducto(producto_id);
    res.json(insumos);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const addInsumoAProducto = async (req, res) => {
  const producto_id = parseInt(req.params.id, 10);
  if (isNaN(producto_id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });

  const { insumo_id, cantidad_consumida, presentacion_id } = req.body;
  if (!Number.isInteger(insumo_id) || insumo_id <= 0)
    return res.status(400).json({ error: 'El campo "insumo_id" debe ser un entero positivo.' });
  if (typeof cantidad_consumida !== 'number' || isNaN(cantidad_consumida) || cantidad_consumida <= 0)
    return res.status(400).json({ error: 'El campo "cantidad_consumida" debe ser un número mayor a cero.' });

  try {
    const producto = await Producto.getById(producto_id);
    if (!producto) return res.status(404).json({ error: `Producto con id ${producto_id} no encontrado.` });

    const insumo = await Insumo.getById(insumo_id);
    if (!insumo) return res.status(404).json({ error: `Insumo con id ${insumo_id} no encontrado.` });

    // La cantidad puede estar en una presentación de uso "receta" del insumo (gramos de un ítem que se controla en kg):
    // se guarda su ID y el factor de esa versión (RF02).
    let presentacion = null;
    if (presentacion_id !== undefined && presentacion_id !== null) {
      presentacion = await Presentacion.getById(presentacion_id);
      const vigente = presentacion && (!presentacion.vigente_hasta || new Date(presentacion.vigente_hasta) > new Date());
      if (!presentacion || presentacion.insumo_id !== insumo_id || !String(presentacion.usos).split(',').includes('receta') || !vigente)
        return res.status(400).json({ error: 'La presentación debe ser una presentación vigente de uso "receta" de ese insumo.' });
    }
    const linea = await Insumo.addToProducto(producto_id, insumo_id, cantidad_consumida, undefined, presentacion ? { presentacion_id: presentacion.id, factor_aplicado: presentacion.factor } : {});
    await (await puertos.obtener('stock')).recetaCambiada(producto_id, req.usuario?.sub);
    res.status(201).json(linea);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'Ese insumo ya está en la receta de este producto. Editá la cantidad en su lugar.' });
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const updateInsumoDeProducto = async (req, res) => {
  const producto_id = parseInt(req.params.id, 10);
  const linea_id = parseInt(req.params.insumoProductoId, 10);
  if (isNaN(producto_id) || isNaN(linea_id))
    return res.status(400).json({ error: 'Los parámetros "id" e "insumoProductoId" deben ser enteros válidos.' });

  const { cantidad_consumida } = req.body;
  if (typeof cantidad_consumida !== 'number' || isNaN(cantidad_consumida) || cantidad_consumida <= 0)
    return res.status(400).json({ error: 'El campo "cantidad_consumida" debe ser un número mayor a cero.' });

  try {
    const linea = await Insumo.getLinea(linea_id);
    if (!linea || linea.producto_id !== producto_id)
      return res.status(404).json({ error: `Insumo con id de línea ${linea_id} no encontrado en la receta de este producto.` });

    await Insumo.updateCantidad(linea_id, cantidad_consumida);
    await (await puertos.obtener('stock')).recetaCambiada(producto_id, req.usuario?.sub);
    res.json({ ...linea, cantidad_consumida });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const removeInsumoDeProducto = async (req, res) => {
  const producto_id = parseInt(req.params.id, 10);
  const linea_id = parseInt(req.params.insumoProductoId, 10);
  if (isNaN(producto_id) || isNaN(linea_id))
    return res.status(400).json({ error: 'Los parámetros "id" e "insumoProductoId" deben ser enteros válidos.' });

  try {
    const linea = await Insumo.getLinea(linea_id);
    if (!linea || linea.producto_id !== producto_id)
      return res.status(404).json({ error: `Insumo con id de línea ${linea_id} no encontrado en la receta de este producto.` });

    await Insumo.removeFromProducto(linea_id);
    await (await puertos.obtener('stock')).recetaCambiada(producto_id, req.usuario?.sub);
    res.json({ message: 'Insumo quitado de la receta.', producto_id, id: linea_id });
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

module.exports = {
  getAll, getOne, create, update, remove,
  getComponentes, setComponentes, validarPeso,
  getInsumosDeProducto, addInsumoAProducto, updateInsumoDeProducto, removeInsumoDeProducto,
};
