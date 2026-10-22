import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_GALE = 2;

const PADROES_PADRAO = [
  { seq: "PPP", sinal: "B" },
  { seq: "BBB", sinal: "P" },
  { seq: "PPBPP", sinal: "B" },
  { seq: "BBPBB", sinal: "P" },
  { seq: "PBPBP", sinal: "B" },
  { seq: "BPBPB", sinal: "P" },
];

function configPadrao() {
  return {
    estrategia: "quebra",
    sequencia: 3,
    maxGale: MAX_GALE,
    protecao: true,
    protecaoFracao: 0.1,
    ficha: 1,
    stopWin: 0,
    stopLoss: 0,
    cooldownAposRed: 1,
    padroes: PADROES_PADRAO.map((p) => ({ ...p })),
  };
}

function criarEstado(parcial = {}) {
  const { config: configParcial, ...resto } = parcial;
  return {
    historico: [],
    pausado: false,
    motivoPausa: null,
    cooldown: 0,
    sinal: null,
    placar: { greens: 0, reds: 0, empates: 0, unidades: 0, ciclos: 0 },
    undoStack: [],
    ...resto,
    config: { ...configPadrao(), ...(configParcial || {}) },
  };
}

function normalizarResultado(valor) {
  const r = String(valor ?? "")
    .trim()
    .toUpperCase();
  const mapa = {
    P: "P",
    PLAYER: "P",
    AZUL: "P",
    B: "B",
    BANKER: "B",
    VERMELHO: "B",
    E: "E",
    T: "E",
    EMPATE: "E",
    TIE: "E",
  };
  const out = mapa[r];
  if (!out) {
    throw new Error("Resultado inválido. Use P, B ou E.");
  }
  return out;
}

function nomeLado(lado) {
  if (lado === "P") return "PLAYER";
  if (lado === "B") return "BANKER";
  return "EMPATE";
}

function r2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function maxGaleDe(config) {
  const n = Number(config.maxGale);
  if (!Number.isFinite(n)) return MAX_GALE;
  return Math.max(0, Math.min(MAX_GALE, Math.trunc(n)));
}

function fichaDoNivel(fichaBase, gale) {
  return r2(fichaBase * 2 ** gale);
}

function caudaSemEmpate(historico) {
  const out = [];
  for (const item of historico) {
    if (item === "P" || item === "B") out.push(item);
  }
  return out.slice(-40);
}

function sequenciaFinal(cauda) {
  if (cauda.length === 0) return { lado: null, n: 0 };
  const lado = cauda[cauda.length - 1];
  let n = 0;
  for (let i = cauda.length - 1; i >= 0 && cauda[i] === lado; i -= 1) n += 1;
  return { lado, n };
}

function avaliarGatilho(estado) {
  const { config } = estado;
  const cauda = caudaSemEmpate(estado.historico);
  if (config.estrategia === "padroes") {
    const texto = cauda.join("");
    let melhor = null;
    for (const padrao of config.padroes || []) {
      const seq = String(padrao.seq || "").toUpperCase();
      const sinal = padrao.sinal === "B" ? "B" : padrao.sinal === "P" ? "P" : null;
      if (!sinal || !/^[PB]+$/.test(seq)) continue;
      if (texto.endsWith(seq) && (!melhor || seq.length > melhor.seq.length)) {
        melhor = { seq, sinal };
      }
    }
    if (!melhor) return null;
    return {
      lado: melhor.sinal,
      origem: `padrão ${melhor.seq} → ${nomeLado(melhor.sinal)}`,
    };
  }

  const seqMin = Math.max(2, Math.min(8, Number(config.sequencia) || 3));
  const seq = sequenciaFinal(cauda);
  if (!seq.lado || seq.n < seqMin) return null;
  const lado =
    config.estrategia === "continuacao" ? seq.lado : seq.lado === "P" ? "B" : "P";
  const verbo = config.estrategia === "continuacao" ? "continuação" : "quebra";
  return {
    lado,
    origem: `${verbo} após ${seq.n} ${nomeLado(seq.lado)}`,
  };
}

function abrirSinal(estado, gatilho, eventos) {
  estado.sinal = {
    lado: gatilho.lado,
    gale: 0,
    origem: gatilho.origem,
    ciclo: 0,
    abertoEm: estado.historico.length,
  };
  eventos.push(eventoSinal(estado, "entrada"));
}

function eventoSinal(estado, tipo) {
  const sinal = estado.sinal;
  const ficha = fichaDoNivel(estado.config.ficha, sinal.gale);
  const prot = estado.config.protecao
    ? r2(ficha * Number(estado.config.protecaoFracao || 0))
    : 0;
  return {
    tipo,
    lado: sinal.lado,
    gale: sinal.gale,
    origem: sinal.origem,
    ficha,
    protecao: prot,
    protecaoAtiva: Boolean(estado.config.protecao),
  };
}

function checarStops(estado, eventos) {
  const { stopWin, stopLoss } = estado.config;
  const u = estado.placar.unidades;
  if (!estado.pausado && stopWin > 0 && u >= stopWin) {
    estado.pausado = true;
    estado.motivoPausa = `stop win (${u.toFixed(2)}u)`;
    eventos.push({ tipo: "pausa", motivo: estado.motivoPausa });
  } else if (!estado.pausado && stopLoss > 0 && u <= -stopLoss) {
    estado.pausado = true;
    estado.motivoPausa = `stop loss (${u.toFixed(2)}u)`;
    eventos.push({ tipo: "pausa", motivo: estado.motivoPausa });
  }
}

function resolverAberto(estado, resultado, eventos) {
  const sinal = estado.sinal;
  const ficha = fichaDoNivel(estado.config.ficha, sinal.gale);
  const fracao = estado.config.protecao ? Number(estado.config.protecaoFracao || 0) : 0;
  const prot = r2(ficha * fracao);
  const maxGale = maxGaleDe(estado.config);

  if (resultado === "E") {
    estado.placar.empates += 1;
    if (estado.config.protecao && prot > 0) {
      const net = r2(-r2(ficha * 0.1) + r2(prot * 4));
      sinal.ciclo = r2(sinal.ciclo + net);
      estado.placar.unidades = r2(estado.placar.unidades + net);
      estado.placar.greens += 1;
      estado.placar.ciclos += 1;
      eventos.push({
        tipo: "green",
        via: "protecao",
        lado: sinal.lado,
        gale: sinal.gale,
        net,
        ciclo: sinal.ciclo,
        placar: { ...estado.placar },
      });
      estado.sinal = null;
      return;
    }
    const net = r2(-ficha * 0.1);
    sinal.ciclo = r2(sinal.ciclo + net);
    estado.placar.unidades = r2(estado.placar.unidades + net);
    eventos.push({
      tipo: "empate",
      lado: sinal.lado,
      gale: sinal.gale,
      net,
      ciclo: sinal.ciclo,
      ficha,
      placar: { ...estado.placar },
    });
    return;
  }

  if (resultado === sinal.lado) {
    const net = r2(ficha - prot);
    sinal.ciclo = r2(sinal.ciclo + net);
    estado.placar.unidades = r2(estado.placar.unidades + net);
    estado.placar.greens += 1;
    estado.placar.ciclos += 1;
    eventos.push({
      tipo: "green",
      via: sinal.gale === 0 ? "entrada" : `gale${sinal.gale}`,
      lado: sinal.lado,
      gale: sinal.gale,
      net,
      ciclo: sinal.ciclo,
      placar: { ...estado.placar },
    });
    estado.sinal = null;
    return;
  }

  const net = r2(-(ficha + prot));
  sinal.ciclo = r2(sinal.ciclo + net);
  estado.placar.unidades = r2(estado.placar.unidades + net);
  if (sinal.gale < maxGale) {
    sinal.gale += 1;
    eventos.push({
      ...eventoSinal(estado, "gale"),
      net,
      ciclo: sinal.ciclo,
    });
    return;
  }

  estado.placar.reds += 1;
  estado.placar.ciclos += 1;
  estado.cooldown = Math.max(0, Number(estado.config.cooldownAposRed) || 0);
  eventos.push({
    tipo: "red",
    lado: sinal.lado,
    gale: sinal.gale,
    net,
    ciclo: sinal.ciclo,
    placar: { ...estado.placar },
  });
  estado.sinal = null;
}

function reduzir(estado, resultado) {
  const s = structuredClone(estado);
  s.undoStack = [];
  s.historico.push(resultado);
  if (s.historico.length > 300) {
    s.historico.splice(0, s.historico.length - 300);
  }
  const eventos = [];
  const tinha = Boolean(s.sinal);
  if (tinha) {
    resolverAberto(s, resultado, eventos);
    checarStops(s, eventos);
    if (!s.sinal && !s.pausado && s.cooldown === 0) {
      const gatilho = avaliarGatilho(s);
      if (gatilho) abrirSinal(s, gatilho, eventos);
    }
  } else if (s.cooldown > 0) {
    s.cooldown -= 1;
  } else if (!s.pausado) {
    const gatilho = avaliarGatilho(s);
    if (gatilho) abrirSinal(s, gatilho, eventos);
  }
  return { estado: s, eventos };
}

function semPilha(estado) {
  const copia = structuredClone(estado);
  delete copia.undoStack;
  return copia;
}

function lancar(estado, valor) {
  const resultado = normalizarResultado(valor);
  const snap = semPilha(estado);
  const { estado: proximo, eventos } = reduzir(estado, resultado);
  proximo.undoStack = [...(estado.undoStack || []), snap].slice(-30);
  return { estado: proximo, eventos };
}

function lancarVarios(estado, valores) {
  let atual = estado;
  const eventos = [];
  for (const valor of valores) {
    const passo = lancar(atual, valor);
    atual = passo.estado;
    eventos.push(...passo.eventos);
  }
  return { estado: atual, eventos };
}

function desfazer(estado) {
  const pilha = estado.undoStack || [];
  if (pilha.length === 0) {
    throw new Error("Nada para desfazer.");
  }
  const anterior = structuredClone(pilha[pilha.length - 1]);
  anterior.undoStack = pilha.slice(0, -1);
  return anterior;
}

function forcarEntrada(estado, valor) {
  const lado = normalizarResultado(valor);
  if (lado === "E") throw new Error("Entrada manual só em PLAYER ou BANKER.");
  if (estado.sinal) throw new Error("Já existe um sinal aberto. Cancele ou lance o resultado.");
  if (estado.pausado) throw new Error(`Bot pausado (${estado.motivoPausa || "manual"}).`);
  const s = structuredClone(estado);
  const eventos = [];
  abrirSinal(s, { lado, origem: "entrada manual" }, eventos);
  return { estado: s, eventos };
}

function cancelarSinal(estado) {
  if (!estado.sinal) throw new Error("Não há sinal aberto.");
  const s = structuredClone(estado);
  s.sinal = null;
  return {
    estado: s,
    eventos: [{ tipo: "info", texto: "Sinal cancelado. O que já entrou no placar permanece." }],
  };
}

function definirPausa(estado, pausado) {
  const s = structuredClone(estado);
  s.pausado = pausado;
  s.motivoPausa = pausado ? "manual" : null;
  if (!pausado) s.cooldown = 0;
  return s;
}

function resetPlacar(estado) {
  const s = structuredClone(estado);
  s.placar = { greens: 0, reds: 0, empates: 0, unidades: 0, ciclos: 0 };
  s.sinal = null;
  s.cooldown = 0;
  s.undoStack = [];
  return s;
}

function atualizarConfig(estado, patch) {
  const s = structuredClone(estado);
  const c = s.config;
  if (patch.estrategia) {
    const ok = ["quebra", "continuacao", "padroes"];
    if (!ok.includes(patch.estrategia)) {
      throw new Error("Estratégia: quebra, continuacao ou padroes.");
    }
    c.estrategia = patch.estrategia;
  }
  if (patch.sequencia != null) {
    const n = Number(patch.sequencia);
    if (!Number.isInteger(n) || n < 2 || n > 8) {
      throw new Error("Sequência entre 2 e 8.");
    }
    c.sequencia = n;
  }
  if (patch.protecao != null) c.protecao = Boolean(patch.protecao);
  if (patch.protecaoFracao != null) {
    const n = Number(patch.protecaoFracao);
    if (!(n >= 0 && n <= 0.5)) throw new Error("Fração da proteção entre 0 e 0.5.");
    c.protecaoFracao = n;
  }
  if (patch.ficha != null) {
    const n = Number(patch.ficha);
    if (!(n > 0 && n <= 100000)) throw new Error("Ficha inválida.");
    c.ficha = r2(n);
  }
  if (patch.stopWin != null) c.stopWin = Math.max(0, r2(Number(patch.stopWin) || 0));
  if (patch.stopLoss != null) c.stopLoss = Math.max(0, r2(Number(patch.stopLoss) || 0));
  if (patch.cooldownAposRed != null) {
    const n = Number(patch.cooldownAposRed);
    if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error("Cooldown entre 0 e 10.");
    c.cooldownAposRed = n;
  }
  c.maxGale = MAX_GALE;
  return s;
}

function dado() {
  return 1 + Math.floor(Math.random() * 6);
}

function resultadoJusto() {
  const player = dado() + dado();
  const banker = dado() + dado();
  if (player > banker) return "P";
  if (banker > player) return "B";
  return "E";
}

function simular(rodadas, config = {}) {
  let estado = criarEstado({ config: { ...configPadrao(), protecao: false, ...config } });
  for (let i = 0; i < rodadas; i += 1) {
    estado = lancar(estado, resultadoJusto()).estado;
    if (estado.pausado) break;
  }
  return estado;
}

function resumir(estado) {
  const { greens, reds, unidades, ciclos } = estado.placar;
  const fechados = greens + reds;
  const assertividade = fechados === 0 ? 0 : r2((greens / fechados) * 100);
  return {
    estrategia: estado.config.estrategia,
    pausado: estado.pausado,
    motivoPausa: estado.motivoPausa,
    cooldown: estado.cooldown,
    sinal: estado.sinal
      ? {
          lado: estado.sinal.lado,
          gale: estado.sinal.gale,
          origem: estado.sinal.origem,
          ciclo: estado.sinal.ciclo,
        }
      : null,
    historico: estado.historico.slice(-20).join(""),
    placar: { ...estado.placar, assertividade, ciclos },
    unidades,
  };
}

const raiz = path.dirname(fileURLToPath(import.meta.url));

function lerEnvArquivo(arquivo) {
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, "utf8").split("\n")) {
    const texto = linha.trim();
    if (!texto || texto.startsWith("#")) continue;
    const i = texto.indexOf("=");
    if (i < 0) continue;
    const chave = texto.slice(0, i).trim();
    let valor = texto.slice(i + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (process.env[chave] == null || process.env[chave] === "") {
      process.env[chave] = valor;
    }
  }
}

lerEnvArquivo(path.join(raiz, ".env"));

const TOKEN = process.env.BOT_TOKEN || "";
const ADMINS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const CANAL = process.env.CHANNEL_ID || "";
const PORT = Number(process.env.PORT || 8787);
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const STATE_FILE = path.resolve(raiz, process.env.STATE_FILE || "./data/state.json");

function carregar() {
  try {
    const cru = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return criarEstado(cru);
  } catch {
    return criarEstado();
  }
}

function salvar(estado) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  const copia = structuredClone(estado);
  copia.undoStack = (copia.undoStack || []).slice(-30);
  fs.writeFileSync(tmp, JSON.stringify(copia));
  fs.renameSync(tmp, STATE_FILE);
}

function u(n) {
  const v = Number(n) || 0;
  return `\( {v > 0 ? "+" : ""} \){v.toFixed(2)}u`;
}

function linhaPlacar(placar) {
  const fechados = placar.greens + placar.reds;
  const taxa = fechados === 0 ? 0 : (placar.greens / fechados) * 100;
  return `${placar.greens} green · ${placar.reds} red · ${taxa.toFixed(0)}% · ${u(placar.unidades)}`;
}

function formatar(evento) {
  if (evento.tipo === "entrada") {
    return [
      "BAC BO · ENTRADA",
      "",
      `Entrada: ${nomeLado(evento.lado)}`,
      `Padrão: ${evento.origem}`,
      "Gale: até 2",
      `Ficha: ${evento.ficha.toFixed(2)}u`,
      evento.protecaoAtiva
        ? `Proteção no empate: ${evento.protecao.toFixed(2)}u (piso 4:1)`
        : "Proteção no empate: não",
      "",
      "Não é previsão. Player/Banker devolvem \~98,87%.",
      "Empate tira 10% da ficha principal. +18.",
    ].join("\n");
  }
  if (evento.tipo === "gale") {
    return [
      `BAC BO · GALE ${evento.gale}`,
      "",
      `Repetir: ${nomeLado(evento.lado)}`,
      `Ficha desta etapa: ${evento.ficha.toFixed(2)}u`,
      evento.protecaoAtiva ? `Proteção: ${evento.protecao.toFixed(2)}u` : "Proteção: não",
      `Ciclo até aqui: ${u(evento.ciclo)}`,
      "",
      "Última repetição possível é o gale 2.",
    ].join("\n");
  }
  if (evento.tipo === "green") {
    const onde =
      evento.via === "protecao"
        ? "empate com proteção"
        : evento.via === "entrada"
          ? "entrada"
          : evento.via.replace("gale", "gale ");
    return [
      "BAC BO · GREEN",
      "",
      `${nomeLado(evento.lado)} · ${onde}`,
      `Ciclo: ${u(evento.ciclo)}`,
      linhaPlacar(evento.placar),
    ].join("\n");
  }
  if (evento.tipo === "red") {
    return [
      "BAC BO · RED",
      "",
      `${nomeLado(evento.lado)} estourou no gale ${evento.gale}`,
      `Ciclo: ${u(evento.ciclo)}`,
      linhaPlacar(evento.placar),
      "Sem gale 3.",
    ].join("\n");
  }
  if (evento.tipo === "empate") {
    return [
      "BAC BO · EMPATE",
      "",
      `${nomeLado(evento.lado)} segue no gale ${evento.gale}`,
      `Ajuste da regra (perde 10%): ${u(evento.net)}`,
      `Ciclo: ${u(evento.ciclo)}`,
      "A entrada não avança de gale.",
    ].join("\n");
  }
  if (evento.tipo === "pausa") {
    return `BAC BO · PAUSA\n\n${evento.motivo}\nNovo sinal só depois de /retomar.`;
  }
  if (evento.tipo === "info") return evento.texto;
  return "";
}

function textoStatus(estado) {
  const r = resumir(estado);
  const sinal = r.sinal
    ? `${nomeLado(r.sinal.lado)} · gale ${r.sinal.gale} · ${r.sinal.origem} · ciclo ${u(r.sinal.ciclo)}`
    : "nenhum";
  return [
    "BAC BO · STATUS",
    "",
    `Estratégia: ${estado.config.estrategia}`,
    `Sequência: ${estado.config.sequencia}`,
    `Proteção: \( {estado.config.protecao ? `sim ( \){estado.config.protecaoFracao})` : "não"}`,
    `Ficha base: ${estado.config.ficha.toFixed(2)}u`,
    `Stop: win ${estado.config.stopWin || "off"} · loss ${estado.config.stopLoss || "off"}`,
    `Cooldown após red: ${estado.config.cooldownAposRed}`,
    `Pausa: ${r.pausado ? r.motivoPausa : "não"}`,
    `Cooldown: ${r.cooldown}`,
    `Sinal: ${sinal}`,
    `Histórico: ${r.historico || "—"}`,
    linhaPlacar({ ...estado.placar }),
  ].join("\n");
}

function ajuda() {
  return [
    "Comandos do admin",
    "",
    "P, B ou E — lança o resultado (também /p /b /e)",
    "/resultado P B E P — vários, na ordem",
    "/entrar player|banker — sinal manual",
    "/status — estado e placar",
    "/pausar  /retomar  /cancelar  /desfazer",
    "/reset — zera o placar e o sinal",
    "/estrategia quebra|continuacao|padroes",
    "/seq 3 — tamanho da sequência (2 a 8)",
    "/protecao on|off",
    "/ficha 1",
    "/stopwin 20   /stoploss 14   (0 desliga)",
    "/cooldown 1",
    "",
    "O gale para no 2. O placar só conta resultado lançado.",
  ].join("\n");
}

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot\( {TOKEN}/ \){method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === "getUpdates" ? 40000 : 15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(data.description || `${method} falhou`);
  }
  return data.result;
}

async function enviar(chatId, texto) {
  if (!chatId || !texto) return;
  await api("sendMessage", { chat_id: chatId, text: texto });
}

let estado = carregar();

function aplicar(mutacao) {
  const eventos = mutacao.eventos || [];
  if (mutacao.estado) estado = mutacao.estado;
  salvar(estado);
  return eventos;
}

function tratarTexto(texto) {
  const cru = texto.trim();
  if (!cru) return ["Mande P, B, E ou /ajuda."];

  if (cru.startsWith("/")) {
    const partes = cru.split(/\s+/);
    const nome = partes[0].split("@")[0].toLowerCase();
    const args = partes.slice(1);
    if (nome === "/start" || nome === "/ajuda" || nome === "/help") return [ajuda()];
    if (nome === "/status" || nome === "/placar") return [textoStatus(estado)];
    if (nome === "/pausar") {
      estado = definirPausa(estado, true);
      salvar(estado);
      return ["Pausado. Resultados ainda podem ser lançados, mas não sai sinal novo."];
    }
    if (nome === "/retomar") {
      estado = definirPausa(estado, false);
      salvar(estado);
      return ["Retomado."];
    }
    if (nome === "/cancelar") {
      const out = cancelarSinal(estado);
      return aplicar(out).map(formatar);
    }
    if (nome === "/desfazer") {
      estado = desfazer(estado);
      salvar(estado);
      return ["Último resultado desfeito.", textoStatus(estado)];
    }
    if (nome === "/reset") {
      estado = resetPlacar(estado);
      salvar(estado);
      return ["Placar e sinal zerados. Histórico mantido."];
    }
    if (nome === "/estrategia") {
      estado = atualizarConfig(estado, { estrategia: (args[0] || "").toLowerCase() });
      salvar(estado);
      return [`Estratégia: ${estado.config.estrategia}`];
    }
    if (nome === "/seq") {
      estado = atualizarConfig(estado, { sequencia: Number(args[0]) });
      salvar(estado);
      return [`Sequência: ${estado.config.sequencia}`];
    }
    if (nome === "/protecao") {
      const v = (args[0] || "").toLowerCase();
      if (!["on", "off", "sim", "nao", "não"].includes(v)) {
        return ["Use /protecao on ou /protecao off."];
      }
      estado = atualizarConfig(estado, { protecao: v === "on" || v === "sim" });
      salvar(estado);
      return [`Proteção: ${estado.config.protecao ? "ligada" : "desligada"}`];
    }
    if (nome === "/ficha") {
      estado = atualizarConfig(estado, { ficha: Number(args[0]) });
      salvar(estado);
      return [`Ficha base: ${estado.config.ficha.toFixed(2)}u`];
    }
    if (nome === "/stopwin") {
      estado = atualizarConfig(estado, { stopWin: Number(args[0]) });
      salvar(estado);
      return [`Stop win: ${estado.config.stopWin || "desligado"}`];
    }
    if (nome === "/stoploss") {
      estado = atualizarConfig(estado, { stopLoss: Number(args[0]) });
      salvar(estado);
      return [`Stop loss: ${estado.config.stopLoss || "desligado"}`];
    }
    if (nome === "/cooldown") {
      estado = atualizarConfig(estado, { cooldownAposRed: Number(args[0]) });
      salvar(estado);
      return [`Cooldown após red: ${estado.config.cooldownAposRed}`];
    }
    if (nome === "/entrar") {
      const out = forcarEntrada(estado, args[0] || "");
      return aplicar(out).map(formatar);
    }
    if (nome === "/resultado" || nome === "/r") {
      if (args.length === 0) return ["Use /resultado P B E"];
      return aplicar(lancarVarios(estado, args)).map(formatar);
    }
    if (nome === "/p" || nome === "/b" || nome === "/e") {
      return aplicar(lancar(estado, nome.slice(1))).map(formatar);
    }
    return ["Comando desconhecido. /ajuda"];
  }

  const tokens = cru.split(/[\s,;>+|/-]+/).filter(Boolean);
  const solto = /^(p|b|e|player|banker|empate|tie|t|azul|vermelho)$/i;
  if (tokens.length > 0 && tokens.every((t) => solto.test(t))) {
    return aplicar(lancarVarios(estado, tokens)).map(formatar);
  }
  return ["Não entendi. Mande P, B, E ou /ajuda."];
}

function vaiParaCanal(texto) {
  return /^BAC BO · (ENTRADA|GALE|GREEN|RED|EMPATE|PAUSA)/.test(texto);
}

async function publicar(chatOrigem, textos) {
  for (const texto of textos) {
    if (!texto) continue;
    if (CANAL && vaiParaCanal(texto) && String(CANAL) !== String(chatOrigem)) {
      await enviar(CANAL, texto);
    }
    await enviar(chatOrigem, texto);
  }
}

function servidorHttp() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resumir(estado)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/resultado") {
      if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ erro: "chave recusada" }));
        return;
      }
      let cru = "";
      req.on("data", (c) => {
        cru += c;
        if (cru.length > 20_000) req.destroy();
      });
      req.on("end", () => {
        try {
          const body = JSON.parse(cru || "{}");
          const lista = body.resultados || (body.resultado ? [body.resultado] : null);
          if (!Array.isArray(lista) || lista.length === 0) {
            throw new Error("Mande resultado ou resultados.");
          }
          const textos = aplicar(lancarVarios(estado, lista)).map(formatar).filter(Boolean);
          const destino = CANAL || [...ADMINS][0];
          Promise.all(textos.map((t) => enviar(destino, t))).catch((erro) => {
            console.error(erro.message);
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, mensagens: textos, status: resumir(estado) }));
        } catch (erro) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ erro: erro.message }));
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ erro: "não encontrado" }));
  });
  server.listen(PORT, "0.0.0.0");
  return server;
}

async function loop() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await api("getUpdates", { offset, timeout: 25 });
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        const userId = String(msg.from?.id || "");
        if (!ADMINS.has(userId)) {
          await enviar(msg.chat.id, "Este robô só obedece a lista de admins.");
          continue;
        }
        try {
          const textos = tratarTexto(msg.text);
          await publicar(msg.chat.id, textos);
        } catch (erro) {
          await enviar(msg.chat.id, erro.message);
        }
      }
    } catch (erro) {
      console.error(erro.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main() {
  const sim = process.argv.indexOf("--sim");
  if (sim !== -1) {
    const n = Number(process.argv[sim + 1] || 5000);
    const final = simular(n, { protecao: false, cooldownAposRed: 0 });
    const r = resumir(final);
    console.log(JSON.stringify({ rodadas: n, ...r.placar, pausado: final.pausado }, null, 2));
    return;
  }

  if (process.argv.includes("--demo")) {
    let e = criarEstado({ config: { protecao: true, sequencia: 3, cooldownAposRed: 0 } });
    const roleta = ["P", "P", "P", "B", "B", "B", "P", "E", "P", "P", "P", "P", "P", "P"];
    for (const item of roleta) {
      const passo = lancar(e, item === "x" ? resultadoJusto() : item);
      e = passo.estado;
      for (const ev of passo.eventos) console.log(formatar(ev), "\n---");
    }
    console.log(textoStatus(e));
    return;
  }

  if (!TOKEN) {
    console.error("Defina BOT_TOKEN no arquivo .env");
    process.exit(1);
  }
  if (ADMINS.size === 0) {
    console.error("Defina ADMIN_IDS no arquivo .env");
    process.exit(1);
  }

  servidorHttp();
  console.log(`Sinais Bac Bo no ar. HTTP :${PORT}  canal ${CANAL || "(só o admin)"}`);
  await loop();
}

main();