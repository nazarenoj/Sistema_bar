const pool = require('../config/db');
const { FUNCIONES, PERFILES, porId } = require('./catalogo');
const { MODULOS } = require('../modulos/catalogo');

// Servicio de funcionalidades activables (Usuarios RF18). Todas las operaciones de base de datos
// reciben `db` (por defecto el pool de la instancia en curso) para poder usarlas desde el alta de
// instancia, que trabaja con su propia conexión.

// Comprobaciones que cada módulo registra para sus funciones: documentos pendientes (RN27) y datos
// vigentes que impiden desactivar (RN27). Devuelven listas de textos; vacía = nada que avisar.
const comprobaciones = new Map(); // funcion_id -> { pendientes?, datosVigentes? }
const registrarComprobacion = (id, fns) => {
  if (!porId[id]) throw new Error(`La función "${id}" no existe en el catálogo.`);
  comprobaciones.set(id, fns);
};

const nombreModulo = (cod) => MODULOS[cod]?.nombre ?? cod;

// ---- Cálculo puro (sin base de datos) ----

// Valor deseado de cada función: el guardado, o el base del catálogo.
const deseadoBase = () => new Map(FUNCIONES.map((x) => [x.id, x.base]));

// Qué impide que una función esté realmente activa, dado lo deseado y los módulos instalados.
// null = nada. Es el texto que se muestra: "Requiere: <módulo/función>" (RN25).
const motivoBloqueo = (id, deseado, instalados, memo = new Map()) => {
  const x = porId[id];
  if (!instalados.has(x.modulo)) return `Requiere: módulo ${nombreModulo(x.modulo)}`;
  for (const m of x.modulos) if (!instalados.has(m)) return `Requiere: módulo ${nombreModulo(m)}`;
  const activaEf = (fid) => {
    if (memo.has(fid)) return memo.get(fid);
    memo.set(fid, false); // corta ciclos
    const r = !!deseado.get(fid) && motivoBloqueo(fid, deseado, instalados, memo) === null;
    memo.set(fid, r);
    return r;
  };
  for (const fid of x.funciones) if (!activaEf(fid)) return `Requiere: ${fid}`;
  for (const c of x.condicional) {
    if (instalados.has(c.siModulo) && !activaEf(c.funcion)) return `Requiere: ${c.funcion} (porque ${nombreModulo(c.siModulo)} está instalado)`;
  }
  return null;
};

// Estado de todas las funciones: deseado, si está realmente activa y por qué no.
const evaluar = (deseado, instalados) => {
  const memo = new Map();
  return FUNCIONES.map((x) => {
    const bloqueo = motivoBloqueo(x.id, deseado, instalados, memo);
    const d = !!deseado.get(x.id);
    return {
      id: x.id, modulo: x.modulo, nombre: x.nombre, sanitaria: x.sanitaria, internet: x.internet,
      deseada: d, activa: d && bloqueo === null, deshabilitada: bloqueo !== null, motivo: bloqueo,
    };
  });
};

// Funciones realmente activas que dependen de `id`: por requisito duro o condicional vigente. Una
// deshabilitada por otro motivo (su módulo no está instalado) no se toca: conserva su valor (RN32).
const dependientes = (id, deseado, instalados) => {
  const activas = new Set(evaluar(deseado, instalados).filter((e) => e.activa).map((e) => e.id));
  return FUNCIONES.filter((x) => activas.has(x.id) && (
    x.funciones.includes(id) || x.condicional.some((c) => c.funcion === id && instalados.has(c.siModulo))
  )).map((x) => x.id);
};

// ---- Con base de datos ----

const instaladosDe = async (db) => {
  const [rows] = await db.query('SELECT codigo FROM modulos_instalados');
  return new Set(rows.map((r) => r.codigo));
};

const deseadoDe = async (db) => {
  const deseado = deseadoBase();
  const [rows] = await db.query('SELECT funcion_id, activa FROM estado_funcionalidades');
  for (const r of rows) if (deseado.has(r.funcion_id)) deseado.set(r.funcion_id, !!r.activa);
  return deseado;
};

const version = async (db = pool) => {
  const [[r]] = await db.query('SELECT version_configuracion AS v FROM configuracion_instancia WHERE id = 1');
  return r ? r.v : 0;
};

const estado = async (db = pool) => {
  const [deseado, instalados] = await Promise.all([deseadoDe(db), instaladosDe(db)]);
  return { version: await version(db), funciones: evaluar(deseado, instalados) };
};

// Corre `fn(conn)` dentro de una transacción, sobre una conexión nueva del pool o sobre la conexión
// que ya se pasó (alta de instancia).
const enTransaccion = async (db, fn) => {
  const propia = typeof db.getConnection === 'function';
  const conn = propia ? await db.getConnection() : db;
  try {
    await conn.beginTransaction();
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    if (propia) conn.release();
  }
};

// Guarda un cambio confirmado: estado de las funciones, versión nueva e historial. Atómico (RN77).
const confirmar = async (db, nuevoDeseado, origen, actor) => {
  return enTransaccion(db, async (conn) => {
    const [[cfg]] = await conn.query('SELECT version_configuracion AS v FROM configuracion_instancia WHERE id = 1 FOR UPDATE');
    if (!cfg) throw Object.assign(new Error('La instancia no está dada de alta.'), { status: 409 });
    const antes = await deseadoDe(conn);
    const instalados = await instaladosDe(conn);
    const cambios = {};
    for (const x of FUNCIONES) {
      if (!!antes.get(x.id) !== !!nuevoDeseado.get(x.id)) cambios[x.id] = { antes: !!antes.get(x.id), despues: !!nuevoDeseado.get(x.id) };
    }
    if (!Object.keys(cambios).length) return { version: cfg.v, cambios };

    const filas = FUNCIONES.map((x) => [x.id, nuevoDeseado.get(x.id) ? 1 : 0]);
    await conn.query('INSERT INTO estado_funcionalidades (funcion_id, activa) VALUES ? ON DUPLICATE KEY UPDATE activa = VALUES(activa)', [filas]);
    const v = cfg.v + 1;
    await conn.query('INSERT INTO version_configuracion (version, ts_ms, user_id, username, origen, cambios, estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [v, Date.now(), actor?.id ?? null, actor?.username ?? null, origen, JSON.stringify(cambios),
        JSON.stringify(Object.fromEntries(evaluar(nuevoDeseado, instalados).map((e) => [e.id, e.activa])))]);
    await conn.query('UPDATE configuracion_instancia SET version_configuracion = ? WHERE id = 1', [v]);
    return { version: v, cambios };
  });
};

const fallo = (status, codigo, error, extra = {}) => ({ ok: false, status, codigo, error, ...extra });

// Cambia el estado de funciones. `pedido`: { activar: [ids], desactivar: [ids], confirmar: { cascada, pendientes },
// motivo, autorizacionOk }. `autorizacionOk` lo resuelve quien llama (controlador): true si otro Administrador
// autorizó la desactivación de funciones sanitarias (RN86).
// Devuelve { ok: true, version, cambios } o { ok: false, status, codigo, error, ... } sin tocar nada.
const cambiar = async (db, pedido, actor) => {
  const { activar = [], desactivar = [], confirmar: conf = {}, motivo, autorizacionOk = false } = pedido;
  const ids = [...activar, ...desactivar];
  const desconocida = ids.find((i) => !porId[i]);
  if (desconocida) return fallo(400, 'FUNCION_INEXISTENTE', `La función "${desconocida}" no existe.`);
  if (activar.some((i) => desactivar.includes(i))) return fallo(400, 'PEDIDO_INVALIDO', 'Una función no puede activarse y desactivarse a la vez.');

  const [[param]] = await db.query("SELECT valor FROM parametros WHERE clave = 'restauracion_en_curso'");
  if (param && param.valor === '1')
    return fallo(423, 'RESTAURACION', 'Hay una restauración o migración en curso: no se pueden cambiar funciones hasta que termine.');

  const [deseado, instalados] = await Promise.all([deseadoDe(db), instaladosDe(db)]);
  const nuevo = new Map(deseado);
  for (const i of activar) nuevo.set(i, true);

  // Desactivar: dependientes, datos vigentes y pendientes.
  const aDesactivar = new Set(desactivar);
  const cascada = new Set();
  const cola = [...desactivar];
  while (cola.length) {
    const id = cola.shift();
    for (const dep of dependientes(id, nuevo, instalados)) {
      if (aDesactivar.has(dep) || activar.includes(dep)) continue;
      // VEN-SERIE y similares: con un dependiente activo no se ofrece la cascada (EX53).
      if (porId[id].datosVigentes) return fallo(409, 'DATOS_VIGENTES', `${id} no se puede desactivar mientras ${dep} esté activa. Desactivá primero ${dep}.`, { dependientes: [dep] });
      aDesactivar.add(dep); cascada.add(dep); cola.push(dep);
    }
  }
  for (const id of aDesactivar) {
    const dv = await comprobaciones.get(id)?.datosVigentes?.();
    if (dv?.length) return fallo(409, 'DATOS_VIGENTES', `${id} no se puede desactivar mientras existan datos vigentes.`, { datos: dv });
  }
  if (cascada.size && !conf.cascada)
    return fallo(409, 'REQUIERE_CONFIRMACION', `Desactivar ${[...desactivar].join(', ')} desactiva también: ${[...cascada].join(', ')}.`, { cascada: [...cascada] });

  const pendientes = [];
  for (const id of aDesactivar) for (const p of (await comprobaciones.get(id)?.pendientes?.()) || []) pendientes.push(`${id}: ${p}`);
  if (pendientes.length && !conf.pendientes)
    return fallo(409, 'REQUIERE_CONFIRMACION', 'Hay operaciones pendientes de estas funciones.', { pendientes });

  const sanitarias = [...aDesactivar].filter((i) => porId[i].sanitaria && deseado.get(i));
  if (sanitarias.length) {
    if (typeof motivo !== 'string' || motivo.trim().length < 3)
      return fallo(400, 'MOTIVO_REQUERIDO', `Desactivar ${sanitarias.join(', ')} (peso sanitario) exige un motivo.`, { sanitarias, pendientes });
    const [[a]] = await db.query("SELECT valor FROM parametros WHERE clave = 'autorizacion_admin_funciones_sanitarias'");
    if ((!a || a.valor === '1') && !autorizacionOk)
      return fallo(403, 'REQUIERE_AUTORIZACION_SANITARIA', `Desactivar ${sanitarias.join(', ')} (peso sanitario) necesita la credencial de otro Administrador.`, { sanitarias, pendientes });
  }

  for (const id of aDesactivar) nuevo.set(id, false);

  // Activar: cada requisito se evalúa sobre el estado resultante, así se puede activar una función junto
  // con la que necesita (RN77).
  const memo = new Map();
  for (const id of activar) {
    const m = motivoBloqueo(id, nuevo, instalados, memo);
    if (m) return fallo(400, 'REQUISITO', `${id}: ${m}.`, { motivo: m });
  }

  const r = await confirmar(db, nuevo, 'pantalla', actor);
  return { ok: true, version: r.version, cambios: r.cambios, cascada: [...cascada], sanitarias, motivo };
};

// Aplica un perfil de rubro: pre-carga el valor de cada función (RN29). No toca usuarios, roles ni datos.
const aplicarPerfil = async (db, perfil, actor, origen = 'perfil') => {
  const p = PERFILES[perfil];
  if (!p) return fallo(400, 'PERFIL_INEXISTENTE', `El perfil "${perfil}" no existe.`);
  const [[param]] = await db.query("SELECT valor FROM parametros WHERE clave = 'restauracion_en_curso'");
  if (param && param.valor === '1') return fallo(423, 'RESTAURACION', 'Hay una restauración o migración en curso: no se pueden cambiar funciones hasta que termine.');
  const nuevo = deseadoBase();
  for (const [id, v] of Object.entries(p.cambios)) nuevo.set(id, v);
  const r = await confirmar(db, nuevo, origen, actor);
  return { ok: true, version: r.version, cambios: r.cambios };
};

// Instantánea de las funciones activas que afectan a un tipo de documento, con la versión (RN75).
const instantanea = async (tipoDocumento, db = pool) => {
  const { version: v, funciones } = await estado(db);
  const afectadas = new Set(FUNCIONES.filter((x) => x.docs.includes(tipoDocumento)).map((x) => x.id));
  return { version: v, funciones: funciones.filter((f) => afectadas.has(f.id) && f.activa).map((f) => f.id) };
};

const estaActiva = async (id, db = pool) => {
  if (!porId[id]) throw new Error(`La función "${id}" no existe.`);
  const [deseado, instalados] = await Promise.all([deseadoDe(db), instaladosDe(db)]);
  return !!deseado.get(id) && motivoBloqueo(id, deseado, instalados) === null;
};

// Funciones que dejarían de cumplir un requisito si se instalara `codigo` (EX30): con ese módulo
// instalado, una función activa exigiría otra que está inactiva.
const conflictosAlInstalar = async (codigo, db = pool) => {
  const [deseado, instalados] = await Promise.all([deseadoDe(db), instaladosDe(db)]);
  const despues = new Set([...instalados, codigo]);
  return evaluar(deseado, despues)
    .filter((e) => e.deseada && e.deshabilitada && e.motivo.includes('porque'))
    .map((e) => `${e.id}: ${e.motivo}`);
};

// Una instalación o desinstalación de módulo que cambia lo que está realmente activo sube la versión (RN74).
const registrarCambioDeModulo = async (antesEstado, actor, db = pool) => {
  const despues = await estado(db);
  const cambios = {};
  for (const f of despues.funciones) {
    const a = antesEstado.find((x) => x.id === f.id);
    if (a && a.activa !== f.activa) cambios[f.id] = { antes: a.activa, despues: f.activa };
  }
  if (!Object.keys(cambios).length) return despues.version;
  return enTransaccion(db, async (conn) => {
    const [[cfg]] = await conn.query('SELECT version_configuracion AS v FROM configuracion_instancia WHERE id = 1 FOR UPDATE');
    const v = cfg.v + 1;
    await conn.query('INSERT INTO version_configuracion (version, ts_ms, user_id, username, origen, cambios, estado) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [v, Date.now(), actor?.id ?? null, actor?.username ?? null, 'modulo', JSON.stringify(cambios),
        JSON.stringify(Object.fromEntries(despues.funciones.map((e) => [e.id, e.activa])))]);
    await conn.query('UPDATE configuracion_instancia SET version_configuracion = ? WHERE id = 1', [v]);
    return v;
  });
};

module.exports = {
  evaluar, motivoBloqueo, dependientes, deseadoBase,
  estado, version, cambiar, aplicarPerfil, instantanea, estaActiva,
  conflictosAlInstalar, registrarCambioDeModulo, registrarComprobacion,
};
