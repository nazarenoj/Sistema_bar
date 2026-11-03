const pool = require('../config/db');
const Desinstalacion = require('../modulos/desinstalacion');

// Documentos que Stock tiene abiertos y hay que cerrar o asignar antes de desinstalarlo (Usuarios RN87, EX59).
Desinstalacion.registrarDocumentosAbiertos('stock', async () => {
  const [[{ n: tomas }]] = await pool.query("SELECT COUNT(*) AS n FROM tomas_inventario WHERE estado = 'en_curso'");
  const [[{ n: ordenes }]] = await pool.query("SELECT COUNT(*) AS n FROM ordenes_produccion WHERE estado = 'borrador'");
  return [
    { tipo: 'tomas_inventario', cantidad: Number(tomas), detalle: 'Tomas de inventario en curso: aprobalas o cancelalas.' },
    { tipo: 'ordenes_produccion', cantidad: Number(ordenes), detalle: 'Órdenes de producción en borrador: confirmalas o cancelalas.' },
  ];
});
