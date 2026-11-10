const Insumo = require('../models/insumoModel');
const logger = require('../utils/logger');

const validarCampos = ({ nombre, unidad, costo_unitario, disponible }) => {
  const errores = [];

  if (nombre === undefined || nombre === null) {
    errores.push('El campo "nombre" es obligatorio.');
  } else if (typeof nombre !== 'string' || nombre.trim() === '') {
    errores.push('El campo "nombre" no puede estar vacío.');
  }

  if (unidad === undefined || unidad === null) {
    errores.push('El campo "unidad" es obligatorio.');
  } else if (typeof unidad !== 'string' || unidad.trim() === '') {
    errores.push('El campo "unidad" no puede estar vacío.');
  }

  if (costo_unitario !== undefined && costo_unitario !== null) {
    if (typeof costo_unitario !== 'number' || isNaN(costo_unitario) || costo_unitario < 0) {
      errores.push('El campo "costo_unitario" debe ser un número mayor o igual a cero.');
    }
  }

  if (disponible !== undefined && disponible !== null && typeof disponible !== 'boolean') {
    errores.push('El campo "disponible" debe ser true o false.');
  }

  return errores;
};

const getAll = async (req, res) => {
  try {
    const insumos = await Insumo.getAll();
    res.json(insumos);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// GET /api/insumos/:identifier — resuelve por ID (numérico) o por nombre (texto)
const getOne = async (req, res) => {
  const { identifier } = req.params;

  try {
    if (/^\d+$/.test(identifier)) {
      const id = parseInt(identifier, 10);
      const insumo = await Insumo.getById(id);
      if (!insumo) {
        return res.status(404).json({ error: `Insumo con id ${id} no encontrado.` });
      }
      return res.json(insumo);
    }

    const insumos = await Insumo.getByNombre(identifier);
    if (!insumos.length) {
      return res.status(404).json({ error: `No se encontraron insumos con nombre "${identifier}".` });
    }
    return res.json(insumos);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const create = async (req, res) => {
  const { nombre, unidad, costo_unitario, stock, disponible, packaging } = req.body;

  const errores = validarCampos({ nombre, unidad, costo_unitario, disponible });
  if (stock !== undefined && stock !== null && (typeof stock !== 'number' || isNaN(stock) || stock < 0)) {
    errores.push('El campo "stock" debe ser un número mayor o igual a cero.');
  }
  if (errores.length) return res.status(400).json({ errores });

  try {
    const nuevo = await Insumo.create({
      nombre: nombre.trim(),
      unidad: unidad.trim(),
      costo_unitario: costo_unitario ?? null,
      stock: stock ?? 0,
      disponible: disponible ?? true,
      packaging: packaging === true,
    });
    res.status(201).json(nuevo);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

// El stock no se recibe acá: se fija al crear el insumo y luego solo se descuenta
// automáticamente al venderse productos que lo usan (ver mesaController/pedidoController).
const update = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });

  const { nombre, unidad, costo_unitario, disponible, packaging } = req.body;

  const errores = validarCampos({ nombre, unidad, costo_unitario, disponible });
  if (errores.length) return res.status(400).json({ errores });

  try {
    const actual = await Insumo.getById(id);
    if (!actual) return res.status(404).json({ error: `Insumo con id ${id} no encontrado.` });

    const afectados = await Insumo.update(id, {
      nombre: nombre.trim(),
      unidad: unidad.trim(),
      costo_unitario: costo_unitario ?? null,
      disponible: disponible ?? !!actual.disponible,
      packaging,
    });

    if (!afectados) return res.status(404).json({ error: `Insumo con id ${id} no encontrado.` });

    const actualizado = await Insumo.getById(id);
    res.json(actualizado);
  } catch (err) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

const remove = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'El parámetro "id" debe ser un número entero válido.' });

  try {
    const afectados = await Insumo.remove(id);
    if (!afectados) return res.status(404).json({ error: `Insumo con id ${id} no encontrado.` });

    res.status(200).json({ message: `Insumo con id ${id} eliminado correctamente.` });
  } catch (err) {
    if (err.code === 'INSUMO_CON_PRODUCTOS') {
      return res.status(409).json({
        error: 'Este insumo está siendo usado en la receta de uno o más productos y no se puede eliminar. Marcalo como "no disponible" en su lugar.',
      });
    }
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};

module.exports = { getAll, getOne, create, update, remove };
