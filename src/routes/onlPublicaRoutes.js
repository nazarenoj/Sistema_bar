const { Router } = require('express');
const registro = require('../instancias/registro');
const Modulos = require('../modulos/registro');
const Tienda = require('../ventas_online/tiendaService');
const Limitador = require('../ventas_online/limitador');
const Catalogo = require('../ventas_online/catalogoService');

// La parte pública de la tienda (Ventas Online RF01, RN01): rutas SIN sesión bajo /tienda/<codigo>. El código identifica la instancia; todo lo que sigue corre dentro de ella, así que una
// ruta pública no puede leer datos de otra. Sin la tienda activa (o sin el módulo) todo responde 404, y las respuestas solo traen lo que se puede mostrar.
const router = Router({ mergeParams: true });

const general = Limitador.crear({ ventanaMs: 60000, maximo: 120 });
// Los pedidos tienen su propio tope por hora, que fija cada tienda (Ventas Online RN56); lo usa el checkout (I5).
const pedidos = Limitador.crear({ ventanaMs: 3600000, maximo: 20, mensaje: 'Hiciste demasiados pedidos seguidos. Probá más tarde.' });
const limitePedidos = pedidos.middleware(async () => (await Tienda.fila()).limite_pedidos_ip_hora);

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
  try { res.json(await Catalogo.publicados({ q: req.query.q, categoria: req.query.categoria, orden: req.query.orden })); } catch (err) { next(err); }
});
router.get('/categorias', async (req, res, next) => { try { res.json(await Catalogo.categoriasPublicas()); } catch (err) { next(err); } });

module.exports = router;
module.exports.limitePedidos = limitePedidos;
module.exports.limitadores = { general, pedidos };
