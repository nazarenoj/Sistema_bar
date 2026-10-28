const pool = require('../config/db');
const instancias = require('../instancias/registro');
const { MODULOS } = require('./catalogo');

// Módulos instalados en la instancia (tabla modulos_instalados). Se guardan unos segundos en
// memoria porque cada publicador de mensajes y cada llamada entre módulos lo consulta.
const TTL_MS = 5000;
const cache = new Map(); // codigo de instancia -> { set, hasta }

// Valida el estado de instalación contra las reglas de capas. Devuelve la lista de problemas (vacía
// si es válido). Es una función pura para poder probar catálogos hipotéticos.
//   - cada dependencia tiene que existir, estar instalada y ser de una capa inferior;
//   - una misma capa N3 no se llama entre sí (no se pueden declarar dependencia entre pares);
//   - no puede haber ciclos.
const validar = (catalogo, instalados) => {
  const problemas = [];
  for (const cod of instalados) {
    const m = catalogo[cod];
    if (!m) { problemas.push(`El módulo "${cod}" no existe.`); continue; }
    for (const dep of m.dependeDe) {
      const d = catalogo[dep];
      if (!d) problemas.push(`${cod} depende de "${dep}", que no existe.`);
      else if (d.capa > m.capa) problemas.push(`${cod} (N${m.capa}) no puede depender de ${dep} (N${d.capa}): sería una llamada hacia arriba.`);
      else if (d.capa === m.capa) problemas.push(`${cod} y ${dep} son de la misma capa (N${m.capa}) y no pueden llamarse entre sí.`);
      else if (!instalados.includes(dep)) problemas.push(`${cod} necesita que esté instalado ${dep}.`);
    }
  }
  // Ciclos: búsqueda en profundidad sobre las dependencias declaradas.
  const estado = {};
  const visita = (cod, ruta) => {
    if (estado[cod] === 2 || !catalogo[cod]) return;
    if (estado[cod] === 1) { problemas.push(`Ciclo de dependencias: ${[...ruta, cod].join(' → ')}.`); return; }
    estado[cod] = 1;
    for (const dep of catalogo[cod].dependeDe) visita(dep, [...ruta, cod]);
    estado[cod] = 2;
  };
  for (const cod of instalados) visita(cod, []);
  return problemas;
};

const instaladosSet = async () => {
  const { codigo } = instancias.actual();
  const c = cache.get(codigo);
  if (c && Date.now() < c.hasta) return c.set;
  const [rows] = await pool.query('SELECT codigo FROM modulos_instalados');
  const set = new Set(rows.map((r) => r.codigo));
  cache.set(codigo, { set, hasta: Date.now() + TTL_MS });
  return set;
};

const invalidar = () => cache.delete(instancias.actual().codigo);

const estaInstalado = async (codigo) => (await instaladosSet()).has(codigo);

const listar = async () => {
  const set = await instaladosSet();
  return Object.entries(MODULOS).map(([codigo, m]) => ({
    codigo, nombre: m.nombre, capa: m.capa, dependeDe: m.dependeDe,
    obligatorio: !!m.obligatorio, disponible: !m.noConstruido, instalado: set.has(codigo),
  }));
};

// Instala un módulo si el estado resultante es válido; si no, no cambia nada y devuelve los problemas.
const instalar = async (codigo, catalogo = MODULOS, actor = null) => {
  const actuales = [...(await instaladosSet())];
  if (!catalogo[codigo]) return { ok: false, problemas: [`El módulo "${codigo}" no existe.`] };
  if (catalogo[codigo].noConstruido) return { ok: false, problemas: [`${catalogo[codigo].nombre} todavía no está disponible.`] };
  const problemas = validar(catalogo, [...new Set([...actuales, codigo])]);
  if (problemas.length) return { ok: false, problemas };
  const Funciones = require('../funciones/servicio'); // carga diferida: las funciones consultan este registro
  // EX30: si instalarlo deja una función activa sin un requisito condicional, no se instala hasta resolverlo.
  const conflictos = await Funciones.conflictosAlInstalar(codigo);
  if (conflictos.length) return { ok: false, problemas: conflictos.map((c) => `No se puede instalar ${codigo} todavía: ${c}.`) };
  const antes = (await Funciones.estado()).funciones;
  await pool.query('INSERT IGNORE INTO modulos_instalados (codigo) VALUES (?)', [codigo]);
  invalidar();
  await Funciones.registrarCambioDeModulo(antes, actor);
  return { ok: true, problemas: [] };
};

// Desinstalar conserva los datos y los permisos (inactivos, RN10); se bloquea si otro módulo instalado lo necesita.
const desinstalar = async (codigo, catalogo = MODULOS, actor = null) => {
  if (!catalogo[codigo]) return { ok: false, problemas: [`El módulo "${codigo}" no existe.`] };
  if (catalogo[codigo].obligatorio) return { ok: false, problemas: [`${catalogo[codigo].nombre} es obligatorio y no se desinstala.`] };
  const actuales = [...(await instaladosSet())].filter((c) => c !== codigo);
  const problemas = validar(catalogo, actuales);
  if (problemas.length) return { ok: false, problemas };
  const Funciones = require('../funciones/servicio');
  const antes = (await Funciones.estado()).funciones;
  await pool.query('DELETE FROM modulos_instalados WHERE codigo = ?', [codigo]);
  invalidar();
  await Funciones.registrarCambioDeModulo(antes, actor);
  return { ok: true, problemas: [] };
};

module.exports = { validar, estaInstalado, listar, instalar, desinstalar, invalidar };
