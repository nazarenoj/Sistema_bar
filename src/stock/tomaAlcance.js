// Alcance de una toma de inventario (Stock RF14): total, o acotado por depósito, categoría o selección de ítems.
// Aparte de la toma para que el libro de movimientos pueda consultarlo sin depender de ella.
class TomaBloqueada extends Error {
  constructor(mensaje, detalle = null, status = 409) { super(mensaje); this.detalle = detalle; this.status = status; }
}

const enAlcance = async (conn, alcance, tipo, id, deposito) => {
  if (alcance.deposito_id && Number(alcance.deposito_id) !== Number(deposito)) return false;
  if (Array.isArray(alcance.items) && !alcance.items.some((i) => i.tipo === tipo && Number(i.id) === Number(id))) return false;
  if (alcance.categoria_id) {
    if (tipo !== 'producto') return false;
    const [[p]] = await conn.query('SELECT categoria_id FROM productos WHERE id = ?', [id]);
    if (!p || Number(p.categoria_id) !== Number(alcance.categoria_id)) return false;
  }
  return true;
};

// Opción "Congelar movimientos manuales del alcance durante el conteo": mientras una toma así está en curso, los ingresos,
// egresos, transferencias y correcciones sobre sus ítems y depósitos se bloquean. Las ventas nunca se congelan.
const exigirLibre = async (conn, tipo, id, deposito) => {
  const [tomas] = await conn.query("SELECT id_global, alcance FROM tomas_inventario WHERE estado = 'en_curso' AND congelar_manual = 1");
  for (const t of tomas)
    if (await enAlcance(conn, JSON.parse(t.alcance), tipo, id, deposito))
      throw new TomaBloqueada(`El ${tipo} ${id} está en una toma de inventario en curso con los movimientos manuales congelados.`, { toma: t.id_global });
};

module.exports = { TomaBloqueada, enAlcance, exigirLibre };
