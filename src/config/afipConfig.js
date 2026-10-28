// Única fuente de verdad para la configuración de ARCA (ex AFIP). Es la de la instancia de la
// request en curso (A1): cada cliente tiene su CUIT, certificados y entorno. Ningún otro archivo
// del módulo de facturación debe leer process.env directamente. Se lee en cada acceso, no al cargar
// el módulo, por eso es un Proxy.
const { actual } = require('../instancias/registro');

module.exports = new Proxy({}, {
  get: (_, clave) => actual().afip[clave],
});
