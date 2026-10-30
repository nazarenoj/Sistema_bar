require('dotenv').config();
const path = require('path');
const express = require('express');
const { version: VERSION } = require('../package.json');
const pool             = require('./config/db');
const authRoutes       = require('./routes/authRoutes');
const productoRoutes   = require('./routes/productoRoutes');
const catalogoRoutes   = require('./routes/catalogoRoutes');
const ventaRoutes      = require('./routes/ventaRoutes');
const formaPagoRoutes  = require('./routes/formaPagoRoutes');
const devolucionRoutes = require('./routes/devolucionRoutes');
const precioRoutes     = require('./routes/precioRoutes');
const comandaRoutes    = require('./routes/comandaRoutes');
const padronRoutes     = require('./routes/padronRoutes');
const depositoRoutes   = require('./routes/depositoRoutes');
const presentacionRoutes = require('./routes/presentacionRoutes');
const stockRoutes      = require('./routes/stockRoutes');
const recetaRoutes     = require('./routes/recetaRoutes');
const inventarioRoutes = require('./routes/inventarioRoutes');
const loteRoutes       = require('./routes/loteRoutes');
const mantenimientoStock = require('./stock/mantenimientoStock');
const insumoRoutes     = require('./routes/insumoRoutes');
const mesaRoutes       = require('./routes/mesaRoutes');
const pedidoRoutes     = require('./routes/pedidoRoutes');
const salonRoutes      = require('./routes/salonRoutes');
const estructuraRoutes = require('./routes/estructuraRoutes');
const sillaRoutes      = require('./routes/sillaRoutes');
const facturaRoutes    = require('./routes/facturaRoutes');
const usuarioRoutes    = require('./routes/usuarioRoutes');
const terminalRoutes   = require('./routes/terminalRoutes');
const sesionRoutes     = require('./routes/sesionRoutes');
const auditoriaRoutes  = require('./routes/auditoriaRoutes');
const rolRoutes        = require('./routes/rolRoutes');
const moduloRoutes     = require('./routes/moduloRoutes');
const funcionRoutes    = require('./routes/funcionRoutes');
const integracionRoutes = require('./routes/integracionRoutes');
const notificacionRoutes = require('./routes/notificacionRoutes');
const trabajador       = require('./mensajeria/trabajador');
const resolucion       = require('./services/resolucionService');
const Funciones        = require('./funciones/servicio');
const { ping }         = require('./controllers/terminalController');
const requireAuth      = require('./middleware/authMiddleware');
const instancia        = require('./middleware/instancia');
const idempotencia     = require('./middleware/idempotencia');
const horaCliente      = require('./middleware/horaCliente');
require('./models/insumoPuerto'); // Stock registra lo que implementa de los puertos de Ventas
require('./services/costoVentaReceptor'); // Ventas guarda el costo que Stock informa al confirmar el descuento
const requestLogger    = require('./middleware/requestLogger');
const errorHandler     = require('./middleware/errorHandler');
const logger           = require('./utils/logger');

// Errores que no pasaron por ningún try/catch (bug de programación, no una falla de negocio
// esperada): se registran para poder diagnosticarlos y, en el caso de uncaughtException, se
// corta el proceso porque el estado interno de Node ya no es confiable después de eso.
process.on('unhandledRejection', (reason) => {
  logger.error(`unhandledRejection: ${reason?.message || reason}`, { stack: reason?.stack });
});
process.on('uncaughtException', async (err) => {
  await logger.logFatal(`uncaughtException: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(requestLogger);

// /health no depende de ningún cliente; todo lo demás corre dentro de la instancia de la request.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: VERSION, timestamp: new Date().toISOString() });
});
app.use('/api', instancia);

app.get('/api', (req, res) => {
  res.json({
    api: 'Sistema Chepola',
    version: VERSION,
    endpoints: {
      health:   'GET  /health',
      login:    'POST /api/auth/login',
      listar:   'GET  /api/productos',
      buscar:   'GET  /api/productos/:id_o_nombre',
      crear:    'POST /api/productos',
      actualizar: 'PUT  /api/productos/:id',
      eliminar:        'DELETE /api/productos/:id',
      listar_insumos:  'GET    /api/insumos',
      crear_insumo:    'POST   /api/insumos',
      actualizar_insumo: 'PUT  /api/insumos/:id',
      eliminar_insumo: 'DELETE /api/insumos/:id',
      receta_producto: 'GET    /api/productos/:id/insumos',
      agregar_insumo_receta: 'POST   /api/productos/:id/insumos',
      editar_insumo_receta:  'PUT    /api/productos/:id/insumos/:insumoProductoId',
      quitar_insumo_receta:  'DELETE /api/productos/:id/insumos/:insumoProductoId',
      listar_mesas:    'GET    /api/mesas',
      crear_mesa:      'POST   /api/mesas',
      pedidos_activos: 'GET    /api/mesas/:id/pedidos-activos',
      mover_mesa:      'PATCH  /api/mesas/:id/posicion',
      cerrar_cuenta:   'POST   /api/mesas/:id/cerrar',
      ticket_cuenta:   'GET    /api/mesas/:id/ticket',
      abrir_pedido:    'POST   /api/pedidos',
      agregar_prod:    'POST   /api/pedidos/:id/productos',
      ticket_pedido:   'GET    /api/pedidos/:id/ticket',
      listar_salones:  'GET    /api/salones',
      crear_salon:     'POST   /api/salones',
      listar_estructuras: 'GET  /api/estructuras?salon_id=',
      combinar_mesas:  'POST   /api/mesas/combinar',
      separar_grupo:   'POST   /api/mesas/grupos/:grupoId/separar',
      agregar_silla:   'POST   /api/mesas/:id/sillas',
      mover_silla:     'PATCH  /api/sillas/:id/posicion',
      eliminar_silla:  'DELETE /api/sillas/:id',
      factura_config:   'GET    /api/facturas/config',
      factura_historial: 'GET   /api/facturas',
      factura_detalle:  'GET    /api/facturas/:id',
      factura_pdf:      'GET    /api/facturas/:id/pdf',
      factura_reintentar: 'POST  /api/facturas/:id/reintentar',
      factura_estado_afip: 'GET  /api/facturas/estado-afip',
    },
  });
});

app.use('/api/auth', authRoutes);
// El latido de la pantalla va antes del requireAuth general porque no debe contar como actividad
// del usuario (si no, una terminal abandonada nunca vencería por inactividad).
app.post('/api/terminales/ping', requireAuth.pasivo, ping);
app.use('/api', requireAuth);
// Las terminales se enteran de un cambio de funciones por la versión que viaja en cada respuesta (RN46).
app.use('/api', async (req, res, next) => {
  try { res.set('X-Config-Version', String(await Funciones.version())); } catch { /* sin alta todavía */ }
  next();
});

// Idempotencia de solicitudes (A9): una operación con efecto no se repite si llega dos veces.
app.get('/api/solicitudes/:id', idempotencia.estado);
app.use('/api', horaCliente);
app.use('/api', idempotencia);

app.use('/api/productos',   productoRoutes);
app.use('/api/ventas',      ventaRoutes);
app.use('/api/formas-pago', formaPagoRoutes);
app.use('/api/devoluciones', devolucionRoutes);
app.use('/api/precios',     precioRoutes);
app.use('/api/comandas',    comandaRoutes);
app.use('/api/padron',      padronRoutes);
app.use('/api/depositos',   depositoRoutes);
app.use('/api/presentaciones', presentacionRoutes);
app.use('/api/stock',       stockRoutes);
app.use('/api/recetas',     recetaRoutes);
app.use('/api/inventario',  inventarioRoutes);
app.use('/api/lotes',       loteRoutes);
app.use('/api/categorias',  catalogoRoutes.categorias);
app.use('/api/sectores',    catalogoRoutes.sectores);
app.use('/api/insumos',     insumoRoutes);
app.use('/api/mesas',       mesaRoutes);
app.use('/api/pedidos',     pedidoRoutes);
app.use('/api/salones',     salonRoutes);
app.use('/api/estructuras', estructuraRoutes);
app.use('/api/sillas',      sillaRoutes);
app.use('/api/facturas',    facturaRoutes);
app.use('/api/usuarios',    usuarioRoutes);
app.use('/api/terminales',  terminalRoutes);
app.use('/api/sesiones',    sesionRoutes);
app.use('/api/auditoria',   auditoriaRoutes);
app.use('/api/roles',       rolRoutes);
app.use('/api/modulos',     moduloRoutes);
app.use('/api/funciones',   funcionRoutes);
app.use('/api/integracion', integracionRoutes);
app.use('/api/notificaciones', notificacionRoutes);

// Sirve el build del frontend (mismo origen que la API, sin CORS). Se genera con
// `npm run build` dentro de frontend/ y no se versiona (frontend/dist está en .gitignore).
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendDist));

app.get(/^\/(?!api|health).*/, (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: `Ruta ${req.method} ${req.path} no encontrada.` });
});

app.use(errorHandler);

// En las pruebas (NODE_ENV=test) el servidor no arranca solo: la prueba prepara su propia base y
// escucha en un puerto libre.
if (process.env.NODE_ENV !== 'test') {
  pool.ensureDatabase()
    .then(() => {
      app.listen(PORT, () => {
        logger.info(`Servidor corriendo en http://localhost:${PORT}`);
        trabajador.iniciar(); // entrega de mensajes entre módulos y mantenimiento (A10)
        resolucion.iniciar(); // intentos de emisión indeterminados y validación de la numeración (B7)
        mantenimientoStock.iniciar(); // alertas de stock y diferencias de integración (C6)
      });
    })
    .catch(async (err) => {
      await logger.logFatal(`No se pudo verificar/crear la base de datos: [${err.code}] ${err.message}`, { stack: err.stack });
      process.exit(1);
    });
}

module.exports = app;
