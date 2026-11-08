const { Router } = require('express');
const registro = require('../instancias/registro');
const Modulos = require('../modulos/registro');
const Tienda = require('../ventas_online/tiendaService');
const Catalogo = require('../ventas_online/catalogoService');

// La parte pública de la tienda (Ventas Online RF01, RN01): rutas SIN sesión bajo /tienda/<codigo>. El código identifica la instancia; todo lo que sigue corre dentro de ella, así que una
// ruta pública no puede leer datos de otra. Sin la tienda activa (o sin el módulo) todo responde 404, y las respuestas solo traen lo que se puede mostrar.
const router = Router({ mergeParams: true });

const { general, pedidos, limitePedidos } = require('../ventas_online/limites');

router.use(general.middleware());
router.use(async (req, res, next) => {
  try {
    const inst = await Tienda.resolverCodigo(req.params.codigo, req.instancia);
    if (!inst) return res.status(404).json({ error: 'Tienda no encontrada.', codigo: 'TIENDA_NO_ENCONTRADA' });
    req.instancia = inst;
    registro.dentroDe(inst, async () => {
      try {
        const t = await Tienda.fila();
        if (!t?.activa || t.codigo !== String(req.params.codigo).toLowerCase() || !(await Modulos.estaInstalado('ventas_online')))
          return res.status(404).json({ error: 'Tienda no encontrada.', codigo: 'TIENDA_NO_ENCONTRADA' });
        next();
      } catch (err) { next(err); }
    });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => { try { res.json(await Tienda.publica()); } catch (err) { next(err); } });
router.get('/paginas/:slug', async (req, res, next) => {
  try {
    const p = await Tienda.paginaPublica(req.params.slug);
    if (!p) return res.status(404).json({ error: 'Página no encontrada.', codigo: 'PAGINA_NO_ENCONTRADA' });
    res.json(p);
  } catch (err) { next(err); }
});

router.get('/catalogo', async (req, res, next) => {
  try { res.json(await Catalogo.publicados({ q: req.query.q, categoria: req.query.categoria, orden: req.query.orden, sinAlergenos: String(req.query.sin_alergenos ?? '').split(',').filter(Boolean) })); } catch (err) { next(err); }
});
router.get('/catalogo/:id', async (req, res, next) => {
  try {
    const d = await Catalogo.detalle(Number(req.params.id));
    if (!d) return res.status(404).json({ error: 'Artículo no encontrado.', codigo: 'ARTICULO_NO_ENCONTRADO' });
    res.json(d);
  } catch (err) { next(err); }
});
router.post('/catalogo/:id/seleccion', async (req, res, next) => {
  try { res.json(await Catalogo.seleccion(Number(req.params.id), req.body?.opciones ?? [])); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.codigo && { codigo: err.codigo }), ...(err.grupo && { grupo: err.grupo }) });
    next(err);
  }
});
router.get('/categorias', async (req, res, next) => { try { res.json(await Catalogo.categoriasPublicas()); } catch (err) { next(err); } });

router.use(require('./onlCarritoRoutes'));
router.use(require('./onlCheckoutRoutes'));

module.exports = router;
module.exports.limitePedidos = limitePedidos;
module.exports.limitadores = { general, pedidos };
