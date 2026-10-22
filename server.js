"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
try {
return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
} catch (e) {
throw mod = 0, e;
}
};
// node_modules/dotenv/package.json
var require_package = __commonJS({
"node_modules/dotenv/package.json"(exports2, module2) {
module2.exports = {
name: "dotenv",
version: "16.6.1",
description: "Loads environment variables from .env file",
main: "lib/main.js",
types: "lib/main.d.ts",
exports: {
".": {
types: "./lib/main.d.ts",
require: "./lib/main.js",
default: "./lib/main.js"
},
"./config": "./config.js",
"./config.js": "./config.js",
"./lib/env-options": "./lib/env-options.js",
"./lib/env-options.js": "./lib/env-options.js",
"./lib/cli-options": "./lib/cli-options.js",
"./lib/cli-options.js": "./lib/cli-options.js",
"./package.json": "./package.json"
},
scripts: {
"dts-check": "tsc --project tests/types/tsconfig.json",
lint: "standard",
pretest: "npm run lint && npm run dts-check",
test: "tap run --allow-empty-coverage --disable-coverage --timeout=60000",
"test:coverage": "tap run --show-full-coverage --timeout=60000 --coverage-report=text --coverage-report=lcov",
prerelease: "npm test",
release: "standard-version"
},
repository: {
type: "git",
url: "git://github.com/motdotla/dotenv.git"
},
homepage: "https://github.com/motdotla/dotenv#readme",
funding: "https://dotenvx.com",
keywords: [
"dotenv",
"env",
".env",
"environment",
"variables",
"config",
"settings"
],
readmeFilename: "README.md",
license: "BSD-2-Clause",
devDependencies: {
"@types/node": "^18.11.3",
decache: "^4.6.2",
sinon: "^14.0.1",
standard: "^17.0.0",
"standard-version": "^9.5.0",
tap: "^19.2.0",
typescript: "^4.8.4"
},
engines: {
node: ">=12"
},
browser: {
fs: false
}
};
}
});
// node_modules/dotenv/lib/main.js
var require_main = __commonJS({
"node_modules/dotenv/lib/main.js"(exports2, module2) {
var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var packageJson = require_package();
var version = packageJson.version;

var LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#
function parse(src) {
const obj = {};
let lines = src.toString();
lines = lines.replace(/\r\n?/mg, "\n");
let match;
while ((match = LINE.exec(lines)) != null) {
const key = match[1];
let value = match[2] || "";
value = value.trim();
const maybeQuote = value[0];
value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");
if (maybeQuote === '"') {
value = value.replace(/\\n/g, "\n");
value = value.replace(/\\r/g, "\r");
}
obj[key] = value;
}
return obj;
}
function _parseVault(options) {
options = options || {};
const vaultPath = _vaultPath(options);
options.path = vaultPath;
const result = DotenvModule.configDotenv(options);
if (!result.parsed) {
const err = new Error(`MISSING_DATA: Cannot parse ${vaultPath} for an unknown reason`);
err.code = "MISSING_DATA";
throw err;
}
const keys = _dotenvKey(options).split(",");
const length = keys.length;
let decrypted;
for (let i = 0; i < length; i++) {
try {
const key = keys[i].trim();
const attrs = _instructio
ns(result, key);
decrypted = DotenvModule.decrypt(attrs.ciphertext, attrs.key);
break;
} catch (error) {
if (i + 1 >= length) {
throw error;
}
}
}
return DotenvModule.parse(decrypted);
}
function _warn(message) {
console.log(`[dotenv@${version}][WARN] ${message}`);
}
function _debug(message) {
console.log(`[dotenv@${version}][DEBUG] ${message}`);
}
function _log(message) {
console.log(`[dotenv@${version}] ${message}`);
}
function _dotenvKey(options) {
if (options && options.DOTENV_KEY && options.DOTENV_KEY.length > 0) {
return options.DOTENV_KEY;
}
if (process.env.DOTENV_KEY && process.env.DOTENV_KEY.length > 0) {
return process.env.DOTENV_KEY;
}
return "";
}
function _instructions(result, dotenvKey) {
let uri;
try {
uri = new URL(dotenvKey);
} catch (error) {
if (error.code === "ERR_INVALID_URL") {
const err = new Error("INVALID_DOTENV_KEY: Wrong format. Must be in valid uri format like dotenv://:key_1234@dotenvx.com/vault/.env.v
err.code = "INVALID_DOTENV_KEY";
throw err;
}
throw error;
}
const key = uri.password;
if (!key) {
const err = new Error("INVALID_DOTENV_KEY: Missing key part");
err.code = "INVALID_DOTENV_KEY";
throw err;
}
const environment = uri.searchParams.get("environment");
if (!environment) {
const err = new Error("INVALID_DOTENV_KEY: Missing environment part");
err.code = "INVALID_DOTENV_KEY";
throw err;
}
const environmentKey = `DOTENV_VAULT_${environment.toUpperCase()}`;
const ciphertext = result.parsed[environmentKey];
if (!ciphertext) {
const err = new Error(`NOT_FOUND_DOTENV_ENVIRONMENT: Cannot locate environment ${environmentKey} in your .env.vault file.`);
err.code = "NOT_FOUND_DOTENV_ENVIRONMENT";

throw err;
}
return { ciphertext, key };
}
function _vaultPath(options) {
let possibleVaultPath = null;
if (options && options.path && options.path.length > 0) {
if (Array.isArray(options.path)) {
for (const filepath of options.path) {
if (fs.existsSync(filepath)) {
possibleVaultPath = filepath.endsWith(".vault") ? filepath : `${filepath}.vault`;
}
}
} else {
possibleVaultPath = options.path.endsWith(".vault") ? options.path : `${options.path}.vault`;
}
} else {
possibleVaultPath = path.resolve(process.cwd(), ".env.vault");
}
if (fs.existsSync(possibleVaultPath)) {
return possibleVaultPath;
}
return null;
}
function _resolveHome(envPath) {
return envPath[0] === "~" ? path.join(os.homedir(), envPath.slice(1)) : envPath;
}
function _configVault(options) {
const debug = Boolean(options && options.debug);
const quiet = options && "quiet" in options ? options.quiet : true;
if (debug || !quiet) {
_log("Loading env from encrypted .env.vault");
}
const parsed = DotenvModule._parseVault(options);
let processEnv = process.env;
if (options && options.processEnv != null) {
processEnv = options.processEnv;
}
DotenvModule.populate(processEnv, parsed, options);
return { parsed };
}
function configDotenv(options) {
const dotenvPath = path.resolve(process.cwd(), ".env");
let encoding = "utf8";
const debug = Boolean(options && options.debug);
const quiet = options && "quiet" in options ? options.quiet : true;
if (options && options.encoding) {
encoding = options.encoding;
} else {
if (debug) {
_debug("No encoding is specified. UTF-8 is used by default");
}
}
let optionPaths = [dotenvPath];
if (options && options.path) {
if (!Array.isArray(options.path)) {
optionPaths = [_resolveHome(options.path)];
} else {
optionPaths = [];
for (const filepath of options.path) {
optionPaths.push(_resolveHome(filepath));
}
}
}
let lastError;
const parsedAll = {};
for (const path2 of optionPaths) {
try {
const parsed = DotenvModule.parse(fs.readFileSync(path2, { encoding }));
DotenvModule.populate(parsedAll, parsed, options);
} catch (e) {
if (debug) {
_debug(`Failed to load ${path2} ${e.message}`);
}
lastError = e;
}
}
let processEnv = process.env;
if (options && options.processEnv != null) {
processEnv = options.processEnv;
}
DotenvModule.populate(processEnv, parsedAll, options);
if (debug || !quiet) {
const keysCount = Object.keys(parsedAll).length;
const shortPaths = [];
for (const filePath of optionPaths) {
try {
const relative = path.relative(process.cwd(), filePath);
shortPaths.push(relative);
} catch (e) {
if (debug) {
_debug(`Failed to load ${filePath} ${e.message}`);
}
lastError = e;
}

}
_log(`injecting env (${keysCount}) from ${shortPaths.join(",")}`);
}
if (lastError) {
return { parsed: parsedAll, error: lastError };
} else {
return { parsed: parsedAll };
}
}
function config(options) {
if (_dotenvKey(options).length === 0) {
return DotenvModule.configDotenv(options);
}
const vaultPath = _vaultPath(options);
if (!vaultPath) {
_warn(`You set DOTENV_KEY but you are missing a .env.vault file at ${vaultPath}. Did you forget to build it?`);
return DotenvModule.configDotenv(options);
}
return DotenvModule._configVault(options);
}
function decrypt(encrypted, keyStr) {
const key = Buffer.from(keyStr.slice(-64), "hex");
let ciphertext = Buffer.from(encrypted, "base64");
const nonce = ciphertext.subarray(0, 12);
const authTag = ciphertext.subarray(-16);
ciphertext = ciphertext.subarray(12, -16);
try {
const aesgcm = crypto.createDecipheriv("aes-256-gcm", key, nonce);
aesgcm.setAuthTag(authTag);
return `${aesgcm.update(ciphertext)}${aesgcm.final()}`;
} catch (error) {
const isRange = error instanceof RangeError;
const invalidKeyLength = error.message === "Invalid key length";
const decryptionFailed = error.message === "Unsupported state or unable to authenticate data";
if (isRange || invalidKeyLength) {
const err = new Error("INVALID_DOTENV_KEY: It must be 64 characters long (or more)");
err.code = "INVALID_DOTENV_KEY";
throw err;
} else if (decryptionFailed) {
const err = new Error("DECRYPTION_FAILED: Please check your DOTENV_KEY");
err.code = "DECRYPTION_FAILED";
throw err;
} else {
throw error;
}
}
}
function populate(processEnv, parsed, options = {}) {
const debug = Boolean(options && options.debug);
const override = Boolean(options && options.override);
if (typeof parsed !== "object") {
const err = new Error("OBJECT_REQUIRED: Please check the processEnv argument being passed to populate");
err.code = "OBJECT_REQUIRED";
throw err;
}
for (const key of Object.keys(parsed)) {
if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
if (override === true) {
processEnv[key] = parsed[key];
}
if (debug) {
if (override === true) {
_debug(`"${key}" is already defined and WAS over
written`);
} else {
_debug(`"${key}" is already defined and was NOT overwritten`);
}
}
} else {
processEnv[key] = parsed[key];
}
}
}
var DotenvModule = {
configDotenv,
_configVault,
_parseVault,
config,
decrypt,
parse,
populate
};
module2.exports.configDotenv = DotenvModule.configDotenv;
module2.exports._configVault = DotenvModule._configVault;
module2.exports._parseVault = DotenvModule._parseVault;
module2.exports.config = DotenvModule.config;
module2.exports.decrypt = DotenvModule.decrypt;
module2.exports.parse = DotenvModule.parse;
module2.exports.populate = DotenvModule.populate;
module2.exports = DotenvModule;
}
});
// node_modules/dotenv/lib/env-options.js
var require_env_options = __commonJS({

"node_modules/dotenv/lib/env-options.js"(exports2, module2) {
var options = {};
if (process.env.DOTENV_CONFIG_ENCODING != null) {
options.encoding = process.env.DOTENV_CONFIG_ENCODING;
}
if (process.env.DOTENV_CONFIG_PATH != null) {
options.path = process.env.DOTENV_CONFIG_PATH;
}
if (process.env.DOTENV_CONFIG_QUIET != null) {
options.quiet = process.env.DOTENV_CONFIG_QUIET;
}
if (process.env.DOTENV_CONFIG_DEBUG != null) {
options.debug = process.env.DOTENV_CONFIG_DEBUG;
}
if (process.env.DOTENV_CONFIG_OVERRIDE != null) {
options.override = process.env.DOTENV_CONFIG_OVERRIDE;
}
if (process.env.DOTENV_CONFIG_DOTENV_KEY != null) {
options.DOTENV_KEY = process.env.DOTENV_CONFIG_DOTENV_KEY;
}
module2.exports = options;
}
});
// node_modules/dotenv/lib/cli-options.js
var require_cli_options = __commonJS({
"node_modules/dotenv/lib/cli-options.js"(exports2, module2) {
var re = /^dotenv_config_(encoding|path|quiet|debug|override|DOTENV_KEY)=(.+)$/;
module2.exports = function optionMatcher(args) {
const options = args.reduce(function(acc, cur) {
const matches = cur.match(re);
if (matches) {
acc[matches[1]] = matches[2];
}
return acc;
}, {});
if (!("quiet" in options)) {
options.quiet = "true";
}
return options;
};
}
});
// node_modules/dotenv/config.js
(function() {
require_main().config(
Object.assign(
{},
require_env_options(),
require_cli_options()(process.argv)
)
);
})();
// src/server.ts
var import_node_http = require("node:http");
var import_node_crypto = require("node:crypto");
var import_pg = require("pg");
// src/core/tempo.ts
var LACUNA_MS = 18e4;
var LIVE_EDGE_MS = 3e5;
var EXPIRA_MS = 8 * 6e4;
function clamp(n, min, max) {
return Math.max(min, Math.min(max, n));
}
function intEnv(name, fb, min, max) {
const raw = typeof process !== "undefined" ? process.env[name] : void 0;
const n = Number.parseInt(raw ?? "", 10);
if (!Number.isFinite(n)) return fb;
return clamp(n, min, max);
}
// src/core/avancar.ts
function avancar(gale, cor, resultado, gapMs) {
if (gapMs > LACUNA_MS) return { tipo: "lacuna" };
if (resultado === "Empate") {
const estado = gale >= 2 ? "G2" : gale === 1 ? "G1" : "GREEN";
return { tipo: "fechar", estado, porEmpate: true };
}
if (resultado === cor) {
const estado = gale >= 2 ? "G2" : gale === 1 ? "G1" : "GREEN";
return { tipo: "fechar", estado, porEmpate: false };
}
const next = gale + 1;
if (next <= 2) return { tipo: "gale", gale: next };
return { tipo: "stop" };
}
// src/core/types.ts
var RITMO_LIVRE = {
decisivasDesdeFecho: 999,
sinaisNaJanela: 0,
lossStreak: 0,

ultimoStopCor: null,
houveSinal: false
};
function oposto(side) {
return side === "Banca" ? "Jogador" : "Banca";
}
function isSide(value) {
return value === "Banca" || value === "Jogador";
}
// src/core/mesa.ts
function decisivos(newestFirst) {
const out = [];
for (const item of newestFirst) {
if (i
tem === "Banca" || item === "Jogador") out.push(item);
}
return out;
}
function runs(latest) {
const out = [];
let i = 0;
while (i < latest.length) {
let n = 1;
while (i + n < latest.length && latest[i + n] === latest[i]) n += 1;
out.push({ side: latest[i], len: n });
i += n;
}
return out;
}
function taxaAlt(latest, n) {
const s = latest.slice(0, n);
if (s.length < 2) return 0.5;
let trocas = 0;
for (let i = 1; i < s.length; i += 1) if (s[i] !== s[i - 1]) trocas += 1;
return trocas / (s.length - 1);
}
function contar(latest, n) {
const s = latest.slice(0, n);
const banca = s.filter((x) => x === "Banca").length;
return { n: s.length, banca, jogador: s.length - banca };
}
function zProp(k, n, p0 = 0.5) {
if (n <= 0) return 0;
return (k / n - p0) / Math.sqrt(p0 * (1 - p0) / n);
}
function entropiaBinaria(latest, n) {
const c = contar(latest, n);
if (c.n === 0) return 1;
const p = Math.min(Math.max(c.banca / c.n, 1e-9), 1 - 1e-9);
return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}
function regimeDe(alt) {
if (alt >= 0.62) return "alternante";
if (alt <= 0.38) return "streak";
return "misto";
}
function taxaEmpate(newestFirst, n) {
const s = newestFirst.slice(0, n);
if (!s.length) return 0;
return s.filter((x) => x === "Empate").length / s.length;
}
function vies(count, minimo, pct) {
if (count.n < minimo) return null;
const p = count.banca / count.n;
if (p >= pct) return "Banca";
if (p <= 1 - pct) return "Jogador";
return null;
}
function analisarMesa(newestFirst) {
const dec = decisivos(newestFirst);
const seq = runs(dec);
const run = seq[0] ?? { side: null, len: 0 };
const c20 = contar(dec, 20);
const c50 = contar(dec, 50);
const alt8 = taxaAlt(dec, 8);
const alt12 = taxaAlt(dec, 12);
const alt20 = taxaAlt(dec, 20);
const alt40 = taxaAlt(dec, 40);
const regime = regimeDe(alt20);
const regimeCurto = regimeDe(alt12);
const z20 = zProp(c20.banca, c20.n);
const z50 = zProp(c50.banca, c50.n);
let viesLongo = null;
if (c50.n >= 36 && Math.abs(z50) >= 1.8) viesLongo = z50 > 0 ? "Banca" : "Jogador";
const colunas = seq.slice(0, 8).map((r) => r.len);
const mediaColuna = colunas.length ? colunas.reduce((a, b) => a + b, 0) / colunas.length : 0;
return {
amostra: newestFirst.length,
decisivos: dec.length,
run: { side: run.side, len: run.len },
colunas,
alt8,
alt12,
alt20,

alt40,
banca20: c20.banca,
jogador20: c20.jogador,
banca50: c50.banca,
empates20: taxaEmpate(newestFirst, 20),
viesMedio: vies(c20, 16, 0.62),
viesLongo,
regime,
regimeCurto,
estavel: dec.length >= 24 && regime === regimeCurto && regime !== "misto",
entropia: entropiaBinaria(dec, 20),
z20,
z50,
mediaColuna
};
}
function bonusMesa(side, mesa) {
let b = 0;
if (mesa.viesMedio === side) b += 8;
else if (mesa.viesMedio && mesa.viesMedio !== side) b -= 9;
if (mesa.viesLongo === side) b += 6;
else if (mesa.viesLongo && mesa.viesLongo !== side) b -= 6;
if (mesa.regime === "streak" && mesa.run.side === side && mesa.run.len >= 3) b += 6;
if (mesa.regime === "alternante" && mesa.run.side && oposto(mesa.run.side) === side) b += 6;
if (mesa.regime === "misto") b -= 6;
if (mesa.estavel) b += 4;
else b -= 2;
if (mesa.regime === "misto" && mesa.entropia > 0.92) b -= 4;
if (b > 16) return 16;
if (b < -16) return -16;
return b;
}
function regimeConfirma(side, mesa) {
if (mesa.regime === "misto" || !mesa.estavel) return false;
if (mesa.regime === "alternante" && mesa.run.side && oposto(mesa.run.side) === side) return true;
if (mesa.regime === "streak" && mesa.run.side === side && mesa.run.len >= 3) return true;
if (mesa.viesMedio === side && mesa.viesLongo === side) return true;
return false;
}
// src/core/logics.ts
function strictAlt(latest, n) {
if (latest.length < n) return false;
for (let i = 1; i < n; i += 1) if (latest[i] === latest[i -
1]) return false;
return true;
}
function ladoMaioria(latest, n, margem) {
const c = contar(latest, n);
if (c.n < n) return null;
if (Math.abs(c.banca - c.jogador) < margem) return null;
return c.banca > c.jogador ? "Banca" : "Jogador";
}
var SPECS = [
{
id: "SURF",
familia: "streak",
base: 88,
avaliar(latest, seq) {
if (seq.length < 3) return null;
const [agora, corte, fundo] = seq;
if (!agora || !corte || !fundo) return null;
if (agora.len !== 1 || corte.len !== 1) return null;
if (fundo.len < 3 || fundo.side !== agora.side) return null;
if (latest.length < fundo.len + 2) return null;
return agora.side;
}
},
{
id: "RIDE4",
familia: "streak",
base: 80,
avaliar(_latest, seq) {
const agora = seq[0];
if (!agora) return null;
if (agora.len !== 4 && agora.len !== 5) return null;
return agora.side;
}
},
{
id: "DRAGAO",
familia: "streak",
base: 84,
avaliar(latest, seq) {
const agora = seq[0];
if (!agora || agora.len < 6) return null;
const c = contar(latest, 20);
if (c.n < 16) return null;
const aFavor = agora.side === "Banca" ? c.banca : c.jogador;
if (aFavor < 13) return null;
return agora.side;
}
},
{
id: "QUEBRA",

familia: "reversao",
base: 83,
avaliar(latest, seq) {
const agora = seq[0];
if (!agora || agora.len < 9) return null;
const antes = latest.slice(agora.len, agora.len + 20);
if (antes.length < 16) return null;
const iguais = antes.filter((x) => x === agora.side).length;
if (iguais > 8) return null;
return oposto(agora.side);
}
},
{
id: "PAD22",
familia: "par",
base: 86,
avaliar(_latest, seq) {
const [a, b] = seq;
if (!a || !b) return null;
if (a.len !== 2 || b.len !== 2 || a.side === b.side) return null;
return a.side;
}
},
{
id: "DUPLO22",
familia: "par",
base: 91,
avaliar(_latest, seq) {
const [a, b, c] = seq;
if (!a || !b || !c) return null;
if (a.len !== 2 || b.len !== 2 || c.len !== 2) return null;
if (a.side !== c.side || a.side === b.side) return null;
return a.side;
}
},
{
id: "TRINCA",
familia: "par",
base: 89,
avaliar(_latest, seq) {
const [a, b] = seq;
if (!a || !b) return null;
if (a.len !== 3 || b.len !== 3 || a.side === b.side) return null;
return a.side;
}
},
{
id: "DOIS_UM",
familia: "par",
base: 85,
avaliar(_latest, seq) {
const [a, b, c, d] = seq;
if (!a || !b || !c || !d) return null;
if (a.len !== 2 || b.len !== 1 || c.len !== 2 || d.len !== 1) return null;
if (a.side !== c.side || b.side !== d.side || a.side === b.side) return null;
return b.side;
}
},
{
id: "ALT5",
familia: "alt",
base: 84,
avaliar(latest) {
if (!strictAlt(latest, 5)) return null;
return oposto(latest[0]);
}
},
{
id: "ALT6",
familia: "alt",
base: 90,
avaliar(latest) {
if (!strictAlt(latest, 6)) return null;
return oposto(latest[0]);
}
},
{
id: "ALT7",
familia: "alt",
base: 93,
avaliar(latest) {
if (!strictAlt(latest, 7)) return null;
return oposto(latest[0]);
}
},
{
id: "QUEBRA_CHOP",
familia: "transicao",
base: 87,
avaliar(latest, seq) {
const agora = seq[0];
if (!agora || agora.len !== 2) return null;
const resto = latest.slice(2);
if (!strictAlt(resto, 5)) return null;
if (resto[0] === agora.side) return null;

return agora.side;
}
},
{
id: "MAIORIA12",
familia: "pressao",
base: 79,
avaliar(latest, seq) {
const lado = ladoMaioria(latest, 12, 5);
if (!lado) return null;
const agora = seq[0];
if (agora && agora.side !== lado && agora.len >= 2) return null;
return lado;
}
},
{
id: "PRESSAO6",
familia: "pressao",
base: 81,
avaliar(latest, seq) {
const c = contar(latest, 6);
if (c.n < 6) return null;
let lado = null;
if (c.banca >= 5) lado = "Banca";
else if (c.jogador >= 5) lado = "Jogador";
if (!lado) return null;
const agora = seq[0];
if (agora && agora.side !== lado) return null;
return lado;
}
},
{
id: "PRESSAO8",
familia: "pressao",
base: 86,
avaliar(latest) {
const c = contar(latest, 8);
if (c.n < 8) return null;
if (c.banca >= 7) return "Banca";
if (c.jogador >= 7) return "Jogador";
return null;
}
},
{
id: "FLUXO40",
familia: "fluxo",
base: 78,
avaliar(latest, seq) {
const c = contar(latest, 40);
if (c.n < 36) return null;
const z = zProp(c.banca, c.n);
if (Math.abs(z) < 1.8) return null;
const lado = z > 0 ? "Banca" : "Jogador";
const agora = seq[0];
if (agora && agora.side !== lado && agora.len >= 3) return null;
return lado;
}
},
{
id: "FLUXO_CURTO",
familia: "fluxo",
base: 76,
avaliar(latest, seq) {
const c = contar(latest, 24);
if (c.n < 24) return null;
const z = zProp(c.banca, c.n);
if (Math.abs(z) < 1.7) return null;
const lado = z > 0 ? "Banca" : "Jogador";
const agora = seq[0];
if (agora && agora.side !== lado && agora.len >= 2) return null;
if (taxaAlt(latest, 12) > 0.7) return null;
return lado;
}
},
{
id: "ESTRADA_CHOP",
familia: "estrada",
base: 85,
avaliar(latest, seq) {
if (seq.length < 5) return null;
const quatro = seq.slice(0, 5);
if (!quatro.every((r) => r.len === 1)) return null;
if (!strictAlt(latest, 5)) return null;
return oposto(latest[0]);
}
},
{
id: "ESTRADA_STREAK",
familia: "estrada",
base: 82,
avaliar(_latest, seq) {
if (seq.length < 4) return null;
const [agora, ...antes] = seq;
if (!agora || agora.len < 4) return null;
const media = antes.slice(0, 3).reduce((a, r) => a + r.len, 0) / 3;

if (media < 2.4) return null;
return agora.side;
}
},
{
id: "COLUNA_FECHADA",
familia: "estrada",
base: 80,
avaliar(_latest, seq) {
const [a, b, c] = seq;
if (!a || !b || !c) return null;
if (a.len < 2 || a.len !== b.len || b.len !== c.len) return null;
if (a.side === b.side) return null;
return oposto(a.side);
}
},
{
id: "ESPELHO3",
familia: "gramatica",
base: 90,
avaliar(latest) {
if (latest.length < 6) return null;
for (let i = 0; i < 3; i += 1) if (latest[i] !== latest[i + 3]) return null;
if (new Set(latest.slice(0, 3)).size < 2) return null;
return latest[2];
}
},
{
id: "ESPELHO4",
familia: "gramatica",
base: 92,
avaliar(latest) {
if (latest.length < 8) return null;
for (let i = 0; i < 4; i += 1) if (latest[i] !== latest[i + 4]) return null;
if (new Set(latest.slice(0, 4)).size < 2) return null;
return latest[3];
}
},
{
id: "BLOCO_DUPLO",
familia: "gramatica",
base: 88,
avaliar(latest) {
if (latest.length < 8) return null;
const bloco = latest.slice(0, 4);
for (let i = 0; i < 4; i += 1) if (latest[i] !== latest[i + 4]) return null;
if (!(bloco[0] === bloco[1] && bloco[2] === bloco[3] && bloco[0] !== bloco[2])) return null;
return bloco[3];
}
}
];
function avaliarLogicas(latest) {
if (latest.length < 4) return [];
const seq = runs(latest);
const hits = [];
for (const spec of SPECS) {
const side = spec.avaliar(latest, seq);
if (!side) continue;
hits.push({ id: spec.id, familia: spec.familia, side, base: spec.base });
}
return hits;
}
// src/core/ritmo.ts
function barraBase() {
return intEnv("BARRA_PUREZA", 76, 65, 94);
}
function tetoJanela() {
r
eturn intEnv("TETO_JANELA", 10, 4, 16);
}
function barraDe(ctx) {
let barra = barraBase();
if (ctx.sinaisNaJanela >= tetoJanela() - 2) barra += 4;
if (ctx.sinaisNaJanela >= tetoJanela()) barra += 3;
if (ctx.lossStreak >= 2) barra += 3;
if (ctx.lossStreak >= 3) barra += 2;
if (ctx.decisivasDesdeFecho >= 8 && ctx.sinaisNaJanela <= 2) barra -= 5;
return clamp(barra, 68, 96);
}
function gapDe(tier, ctx) {
let gap = tier === "elite" ? 1 : tier === "forte" ? 2 : tier === "tardia" ? 5 : 3;
if (ctx.lossStreak >= 1) gap += 1;
if (ctx.lossStreak >= 2) gap += 1;
if (ctx.sinaisNaJanela >= tetoJanela() - 1) gap += 1;
if (ctx.decisivasDesdeFecho >= 8 && ctx.sinaisNaJanela <= 2 && tier !== "tardia") {
gap = Math.max(1, gap - 1);
}
return gap;
}
function ritmoPermite(dec, ctx) {
const gap = gapDe(dec.tier, ctx);
if (ctx.sinaisNaJanela >= tetoJanela() + 3) {
return { ok: false, codigo: "ritmo_teto", gap };
}

if (ctx.sinaisNaJanela >= tetoJanela() && dec.tier !== "elite" && dec.tier !== "forte") {
return { ok: false, codigo: "ritmo_cheio", gap };
}
const limiteRevanche = dec.tier === "elite" ? 1 : 2;
if (ctx.ultimoStopCor && dec.cor !== ctx.ultimoStopCor && ctx.decisivasDesdeFecho <= limiteRevanche) {
return { ok: false, codigo: "anti_revanche", gap };
}
if (ctx.decisivasDesdeFecho < gap) {
return { ok: false, codigo: "ritmo_rodadas", gap };
}
return { ok: true, gap };
}
// src/core/decide.ts
function vazio() {
return { peso: 0, votos: 0, maxBase: 0, familias: /* @__PURE__ */ new Set(), ids: [] };
}
function purezaDe(lado, bonus) {
if (!lado.votos) return 0;
const familiasExtra = Math.max(0, lado.familias.size - 1) * 4;
const votosExtra = Math.min(8, Math.max(0, lado.votos - 1) * 2);
return clamp(lado.maxBase + familiasExtra + votosExtra + bonus, 0, 99);
}
function tierDe(pureza, familias, flexivel) {
if (flexivel) return "tardia";
if (pureza >= 92 && familias >= 3) return "elite";
if (pureza >= 86 && familias >= 2) return "forte";
return "solido";
}
function decidir(newestFirst, ctx) {
const mesa = analisarMesa(newestFirst);
const dec = decisivos(newestFirst);
if (dec.length < 12) return { sinal: null, recusa: "amostra_curta", mesa };
const hits = avaliarLogicas(dec);
if (!hits.length) return { sinal: null, recusa: "sem_familia", mesa };
const lados = { Banca: vazio(), Jogador: vazio() };
for (const hit of hits) {
const lado = lados[hit.side];
lado.peso += hit.base;
lado.votos += 1;
lado.maxBase = Math.max(lado.maxBase, hit.base);
lado.familias.add(hit.familia);
lado.ids.push(hit.id);
}
const barra = barraDe(ctx);
const score = (side) => purezaDe(lados[side], bonusMesa(side, mesa));
const banca = score("Banca");
const jogador = score("Jogador");
let cor;
if (banca === jogador) return { sinal: null, recusa: "conflito", mesa };
cor = banca > jogador ? "Banca" : "Jogador";
const outro = cor === "Banca" ? "Jogador" : "Banca";
const meu = lados[cor];
const deles = lados[outro];
const pureza = cor === "Banca" ? banca : jogador;
const purezaOutro = cor === "Banca" ? jogador : banca;
if (deles.familias.size > 0 && pureza - purezaOutro < 6) {
return { sinal: null, recusa: "conflito", mesa };
}
const consenso = meu.familias.size >= 2;
const isolado = meu.familias.size === 1 && deles.familias.size === 0 && meu.maxBase >= 85 && (regimeConfirma(cor, mesa) || bonusMesa(cor, mes
const tardio = !consenso && !isolado && ctx.houveSinal && ctx.decisivasDesdeFecho >= 6 && meu.familias.size >= 1 && deles.familias.size === 0
if (!consenso && !isolado && !tardio) {
return {
sinal: null,
recusa: meu.familias.size < 2 ? "sem_consenso" : "isolado_sujo",
mesa
};
}
if (!tardio && pureza < barra) return { sinal: null, recusa: "abaixo_da_barra", mesa };
if (!tardio && !isolado && mesa.regime === "mis
to" && pureza < barra + 4) {
return { sinal: null, recusa: "mesa_mista", mesa };
}
if (dec.length < 18 && !isolado) return { sinal: null, recusa: "amostra_curta", mesa };
const ids = [...meu.ids].sort((a, b) => {
const ba = hits.find((h) => h.id === a)?.base ?? 0;
const bb = hits.find((h) => h.id === b)?.base ?? 0;
return bb - ba;
});
return {
sinal: {
cor,
pureza,
familias: [...meu.familias],
ids,
votos: meu.votos,
flexivel: tardio,
tier: tierDe(pureza, meu.familias.size, tardio),
mesa
},
recusa: "",
mesa
};
}

// src/core/decision.ts
function avaliarEntrada(newestFirst, ctx) {
const julgamento = decidir(newestFirst, ctx);
if (!julgamento.sinal) return { ok: false, codigo: julgamento.recusa || "sem_sinal", julgamento };
const ritmo = ritmoPermite(julgamento.sinal, ctx);
if (!ritmo.ok) return { ok: false, codigo: ritmo.codigo, julgamento };
return { ok: true, julgamento, gapMinimo: ritmo.gap };
}
// src/core/leitura.ts
var TAMANHO_PAGINA = 100;
var ORCAMENTO_PAGINAS = 8;
function decidirPagina(args) {
const orcamento = args.orcamento ?? ORCAMENTO_PAGINAS;
if (args.recebidos <= 0) return { continuar: false, motivo: "vazia" };
if (args.pontaConhecida && args.ids.includes(args.pontaConhecida)) {
return { continuar: false, motivo: "sobreposta" };
}
const fimPeloTotal = args.total !== null && (args.pagina + 1) * args.tamanho >= args.total;
if (args.recebidos < args.tamanho || fimPeloTotal) {
return { continuar: false, motivo: "fim_fornecedor" };
}
if (args.pagina + 1 >= orcamento) return { continuar: false, motivo: "orcamento" };
return { continuar: true, motivo: "seguinte" };
}
function proximoAtraso(falhas) {
const n = Number.isFinite(falhas) ? Math.max(0, Math.trunc(falhas)) : 0;
if (n <= 0) return 4e3;
return Math.min(2e4, 2e3 * 2 ** Math.min(n, 4));
}
// src/core/messages.ts
function forecastLabel(side) {
return side === "Jogador" ? "\u{1F537} JOGADOR" : "\u{1F536} BANCA";
}
function resultLabel(outcome) {
if (outcome === "Empate") return "\u{1F7E1} EMPATE";
return outcome === "Jogador" ? "\u{1F539} JOGADOR" : "\u{1F7E0} BANCA";
}
function entryText(decision) {
const tier = decision.tier === "elite" ? "ELITE" : decision.tier === "forte" ? "FORTE" : "SELECIONADO";
return [
"\u{1F3B2} SINAL BAC BO \xB7 ENTRADA GS",
`\u25CE Previs\xE3o: ${forecastLabel(decision.cor)}`,
`\u25C7 Setup ${tier} \xB7 \xEDndice interno ${decision.pureza}/100 \xB7 ${decision.familias.length} fam\xEDlias em consenso`,
"\u{1F7E1} Empate protegido \xB7 m\xE1ximo G2"
].join("\n");
}
function analysisText() {
return [
"\u{1F50E} A analisar o mercado Bac Bo\u2026",
"A aguardar uma configura\xE7\xE3o validada. Sem entrada for\xE7ada."
].join("\n");
}
function galeText(level, side, resumed = false) {
return [
`\u{1F414} GALE ${level}`,
`\u25CE Manter previs\xE3o: ${forecastLabel(side)}`,
resumed ? "Fio retomado pela ordem real das rodadas." : ""
].filter(Boolean).join("\n");
}
function resultText(state, side, round) {
if (state === "LACUNA" || state === "CANCELADO") {
return [
`\u26A0\uFE0F SINAL ANULADO \xB7 ${state === "LACUNA" ? "LACUNA NA SEQU\xCANCIA" : "SEM RODADA A TEMPO"}`,
`\u25CE Previs\xE3o: ${forecastLabel(side)}`,
"N\xE3o foi contado como Green nem Loss."
].join("\n");
}
if (!round) return `\u26A0\uFE0F RESULTADO PENDENTE \xB7 ${state}`;
const stage = state === "GREEN" ? "GS" : state;
const header = state === "LOSS" ? "\u{1F53B} FECHO FINAL \xB7 LOSS" : round.resultado === "Empate" ? `\u{1F7E1} GREEN ${stage} \xB7 EMPATE PR
const lines = [header, `\u25CE Previs\xE3o: ${forecastLabel(side)}`, `\u2727 Resultado: ${resultLabel(round.resultado)}`];
if (round.pontosJogador !== null && round.pontosBanca !== null) {
lines.push(`\u{1F3B2} Pontua\xE7\xE3o: Jogador ${round.pontosJogador} \
xB7 Banca ${round.pontosBanca}`);
if (round.resultado === "Empate") {
lines.push("\u{1F3C6} Cor vencedora: EMPATE");
} else {
const winner = round.resultado === "Jogador" ? "JOGADOR" : "BANCA";
const points = round.resultado === "Jogador" ? round.pontosJogador : round.pontosBanca;
lines.push(`\u{1F3C6} Cor vencedora: ${winner} \xB7 ${points} pontos`);
}
}
return lines.join("\n");
}
// src/core/normalize.ts
var PLAYER = /* @__PURE__ */ new Set([
"player",
"jogador",
"playerwin",
"playerwins",
"playerwon",
"playerwinner",

"blue",
"azul"
]);
var BANKER = /* @__PURE__ */ new Set([
"banker",
"banca",
"bankerwin",
"bankerwins",
"bankerwon",
"bankerwinner",
"red",
"vermelho"
]);
var TIE = /* @__PURE__ */ new Set(["tie", "draw", "empate", "equal", "push", "tied", "tie8", "tie10or4"]);
function foldToken(value) {
return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}
function normalizeOutcome(value) {
if (value && typeof value === "object") {
const o = value;
value = o.outcome ?? o.resultado ?? o.winner ?? o.name;
}
const s = foldToken(value);
if (!s) return null;
if (PLAYER.has(s) || s.startsWith("player")) return "Jogador";
if (BANKER.has(s) || s.startsWith("banker")) return "Banca";
if (TIE.has(s) || s.startsWith("tie") || s.startsWith("empate")) return "Empate";
return null;
}
function validIso(value) {
if (typeof value !== "string" && typeof value !== "number") return null;
const d = new Date(value);
if (Number.isNaN(d.getTime())) return null;
return d.toISOString();
}
function asRecord(value) {
return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function dicePair(node) {
const rec = asRecord(node);
if (!rec) return null;
const a = Number(rec.first ?? rec.primeiro);
const b = Number(rec.second ?? rec.segundo);
if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
if (a < 1 || a > 6 || b < 1 || b > 6) return null;
return [a, b];
}
function scoreOf(node) {
const rec = asRecord(node);
if (!rec) return null;
const n = Number(rec.score);
if (!Number.isInteger(n) || n < 2 || n > 12) return null;
return n;
}
function extractItems(body) {
if (Array.isArray(body)) return body;
const rec = asRecord(body);
if (!rec) return [];
const keys = ["data", "results", "items", "resultados", "rounds", "events"];
for (const key of keys) {
if (Array.isArray(rec[key])) return rec[key];
}
const data = asRecord(rec.data);
if (!data) return [];
for (const key of ["results", "items", "resultados", "rounds", "events", "data"]) {
if (Array.isArray(data[key])) return data[key];
}
return [];
}
var RESOLVIDO = [
"resolved",
"settled",
"finished",
"complete",
"completed",
"resolvido",
"concluido",
"finalizado"
];
function normalizeRound(item) {
const root = asRecord(item);
if (!root) return null;
const data = asRecord(root.data) ?? asRecord(root.round) ?? root;
const result = asRecord(data.result) ?? asRecord(root.result) ?? {};
const status = foldToken(data.status ?? data.estado ?? root.status ?? "");
const inicio = validIso(
data.startedAt ?? data.startTime ?? data.started_at ?? data.inicio ?? root.startedAt
);
const fim = validIso(
data.settledAt ?? data.endTime ?? data.endedAt ?? data.finishedAt ?? data.fim ?? root.settledAt
);
const raw = result.outcome ?? result.resultado ?? result.winner ?? data.outcome ?? data.resultado ?? root.outcome ?? (typeof data.result ===
const resultado = normalizeOutcome(raw);
const resolvida = RESOLVIDO.some((w) => status.includes(w)) || Boolean(fim && resultado);
const id = String(

data.id ?? data.roundId ?? data.round_id ?? root.id ?? root.roundId ?? ""
).trim();
if (!id || !resultado || !resolvida || !fim) return null;
if (status.includes("cancel")) return null;
con
st mult = result.multiplier ?? data.multiplier;
return {
id,
resultado,
inicio,
fim,
pontosJogador: scoreOf(result.playerDice),
pontosBanca: scoreOf(result.bankerDice),
dadosJogador: dicePair(result.playerDice),
dadosBanca: dicePair(result.bankerDice),
multiplicador: mult === void 0 || mult === null ? null : String(mult)
};
}
function apiUrl() {
const raw = typeof process !== "undefined" ? process.env.API_BACBO : void 0;
if (raw && raw.trim()) return raw.trim();
return "https://api.casinoscores.com/svc-evolution-game-events/api/bacbo?page=0&size=100";
}
function apiPageUrl(page, size) {
try {
const url = new URL(apiUrl());
url.searchParams.set("page", String(page));
url.searchParams.set("size", String(size));
return url.toString();
} catch {
return apiUrl();
}
}
// src/server.ts
var PORT = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080;
var PAGE_SIZE = TAMANHO_PAGINA;
var PAGE_BUDGET = ORCAMENTO_PAGINAS;
var MAX_HISTORY = 180;
var LOCK_KEY = 923185714;
var pool = new import_pg.Pool({
connectionString: process.env.DATABASE_URL,
max: 8,
idleTimeoutMillis: 3e4,
connectionTimeoutMillis: 8e3,
statement_timeout: 15e3
});
var runtime = {
startedAt: (/* @__PURE__ */ new Date()).toISOString(),
lastSyncAt: null,
lastRoundAt: null,
lastHttp: null,
lastError: null,
lastReason: "a iniciar",
failures: 0,
pages: 0,
newRounds: 0,
telegramConfigured: Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID),
dbConfigured: Boolean(process.env.DATABASE_URL),
lockHeld: false
};
var schemaReady = false;
var lockClient = null;
var ticking = null;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var SCHEMA = `
CREATE TABLE IF NOT EXISTS cbot_rounds (
id text PRIMARY KEY,
outcome text NOT NULL CHECK (outcome IN ('Banca','Jogador','Empate')),
started_at timestamptz,
finished_at timestamptz NOT NULL,
player_points integer,
banker_points integer,
player_dice jsonb,
banker_dice jsonb,
seq bigserial NOT NULL,
stored_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cbot_rounds_time_idx ON cbot_rounds (finished_at DESC, seq DESC);
CREATE TABLE IF NOT EXISTS cbot_signals (
id bigserial PRIMARY KEY,
created_at timestamptz NOT NULL,
predicted_side text NOT NULL CHECK (predicted_side IN ('Banca','Jogador')),
status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','GREEN','G1','G2','LOSS','LACUNA','CANCELADO')),
gale smallint NOT NULL DEFAULT 0 CHECK (gale BETWEEN 0 AND 2),
trigger_round_id text NOT NULL,
last_round_id text NOT NULL,
last_applied_at timestamptz NOT NULL,
final_round_id text,
final_outcome text,
player_points integer,
banker_points integer,
ties integer NOT NULL DEFAULT 0,
strategy text,
families text,

confidence integer,
votes integer NOT NULL DEFAULT 0,
flexible boolean NOT NULL DEFAULT false,
entry_announced boolean NOT NULL DEFAULT false,
gale_announced smallint NOT NULL DEFAULT 0,
closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS cbot_one_signal_per_trigger ON cbot_signals (trigger_round_id);
CREATE UNIQUE INDEX IF NOT EXISTS cbot_one_pending_signal ON cbot_signals ((1)) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS cbot_signals_time_idx ON cbot_signals (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cbot_signals_status_idx ON cbot_signals (status, closed_at DESC);
CREATE TABLE IF NOT EXISTS cbot_events (
id bigserial PRIMARY KEY,
signal_id bigint,
kind text NOT NULL,
round_id text,
detail text,
occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cbot_events_time_idx ON cbot_events (occurred_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS cbot_state (
key text PRIMARY KEY,
value text NOT NULL,
updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cbot_outbox (
id bigserial PRIMARY KEY,
dedupe_key text NOT NULL UNIQUE,
signal_id b
igint,
kind text NOT NULL,
body text NOT NULL,
status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT')),
attempts integer NOT NULL DEFAULT 0,
last_error text,
next_attempt_at timestamptz NOT NULL DEFAULT now(),
telegram_message_id bigint,
created_at timestamptz NOT NULL DEFAULT now(),
sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS cbot_outbox_due_idx ON cbot_outbox (status, next_attempt_at, id);
`;
async function ensureSchema() {
if (schemaReady) return;
await pool.query(SCHEMA);
schemaReady = true;
}
async function stateGet(db, key) {
const r = await db.query("SELECT value FROM cbot_state WHERE key=$1", [key]);
return r.rows[0]?.value ?? null;
}
async function stateSet(db, key, value) {
await db.query(
`INSERT INTO cbot_state(key,value,updated_at) VALUES($1,$2,now())
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=now()`,
[key, value]
);
}
function rawId(item) {
if (!item || typeof item !== "object") return "";
const root = item;
const data = root.data && typeof root.data === "object" ? root.data : root.round && typeof root.round === "object" ? root.round : root;
return String(data.id ?? data.roundId ?? root.id ?? root.roundId ?? "").trim();
}
async function fetchPage(page) {
const url = apiPageUrl(page, PAGE_SIZE);
let lastError = "api_indisponivel";
for (let attempt = 0; attempt < 3; attempt += 1) {
try {
const response = await fetch(url, {
headers: { accept: "application/json", "user-agent": "CapungaG2/1.0" },
signal: AbortSignal.timeout(1e4)
});
runtime.lastHttp = response.status;
if (!response.ok) {
lastError = `api_http_${response.status}`;
if (response.status < 500 && response.status !== 429) break;
} else {
const body = await response.json();
const totalHeader = response.headers.get("x-total-count");
const total = totalHeader && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null;
return { body, status: response.status, total };
}
} catch {
lastError = "api_timeout_ou_rede";
}
if (attempt < 2) await sleep(400 * (attempt + 1));
}
throw new Error(lastError);
}
async function fetchRounds() {
const last = await pool.query("SELECT id FROM cbot_rounds ORDER BY finished_at DESC, seq DESC LIMIT 1");
const anchor = last.rows[0]?.id ?? null;
const savedResume = Number.parseInt(await stateGet(pool, "resume_page") ?? "0", 10) || 0;
const unique = /* @__PURE__ */ new Map();

let pages = 0;
let nextPage = 0;
let page = 0;
let keepGoing = true;
while (keepGoing && pages < PAGE_BUDGET) {
if (page === 1 && savedResume > 1) page = savedResume;
const response = await fetchPage(page);
const items = extractItems(response.body);
pages += 1;
const ids = items.map(rawId).filter(Boolean);
for (const item of items) {
const round = normalizeRound(item);
if (round) unique.set(round.id, round);
}
const decision = decidirPagina({
pagina: page,
recebidos: items.length,
tamanho: PAGE_SIZE,
total: response.total,
ids,
pontaConhecida: anchor,
orcamento: PAGE_BUDGET
});
keepGoing = decision.continuar;
if (!keepGoing && decision.motivo === "orcamento") nextPage = page + 1;
if (keepGoing) page += 1;
}
if (keepGoing) nextPage = page;
const rounds = [...unique.values()].sort((a, b) => a.fim.localeCompare(b.fim) || a.id.localeCompare(b.id));
if (!rounds.length) throw new Error("api_sem_rodadas_validas");
await stateSet(pool, "resume_page", String(nextPage));
runtime.pages = pages;
return { rounds, pages, nextPage };
}
async function enqueueTx(db, key, signalId, kind, body) {
await db.query(
`INSERT INTO cbot_outbox(dedupe_key,signal_id,kind,body)
VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,
[key, signalId, kind, body]
);
}
async function logEvent(db, signalId, kind,
roundId, detail) {
await db.query(
"INSERT INTO cbot_events(signal_id,kind,round_id,detail,occurred_at) VALUES($1,$2,$3,$4,now())",
[signalId, kind, roundId, detail]
);
}
async function rhythmContext(db, at) {
const closed = await db.query(
`SELECT status,predicted_side,closed_at FROM cbot_signals
WHERE status IN ('GREEN','G1','G2','LOSS') ORDER BY closed_at DESC NULLS LAST,id DESC LIMIT 8`
);
let lossStreak = 0;
let lastStopColor = null;
let lastResolved = closed.rows[0]?.closed_at ?? null;
if (closed.rows[0]?.status === "LOSS") lastStopColor = closed.rows[0].predicted_side;
for (const row of closed.rows) {
if (row.status !== "LOSS") break;
lossStreak += 1;
}
let decisivasDesdeFecho = 999;
if (lastResolved) {
const c = await db.query(
`SELECT count(*)::int AS n FROM cbot_rounds
WHERE outcome IN ('Banca','Jogador') AND finished_at > $1 AND finished_at <= $2`,
[lastResolved, at]
);
decisivasDesdeFecho = Number(c.rows[0]?.n ?? 0);
}
const boundary = await db.query(
`SELECT finished_at FROM cbot_rounds WHERE outcome IN ('Banca','Jogador') AND finished_at <= $1
ORDER BY finished_at DESC,seq DESC OFFSET 39 LIMIT 1`,
[at]
);
const signalCount = boundary.rows[0] ? await db.query("SELECT count(*)::int AS n FROM cbot_signals WHERE created_at >= $1", [boundary.rows[0]
const any = await db.query("SELECT count(*)::int AS n FROM cbot_signals");
return {
...RITMO_LIVRE,
decisivasDesdeFecho,
sinaisNaJanela: Number(signalCount.rows[0]?.n ?? 0),
lossStreak,
ultimoStopCor: lastStopColor,
houveSinal: Number(any.rows[0]?.n ?? 0) > 0
};
}
function pgDate(value) {
const n = new Date(value).getTime();
return Number.isFinite(n) ? n : 0;
}
async function processRound(round, isTip, now) {
const db = await pool.connect();
let inserted = false;
try {
await db.query("BEGIN");

const added = await db.query(
`INSERT INTO cbot_rounds(id,outcome,started_at,finished_at,player_points,banker_points,player_dice,banker_dice)
VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id`,
[
round.id,
round.resultado,
round.inicio,
round.fim,
round.pontosJogador,
round.pontosBanca,
round.dadosJogador ? JSON.stringify(round.dadosJogador) : null,
round.dadosBanca ? JSON.stringify(round.dadosBanca) : null
]
);
if (added.rowCount === 0) {
await db.query(
`UPDATE cbot_rounds SET
player_points=COALESCE(player_points,$2), banker_points=COALESCE(banker_points,$3),
player_dice=COALESCE(player_dice,$4::jsonb), banker_dice=COALESCE(banker_dice,$5::jsonb)
WHERE id=$1`,
[
round.id,
round.pontosJogador,
round.pontosBanca,
round.dadosJogador ? JSON.stringify(round.dadosJogador) : null,
round.dadosBanca ? JSON.stringify(round.dadosBanca) : null
]
);
} else {
inserted = true;
}
const openResult = await db.query(
"SELECT * FROM cbot_signals WHERE status='PENDING' ORDER BY id LIMIT 1 FOR UPDATE"
);
const open = openResult.rows[0];
if (open) {
const ageMs = now - pgDate(open.created_at || open.last_applied_at);
if (ageMs > EXPIRA_MS) {
await db.query(
`UPDATE cbot_signals SET status='CANCELADO',closed_at=now(),last_applied_at=now()
WHERE id=$1 AND status='PENDING'`,
[open.id]
);
await logEvent(db, open.id, "CANCELADO", null, "sinal expirado sem resolucao a tempo");
await enqueueTx(db, `signal:${open.id}:final`, open.id, "final", resultText("CANCELADO", open.predicted_side, null));
runtime.lastReason = "sinal_expirado";
} else if (round.id !== open.last_round_id && round.id !== open.trigger_round_id && pgD
ate(round.fim) > pgDate(open.last_applied_at)) {
const gap = pgDate(round.fim) - pgDate(open.last_applied_at);
const step = avancar(Number(open.gale), open.predicted_side, round.resultado, gap);
if (step.tipo === "lacuna") {
await db.query(
`UPDATE cbot_signals SET status='LACUNA',final_round_id=$2,final_outcome=NULL,closed_at=$3,last_round_id=$2,last_applied_at=$3
WHERE id=$1 AND status='PENDING'`,
[open.id, round.id, round.fim]
);
await logEvent(db, open.id, "LACUNA", round.id, "intervalo maior que o limite; resultado n\xE3o contado");
await enqueueTx(db, `signal:${open.id}:final`, open.id, "final", resultText("LACUNA", open.predicted_side, null));
runtime.lastReason = "lacuna_sem_resultado_fabricado";
} else if (step.tipo === "fechar" && step.estado) {
const nextState = step.estado;
await db.query(
`UPDATE cbot_signals SET status=$2,final_round_id=$3,final_outcome=$4,player_points=$5,banker_points=$6,
ties=ties+$7,closed_at=$8,last_round_id=$3,last_applied_at=$8
WHERE id=$1 AND status='PENDING'`,
[
open.id,
nextState,
round.id,
round.resultado,
round.pontosJogador,
round.pontosBanca,
step.porEmpate ? 1 : 0,
round.fim
]
);
await logEvent(db, open.id, "FECHO", round.id, step.porEmpate ? `${nextState} por empate` : nextState);
await enqueueTx(db, `signal:${open.id}:final`, open.id, "final", resultText(nextState, open.predicted_side, round));
runtime.lastReason = step.porEmpate ? "green_por_empate" : `green_${nextState}`;
} else if (step.tipo === "stop") {
await db.query(
`UPDATE cbot_signals SET status='LOSS',final_round_id=$2,final_outcome=$3,player_points=$4,banker_points=$5,
closed_at=$6,last_round_id=$2,last_applied_at=$6
WHERE id=$1 AND status='PENDING'`,
[open.id, round.id, round.resultado, round.pontosJogador, round.pontosBanca, round.fim]
);
await logEvent(db, open.id, "LOSS", round.id, "terceiro resultado contr\xE1rio ap\xF3s G2");
await enqueueTx(db, `signal:${open.id}:final`, open.id, "final", resultText("LOSS", open.predicted_side, round));
runtime.lastReason = "loss";
} else if (step.tipo === "gale" && step.gale) {
await db.query(
`UPDATE cbot_signals SET gale=$2,last_round_id=$3,last_applied_at=$4 WHERE id=$1 AND status='PENDING'`,
[open.id, step.gale, round.id, round.fim]
);
await logEvent(db, open.id, `G${step.gale}`, round.id, `gale ${step.gale}`);

await enqueueTx(
db,
`signal:${open.id}:g${step.gale}`,
open.id,
`g${step.gale}`,
galeText(step.gale, open.predicted_side, now - pgDate(round.fim) > 6e4)
);
runtime.lastReason = `gale${step.gale}`;
}
}
}
const pendingNow = await db.query("SELECT id FROM cbot_signals WHERE status='PENDING' LIMIT 1");
const live = now - pgDate(round.fim) <= LIVE_EDGE_MS;
if (!pendingNow.rows.length && isTip && live && isSide(round.resultado)) {
const used = await db.query("SELECT id FROM cbot_signals WHERE trigger_round_id=$1 LIMIT 1", [round.id]);
if (!used.rows.length) {
const hist = await db.query(
"SELECT outcome FROM cbot_rounds WHERE finished_at <= $1 ORDER BY finished_at DESC,seq DESC LIMIT $2",
[round.fim, MAX_HISTORY]
);
const ctx = await rhythmContext(db, round.fim);
const choice = avaliarEntrada(hist.rows.map((r) => r.outcome), ctx);
runtime.lastReason = choice.ok ? "entrada_validada" : choice.codigo;
if (choice.ok) {
const signal = choice.julgamento.
sinal;
if (signal) {
const created = await db.query(
`INSERT INTO cbot_signals(created_at,predicted_side,status,gale,trigger_round_id,last_round_id,last_applied_at,
strategy,families,confidence,votes,flexible)
VALUES($1,$2,'PENDING',0,$3,$3,$1,$4,$5,$6,$7,$8)
ON CONFLICT DO NOTHING RETURNING id`,
[round.fim, signal.cor, round.id, signal.ids.join("+"), signal.familias.join("+"), signal.pureza, signal.votos, signal.flexivel]
);
const newId = created.rows[0]?.id;
if (newId) {
await logEvent(db, newId, "ENTRADA", round.id, `${signal.cor}; ${signal.familias.join("+")}`);
await enqueueTx(db, `signal:${newId}:entry`, newId, "entry", entryText(signal));
}
}
}
}
}
await db.query("COMMIT");
return inserted;
} catch (error) {
await db.query("ROLLBACK").catch(() => void 0);
throw error;
} finally {
db.release();
}
}
async function telegramCall(method, body) {
const token = process.env.BOT_TOKEN?.trim();
const chat = process.env.CHAT_ID?.trim();
if (!token || !chat) return { ok: false, description: "telegram_nao_configurado", messageId: null };
try {
const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify({ chat_id: chat, disable_web_page_preview: true, ...body }),
signal: AbortSignal.timeout(12e3)
});
const payload = await response.json();
if (payload.ok) return { ok: true, description: "", messageId: payload.result?.message_id ?? null };
return { ok: false, description: payload.description ?? `telegram_http_${response.status}`, messageId: null };
} catch {
return { ok: false, description: "telegram_timeout_ou_rede", messageId: null };
}
}
async function deleteAnalysis() {
const stored = await stateGet(pool, "analysis_message_id");
if (!stored) return true;
const messageId = Number(stored);
if (!Number.isFinite(messageId)) {
await stateSet(pool, "analysis_message_id", "");
return true;
}
const result = await telegramCall("deleteMessage", { message_id: messageId });
if (result.ok || /message to delete not found|message identifier is not specified/i.test(result.description)) {
await stateSet(pool, "analysis_message_id", "");
await stateSet(pool, "analysis_updated_at", "");
return true;
}
runtime.lastError = `Telegram n\xE3o confirmou a remo\xE7\xE3o da an\xE1lise: ${result.description}`;
return false;
}
async function drainOutbox() {
if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) return;
const rows = await pool.query(
`SELECT dedupe_key,signal_id,kind,body,attempts FROM cbot_outbox
WHERE status='PENDING' AND next_attempt_at <= now() ORDER BY id LIMIT 20`
);
for (const row of rows.rows) {
if (!await deleteAnalysis()) return;

const sent = await telegramCall("sendMessage", { text: row.body });
if (sent.ok) {
await pool.query(
`UPDATE cbot_outbox SET status='SENT',attempts=attempts+1,last_error=NULL,telegram_message_id=$2,sent_at=now()
WHERE dedupe_key=$1 AND status='PENDING'`,
[row.dedupe_key, sent.messageId]
);
if (row.signal_id !== null) {
if (row.kind === "entry") await pool.query("UPDATE cbot_signals SET entry_announced=true WHERE id=$1", [row.signal_id]);
if (row.kind === "g1") await pool.query("UPDATE cbot_signals SET gale_announced=GREATEST(gale_announced,1) WHERE id=$1", [row.signal_id
if (row.kind === "g2") await pool.query("UPDATE cbot_signals SET gale_announced=GREATEST(gale_announced,2) WHERE id=$1", [row.signal_id
}
} else {
const delaySeconds = Math.min(300, 2 ** Math.min(Number(row.attempts) + 1, 8));
await pool.query(
`UPDATE cbot_outbox SET attempts=attempts+1,la
st_error=$2,next_attempt_at=now()+($3 * interval '1 second')
WHERE dedupe_key=$1 AND status='PENDING'`,
[row.dedupe_key, sent.description, delaySeconds]
);
runtime.lastError = `Notifica\xE7\xE3o Telegram em fila para nova tentativa: ${sent.description}`;
return;
}
}
}
async function ensureAnalysis() {
if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) return;
const open = await pool.query("SELECT id FROM cbot_signals WHERE status='PENDING' LIMIT 1");
if (open.rows.length) {
await deleteAnalysis();
return;
}
const waiting = await pool.query("SELECT id FROM cbot_outbox WHERE status='PENDING' LIMIT 1");
if (waiting.rows.length) return;
const oldId = await stateGet(pool, "analysis_message_id");
const lastEdit = Number(await stateGet(pool, "analysis_updated_at")) || 0;
if (oldId && Date.now() - lastEdit < 45e3) return;
if (oldId) {
const edited = await telegramCall("editMessageText", { message_id: Number(oldId), text: analysisText() });
if (edited.ok || /message is not modified/i.test(edited.description)) {
await stateSet(pool, "analysis_updated_at", String(Date.now()));
return;
}
if (!/message to edit not found|message identifier is not specified/i.test(edited.description)) {
runtime.lastError = `N\xE3o consegui atualizar a mensagem de an\xE1lise: ${edited.description}`;
return;
}
await stateSet(pool, "analysis_message_id", "");
}
const created = await telegramCall("sendMessage", { text: analysisText() });
if (created.ok && created.messageId !== null) {
await stateSet(pool, "analysis_message_id", String(created.messageId));
await stateSet(pool, "analysis_updated_at", String(Date.now()));
} else {
runtime.lastError = `N\xE3o consegui publicar a an\xE1lise: ${created.description}`;
}
}
async function acquireLock() {
if (lockClient) return true;
const client = await pool.connect();
try {
const result = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [LOCK_KEY]);
if (!result.rows[0]?.locked) {
client.release();
runtime.lockHeld = false;
runtime.lastError = "Outra inst\xE2ncia do trabalhador j\xE1 tem o bloqueio PostgreSQL.";
return false;
}
lockClient = client;
runtime.lockHeld = true;
return true;
} catch (error) {
client.release();
throw error;
}
}
async function cycle() {
if (!await acquireLock()) return;
await ensureSchema();
const fetched = await fetchRounds();
const tip = fetched.rounds.at(-1) ?? null;
let newRounds = 0;
for (const round of fetched.rounds) {
const didInsert = await processRound(round, tip?.id === round.id, Date.now());
if (didInsert) newRounds += 1;
}
runtime.newRounds = newRounds;
runtime.lastRoundAt = tip?.fim ?? runtime.lastRoundAt;
runtime.lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
runtime.failures = 0;
runtime.lastError = null;
await drainOutbox();
await ensureAnalysis();
}
async function tickOnce() {

if (ticking) return ticking;
const job = cycle().catch(async (error) => {
runtime.failures += 1;
const detail = error instanceof Error ? error.message.trim() : "";
runtime.lastError = detail || "falha_de_base_ou_rede";
runtime.lastReason = "ciclo_com_erro; nova tentativa agendada";
console.error(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event: "cycle_error", error: runtime.lastError, failures: ru
try {
if (lockClient) await drainOutbox();
} catch {
}
}).finally(() => {
if (ticking === job) ticking = null;
});
ticking = job;
return job;
}
function safeEqual(a, b) {
const left = Buffer.from(a);
const right = Buffer.from(b);
return left.length === right.length && (0, import_node_crypto.timingSafeEqual)(left, right);
}
function authorized(req) {
const expected = process.env.ADMIN_TOKEN?.trim() ?? "";
const supplied = String(req.headers
["x-admin-token"] ?? "");
return Boolean(expected && supplied && safeEqual(expected, supplied));
}
function json(res, status, body) {
res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
res.end(JSON.stringify(body));
}
async function health() {
let dbOk = false;
let pending = 0;
let openSignals = 0;
if (lockClient) {
try {
await pool.query("SELECT 1");
dbOk = true;
const q = await pool.query(
`SELECT (SELECT count(*) FROM cbot_outbox WHERE status='PENDING')::int AS pending,
(SELECT count(*) FROM cbot_signals WHERE status='PENDING')::int AS open`
);
pending = Number(q.rows[0]?.pending ?? 0);
openSignals = Number(q.rows[0]?.open ?? 0);
} catch {
dbOk = false;
}
}
const apiFresh = Boolean(runtime.lastSyncAt && Date.now() - Date.parse(runtime.lastSyncAt) < 9e4);
return {
status: dbOk && apiFresh ? "online" : "degradado",
process: "online",
database: dbOk ? "online" : "indisponivel",
api: apiFresh ? "recente" : "atrasada_ou_sem_leitura",
telegramConfigured: runtime.telegramConfigured,
lockHeld: runtime.lockHeld,
startedAt: runtime.startedAt,
lastSyncAt: runtime.lastSyncAt,
lastRoundAt: runtime.lastRoundAt,
lastHttp: runtime.lastHttp,
pages: runtime.pages,
newRoundsLastCycle: runtime.newRounds,
pendingNotifications: pending,
openSignals,
lastReason: runtime.lastReason,
lastError: runtime.lastError,
consecutiveFailures: runtime.failures
};
}
async function handle(req, res) {
const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
if (req.method === "GET" && url.pathname === "/health") {
const snapshot = await health();
json(res, snapshot.status === "online" ? 200 : 503, snapshot);
return;
}
if (!authorized(req)) {
json(res, 401, { error: "unauthorized" });
return;
}
if (req.method === "POST" && url.pathname === "/sync") {
await tickOnce();
json(res, 200, await health());
return;
}
if (req.method === "GET" && url.pathname === "/stats") {
const q = await pool.query(
`SELECT count(*)::int AS total,
count(*) FILTER (WHERE status='GREEN')::int AS gs,
count(*) FILTER (WHERE status='G1')::int AS g1,
count(*) FILTER (WHERE status='G2')::int AS g2,
count(*) FILTER (WHERE status='LOSS')::int AS loss,
count(*) FILTER (WHERE status='LACUNA')::int AS lacunas,

COALESCE(sum(ties),0)::int AS protected_ties
FROM cbot_signals WHERE status <> 'PENDING'`
);
const r = q.rows[0] ?? { total: "0", gs: "0", g1: "0", g2: "0", loss: "0", lacunas: "0", protected_ties: "0" };
const settled = Number(r.gs) + Number(r.g1) + Number(r.g2) + Number(r.loss);
json(res, 200, { ...r, settled, winRate: settled ? Number(((Number(r.gs) + Number(r.g1) + Number(r.g2)) * 100 / settled).toFixed(2)) : null
return;
}
if (req.method === "GET" && url.pathname === "/signals") {
const limit = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
const q = await pool.query(
`SELECT id,created_at,predicted_side,status,gale,trigger_round_id,final_round_id,final_outcome,
player_points,banker_points,ties,strategy,families,confidence,votes,flexible,closed_at
FROM cbot_signals ORDER BY id DESC LIMIT $1 OFFSET $2`,
[limit, offset]
);
json(res, 200, { items: q.rows, limit, offset });
return;
}
if (req.method === "GET" && url.pathname === "/rounds") {
const limit = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100));
const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
const q = await pool.query(
`SELECT id,outcome,start
ed_at,finished_at,player_points,banker_points,player_dice,banker_dice
FROM cbot_rounds ORDER BY finished_at DESC,seq DESC LIMIT $1 OFFSET $2`,
[limit, offset]
);
json(res, 200, { items: q.rows, limit, offset });
return;
}
json(res, 404, { error: "not_found" });
}
var server = (0, import_node_http.createServer)((req, res) => {
void handle(req, res).catch((error) => {
const message = error instanceof Error ? error.message : "request_failed";
console.error(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event: "http_error", error: message }));
if (!res.headersSent) json(res, 500, { error: "internal_error" });
else res.end();
});
});
function scheduleNext() {
const delay = runtime.failures ? proximoAtraso(runtime.failures) : 4e3;
setTimeout(() => {
void tickOnce().finally(scheduleNext);
}, delay);
}
server.listen(PORT, "0.0.0.0", () => {
console.log(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event: "http_listening", port: PORT }));
void tickOnce().finally(scheduleNext);
});
async function shutdown(signal) {
console.log(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event: "shutdown", signal }));
server.close();
if (lockClient) {
lockClient.release();
lockClient = null;
}
await pool.end().catch(() => void 0);
process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
console.error(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event: "unhandled_rejection", error: reason instanceof Error ?
});
process.on("uncaughtException", (error) => {
console.error(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event: "uncaught_exception", error: error.message }));
process.exit(1);
});
