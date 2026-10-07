/*
 * Engine de periodização do método (metodo/periodizacao.html).
 *
 * Monta planos de corrida, ciclismo e natação isolados (com força de suporte) e de aquathlon,
 * duathlon e triathlon. As regras vêm do guia: modelo de três zonas, distribuição de intensidade
 * por fase, mesociclos 3:1 ou alternados, divisão do tempo entre modalidades por fase, matriz de
 * compatibilidade para encaixar as sessões nos dias, força periodizada e carga integrada com teto
 * de impacto da corrida. Tudo que é número de regra está em RULES, para ser trocado num lugar só.
 *
 * Funciona no navegador (window.MethodEngine) e no Node (require).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MethodEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "0.1.0";

  function PlanError(message) { this.name = "PlanError"; this.message = message; }
  PlanError.prototype = Object.create(Error.prototype);
  PlanError.prototype.constructor = PlanError;

  // ------------------------------------------------------------------------
  // Regras do método
  // ------------------------------------------------------------------------

  var RULES = {
    // Distribuição do tempo aeróbio por zona em cada fase (base, construção, específico, polimento).
    models: {
      polarizado: [[85, 5, 10], [80, 5, 15], [78, 7, 15], [82, 5, 13]],
      piramidal: [[80, 15, 5], [76, 17, 7], [72, 20, 8], [78, 14, 8]],
      limiar: [[60, 35, 5], [55, 37, 8], [50, 40, 10], [60, 30, 10]]
    },
    model_auto: { polarized_min_hours: 6, threshold_max_hours: 5, threshold_max_sessions: 4 },
    // Fases: fração das semanas de treino (sem o polimento) na base e no específico.
    phase_split: { base: 0.40, base_beginner: 0.50, specific: 0.25 },
    // Mesociclos.
    mesocycle: { cycle: 4, deload: 0.70, growth_max: 0.10, growth_beginner: 0.08, alternate_min_age: 50, alternate_growth: 0.10 },
    taper_fractions: { 1: [0.65], 2: [0.8, 0.6], 3: [0.9, 0.75, 0.6] },
    race_week_min: 150, race_week_frac: 0.45,
    taper_key_work: 0.6,
    // Corrida: teto de impacto.
    run: { km_growth: 0.10, long_frac: 0.32, two_week_jump: 0.30 },
    // Divisão do tempo aeróbio por modalidade e fase.
    shares: {
      corrida: { run: [1, 1, 1, 1] }, ciclismo: { bike: [1, 1, 1, 1] }, natacao: { swim: [1, 1, 1, 1] },
      aquathlon: { swim: [0.50, 0.46, 0.42, 0.47], run: [0.50, 0.54, 0.58, 0.53] },
      duathlon: { run: [0.44, 0.46, 0.47, 0.47], bike: [0.56, 0.54, 0.53, 0.53] },
      tri_curto: { swim: [0.28, 0.27, 0.26, 0.32], bike: [0.44, 0.43, 0.40, 0.37], run: [0.28, 0.30, 0.34, 0.31] },
      tri_longo: { swim: [0.22, 0.19, 0.15, 0.21], bike: [0.54, 0.58, 0.60, 0.51], run: [0.24, 0.23, 0.25, 0.28] }
    },
    run_share_cap: { tri_curto: 0.35, tri_longo: 0.27 },
    // Sessões por semana e modalidade, por nível (iniciante, intermediário, avançado, elite).
    sessions: {
      corrida: { run: [3, 4, 5, 6] }, ciclismo: { bike: [3, 4, 5, 5] }, natacao: { swim: [3, 4, 5, 6] },
      aquathlon: { swim: [2, 3, 3, 4], run: [3, 3, 4, 4] }, duathlon: { run: [3, 3, 4, 4], bike: [2, 3, 3, 4] },
      tri_curto: { swim: [2, 3, 3, 4], bike: [2, 3, 3, 4], run: [2, 3, 3, 4] }, tri_longo: { swim: [2, 3, 3, 3], bike: [3, 3, 4, 4], run: [2, 3, 3, 4] }
    },
    swim_min_sessions: 3,
    // Duração média de uma sessão (por nível) para derivar o número de sessões das horas; teto das leves.
    avg_session: { run: [45, 60, 65, 70], bike: [75, 90, 100, 110], swim: [45, 55, 60, 65] },
    easy_max: { run: 75, bike: 120, swim: 60 },
    extra_sessions: 2,
    // Força: sessões por fase e conteúdo.
    strength: { build: 2, specific: 1, last_heavy_days: 7, adaptation_weeks: 3,
      minutes: { adaptacao: 50, forca: 50, potencia: 40, manutencao: 40, core: 20 },
      load: { adaptacao: 40, forca: 55, potencia: 45, manutencao: 40, core: 15 } },
    // Sessões: aquecimento e volta à calma, teto de trabalho por sessão, recuperação entre tiros.
    warm: { run: [12, 8], bike: [15, 10], swim: [8, 5] },
    work_cap: { run: { Z2: 40, Z3: 20 }, bike: { Z2: 60, Z3: 30 }, swim: { Z2: 40, Z3: 20 } },
    work_min: { Z2: 12, Z3: 10 },
    recovery: { run: { Z2: 0.15, Z3: 0.9 }, bike: { Z2: 0.2, Z3: 1.0 }, swim: { Z2: 0.12, Z3: 0.5 } },
    // Fração do tempo da modalidade que vai para a sessão longa: maior quando a modalidade divide a semana.
    long: { frac: { run: 0.32, bike: 0.42, swim: 0.33 }, frac_multi: { run: 0.45, bike: 0.5, swim: 0.35 }, frac_long_multi: { run: 0.5, bike: 0.55, swim: 0.35 },
      min: { run: 45, bike: 60, swim: 40 } },
    easy_min: { run: 30, bike: 45, swim: 30 },
    // Carga: fator de intensidade por zona (TSS = IF² × horas × 100), constantes de Banister.
    load: { IF: { Z1: 0.65, Z2: 0.90, Z3: 1.08 }, ctl_days: 42, atl_days: 7, ctl_ramp_max: 5, tsb_race: { curto: [5, 20], longo: [10, 25] } },
    // Pace de caminhada/relação bike-corrida para converter volumes atuais em horas.
    bricks: { transition_build: 15, transition_specific: 20, transition_long: 30, transition_long_specific: 40 }
  };

  // ------------------------------------------------------------------------
  // Modalidades e objetivos
  // ------------------------------------------------------------------------

  var SPORT = { run: { name: "Corrida" }, bike: { name: "Ciclismo" }, swim: { name: "Natação" }, gym: { name: "Força" } };
  var LEVELS = ["iniciante", "intermediario", "avancado", "elite"];
  var LEVEL_LABEL = { iniciante: "Iniciante", intermediario: "Intermediário", avancado: "Avançado", elite: "Elite" };
  var PHASES = ["base", "construcao", "especifico", "polimento"];
  var PHASE_LABEL = { base: "Base", construcao: "Construção", especifico: "Específico", polimento: "Polimento" };
  var PHASE_FOCUS = {
    base: "Volume em Z1, técnica e força máxima. Pouco tempo entre os limiares.",
    construcao: "Limiar e VO2máx alternados. A força vira potência.",
    especifico: "Ritmo de prova dentro das sessões longas. Força só para manter.",
    polimento: "Volume cai 40% a 60%; intensidade e frequência ficam."
  };

  // kind: curto ou longo (define a divisão do tempo e a demanda); taper em semanas;
  // long_max: teto da sessão longa por modalidade em minutos; min_weeks: duração mínima do plano.
  var OBJ = {
    corrida: { name: "Corrida", legs: ["run"], main: "run", shares: "corrida", distances: {
      "5k": { name: "5 km", run: 5, kind: "curto", taper: 1, min_weeks: 6, long_max: { run: 75 } },
      "10k": { name: "10 km", run: 10, kind: "curto", taper: 1, min_weeks: 6, long_max: { run: 90 } },
      "21k": { name: "Meia maratona", run: 21.0975, kind: "longo", taper: 2, min_weeks: 8, long_max: { run: 120 } },
      "42k": { name: "Maratona", run: 42.195, kind: "longo", taper: 2, min_weeks: 12, long_max: { run: 165 } },
      "50k": { name: "Ultra 50 km", run: 50, kind: "longo", taper: 2, min_weeks: 12, long_max: { run: 180 } } } },
    ciclismo: { name: "Ciclismo", legs: ["bike"], main: "bike", shares: "ciclismo", distances: {
      cr40: { name: "Contrarrelógio 40 km", bike: 40, kind: "curto", taper: 1, min_weeks: 6, long_max: { bike: 150 } },
      gf100: { name: "Gran fondo 100 km", bike: 100, kind: "longo", taper: 2, min_weeks: 8, long_max: { bike: 240 } },
      gf160: { name: "Gran fondo 160 km", bike: 160, kind: "longo", taper: 2, min_weeks: 10, long_max: { bike: 300 } } } },
    natacao: { name: "Natação", legs: ["swim"], main: "swim", shares: "natacao", distances: {
      "1.5k": { name: "1,5 km em águas abertas", swim: 1500, kind: "curto", taper: 1, min_weeks: 6, long_max: { swim: 60 } },
      "3k": { name: "3 km em águas abertas", swim: 3000, kind: "curto", taper: 1, min_weeks: 8, long_max: { swim: 75 } },
      "5k": { name: "5 km em águas abertas", swim: 5000, kind: "longo", taper: 1, min_weeks: 8, long_max: { swim: 90 } },
      "10k": { name: "10 km em águas abertas", swim: 10000, kind: "longo", taper: 2, min_weeks: 10, long_max: { swim: 120 } } } },
    aquathlon: { name: "Aquathlon", legs: ["swim", "run"], main: "run", shares: "aquathlon", distances: {
      sprint: { name: "Sprint (750 m + 5 km)", swim: 750, run: 5, kind: "curto", taper: 1, min_weeks: 6, long_max: { swim: 60, run: 80 } },
      olimpico: { name: "Olímpico (1,5 km + 10 km)", swim: 1500, run: 10, kind: "curto", taper: 1, min_weeks: 8, long_max: { swim: 70, run: 90 } } } },
    duathlon: { name: "Duathlon", legs: ["run", "bike", "run"], main: "run", shares: "duathlon", distances: {
      sprint: { name: "Sprint (5 + 20 + 2,5 km)", run: 5, bike: 20, run2: 2.5, kind: "curto", taper: 1, min_weeks: 6, long_max: { run: 80, bike: 120 } },
      padrao: { name: "Padrão (10 + 40 + 5 km)", run: 10, bike: 40, run2: 5, kind: "curto", taper: 1, min_weeks: 8, long_max: { run: 95, bike: 150 } } } },
    triathlon: { name: "Triathlon", legs: ["swim", "bike", "run"], main: "run", shares: null, distances: {
      sprint: { name: "Sprint (750 m + 20 km + 5 km)", swim: 750, bike: 20, run: 5, kind: "curto", taper: 1, min_weeks: 6, long_max: { swim: 60, run: 80, bike: 120 } },
      olimpico: { name: "Olímpico (1,5 km + 40 km + 10 km)", swim: 1500, bike: 40, run: 10, kind: "curto", taper: 2, min_weeks: 8, long_max: { swim: 70, run: 95, bike: 150 } },
      "703": { name: "70.3 (1,9 km + 90 km + 21,1 km)", swim: 1900, bike: 90, run: 21.0975, kind: "longo", taper: 2, min_weeks: 10, long_max: { swim: 80, run: 120, bike: 240 } },
      ironman: { name: "Ironman (3,8 km + 180 km + 42,2 km)", swim: 3800, bike: 180, run: 42.195, kind: "longo", taper: 3, min_weeks: 14, long_max: { swim: 90, run: 150, bike: 300 } } } }
  };
  // Intensidade da prova, em % do limiar, por perna (para os ritmos-alvo e a estimativa de tempo).
  var RACE_INTENSITY = {
    run: { 5: 1.04, 10: 1.0, 21.0975: 0.95, 42.195: 0.88, 50: 0.82 },
    bike: { cr40: 1.0, gf100: 0.74, gf160: 0.68, sprint: 0.95, olimpico: 0.9, "703": 0.78, ironman: 0.7, padrao: 0.9 },
    swim: { 750: 1.02, 1500: 1.0, 1900: 0.96, 3000: 0.96, 3800: 0.93, 5000: 0.94, 10000: 0.9 }
  };
  var MULTI_RUN_SLOWDOWN = { aquathlon: 1.02, duathlon: 1.03, sprint: 1.04, olimpico: 1.04, "703": 1.07, ironman: 1.12 };
  var TRANSITIONS_MIN = { aquathlon: 1.5, duathlon: 3, sprint: 3, olimpico: 3, "703": 5, ironman: 8 };

  // ------------------------------------------------------------------------
  // Utilitários
  // ------------------------------------------------------------------------

  function plain(v) { return String(v == null ? "" : v).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
  function blank(v) { return v == null || String(v).trim() === ""; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function round1(x) { return Math.round(x * 10 + 1e-9) / 10; }
  function r5(x) { return Math.round(x / 5) * 5; }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function mod(a, b) { return ((a % b) + b) % b; }
  function fmt(x, d) { return (d ? x.toFixed(d) : String(Math.round(x))).replace(".", ","); }
  function hm(min) { var h = Math.floor(min / 60), m = Math.round(min % 60); return h ? h + "h" + (m ? pad2(m) : "") : m + " min"; }

  function parseNumber(value, label, min, max) {
    if (blank(value)) return null;
    var n = Number(String(value).trim().replace(",", "."));
    if (!isFinite(n)) throw new PlanError(label + ": número inválido (" + value + ").");
    if (min != null && n < min) throw new PlanError(label + " deve ser pelo menos " + fmt(min, min % 1 ? 1 : 0) + ".");
    if (max != null && n > max) throw new PlanError(label + " deve ser no máximo " + fmt(max, max % 1 ? 1 : 0) + ".");
    return n;
  }
  function parseTime(value, label) {
    var text = String(value).trim();
    if (/^\d+$/.test(text)) text = text.length <= 2 ? text : text.length <= 4 ? text.slice(0, -2) + ":" + text.slice(-2) : text.slice(0, -4) + ":" + text.slice(-4, -2) + ":" + text.slice(-2);
    var parts = text.split(":");
    if (!(parts.length >= 2 && parts.length <= 3 && parts.every(function (p) { return /^\d+$/.test(p); }))) throw new PlanError(label + ": tempo inválido (" + value + "). Use mm:ss ou h:mm:ss.");
    var s = 0;
    parts.forEach(function (p, i) { var n = parseInt(p, 10); if (i && n >= 60) throw new PlanError(label + ": minutos e segundos vão até 59."); s = s * 60 + n; });
    if (s <= 0) throw new PlanError(label + ": tempo inválido.");
    return s;
  }
  function formatTime(seconds) {
    var t = Math.round(seconds), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? h + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
  }
  function formatPace(sPerKm) { var t = Math.round(sPerKm); return Math.floor(t / 60) + ":" + pad2(t % 60); }

  var DAY_MS = 86400000;
  function parseIsoDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return Math.round(t / DAY_MS);
  }
  function isoDate(day) { return new Date(day * DAY_MS).toISOString().slice(0, 10); }
  function weekday(day) { return mod(day + 3, 7); } // 0 = segunda
  function todayLocal() { var n = new Date(); return Math.round(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / DAY_MS); }
  var DAY_SHORT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  var DAY_AT = ["na segunda", "na terça", "na quarta", "na quinta", "na sexta", "no sábado", "no domingo"];
  function joinList(a) { return a.length > 1 ? a.slice(0, -1).join(", ") + " e " + a[a.length - 1] : a.join(""); }

  // ------------------------------------------------------------------------
  // Fisiologia: ritmos, potência e CSS
  // ------------------------------------------------------------------------

  function vo2Cost(v) { return -4.60 + 0.182258 * v + 0.000104 * v * v; }
  function fractionSustainable(min) { return 0.8 + 0.1894393 * Math.exp(-0.012778 * min) + 0.2989558 * Math.exp(-0.1932605 * min); }
  function velocityForVo2(vo2) { var a = 0.000104, b = 0.182258, c = -4.60 - vo2; return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a); }
  function vdotFromPerformance(km, s) { var min = s / 60; return vo2Cost(km * 1000 / min) / fractionSustainable(min); }
  function predictTimeS(vdot, km) {
    var lo = km * 1.5, hi = km * 25;
    for (var i = 0; i < 80; i++) { var mid = (lo + hi) / 2; if (vdotFromPerformance(km, mid * 60) > vdot) lo = mid; else hi = mid; }
    return (lo + hi) / 2 * 60 * (km > 42.2 ? 1.04 : 1);
  }
  function paceAt(vdot, frac) { return 60000 / velocityForVo2(vdot * frac); }
  var DEFAULT_VDOT = { iniciante: 32, intermediario: 41, avancado: 50, elite: 60 };
  var DEFAULT_FTP = { iniciante: 150, intermediario: 200, avancado: 250, elite: 310 };
  var DEFAULT_CSS = { iniciante: 135, intermediario: 115, avancado: 100, elite: 88 };

  function runZones(vdot) {
    var easyFast = paceAt(vdot, 0.70), easySlow = paceAt(vdot, 0.62), T = paceAt(vdot, 0.88), I = paceAt(vdot, 0.975);
    var M = predictTimeS(vdot, 42.195) / 42.195;
    return { vdot: round1(vdot), E: [easySlow, easyFast], M: M, T: T, I: I,
      Z1: formatPace(easySlow) + "–" + formatPace(easyFast) + "/km", Z2: formatPace(M) + "–" + formatPace(T) + "/km", Z3: formatPace(I) + "/km",
      threshold_kmh: 3600 / T };
  }
  function bikeZones(ftp) {
    return { ftp: ftp, Z1: Math.round(ftp * 0.56) + "–" + Math.round(ftp * 0.75) + " W", Z2: Math.round(ftp * 0.76) + "–" + Math.round(ftp * 1.05) + " W",
      Z3: Math.round(ftp * 1.06) + "–" + Math.round(ftp * 1.2) + " W", sweet: Math.round(ftp * 0.88) + "–" + Math.round(ftp * 0.94) + " W" };
  }
  function swimZones(css) {
    return { css: css, Z1: "mais lento que " + formatPace(css + 8) + "/100 m", Z2: formatPace(css + 8) + "–" + formatPace(css) + "/100 m", Z3: "mais rápido que " + formatPace(css) + "/100 m" };
  }
  // Velocidade de bike em km/h a partir da potência (ciclista de 75 kg, CdA 0,32, plano).
  function bikeSpeed(watts) {
    var lo = 10, hi = 60;
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2, v = mid / 3.6, p = 0.5 * 1.2 * 0.32 * v * v * v + 0.004 * 85 * 9.81 * v;
      if (p < watts) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ------------------------------------------------------------------------
  // Sessões: montagem dos treinos
  // ------------------------------------------------------------------------

  var IF = RULES.load.IF;
  function loadOf(parts) { return Math.round(parts.reduce(function (s, p) { return s + p.min / 60 * IF[p.zone] * IF[p.zone] * 100; }, 0)); }
  function part(zone, min, label) { return { zone: zone, min: Math.round(min), label: label }; }

  function session(sport, kind, zone, parts, title, steps, extra) {
    var min = parts.reduce(function (s, p) { return s + p.min; }, 0);
    var zoneMin = { Z1: 0, Z2: 0, Z3: 0 };
    parts.forEach(function (p) { zoneMin[p.zone] += p.min; });
    var s = { sport: sport, kind: kind, zone: zone, min: min, title: title, steps: steps || [], parts: parts, zone_min: zoneMin, load: loadOf(parts) };
    if (extra) Object.keys(extra).forEach(function (k) { s[k] = extra[k]; });
    return s;
  }

  // Tiros: número e duração a partir do trabalho total.
  function reps(work, rep) { var n = Math.max(2, Math.round(work / rep)); return { n: n, rep: rep, work: n * rep }; }

  function keySession(sport, zone, work, phase, ctx) {
    var warm = RULES.warm[sport], rec = RULES.recovery[sport][zone], z = ctx.zones[sport];
    var title, steps, workParts = [], recMin;
    if (sport === "run") {
      if (zone === "Z3") {
        if (phase === "base") { var h = reps(work, 0.75); title = "Subidas curtas · " + h.n + " × 45″"; steps = [h.n + " × 45″ subindo forte (" + z.Z3 + " no plano), desce trotando", "+ 4 strides de 20″ no fim"]; work = h.work; recMin = work * 1.5; }
        else { var r3 = reps(work, 3); title = "VO2máx · " + r3.n + " × 3′ em I"; steps = [r3.n + " × 3′ a " + z.Z3 + ", 3′ de trote entre eles"]; work = r3.work; recMin = work * rec; }
      } else if (phase === "especifico" && ctx.kindLong) {
        title = "Ritmo de prova · " + Math.round(work) + "′ em M"; steps = [Math.round(work) + "′ contínuos no ritmo de prova (" + ctx.racePace.run + ")"]; recMin = 0;
      } else { var r2 = reps(work, work >= 30 ? 10 : 8); title = "Limiar · " + r2.n + " × " + r2.rep + "′ em T"; steps = [r2.n + " × " + r2.rep + "′ a " + formatPace(z.T) + "/km, 2′ de trote"]; work = r2.work; recMin = r2.n * 2; }
    } else if (sport === "bike") {
      if (zone === "Z3") { var b3 = reps(work, 4); title = "VO2máx · " + b3.n + " × 4′ a 110–120%"; steps = [b3.n + " × 4′ a " + z.Z3 + ", 4′ leves entre eles"]; work = b3.work; recMin = work * rec; }
      else if (phase === "especifico" && ctx.kindLong) { title = "Ritmo de prova · " + Math.round(work) + "′"; steps = [Math.round(work) + "′ a " + ctx.racePace.bike + ", cadência da prova"]; recMin = 0; }
      else if (phase === "base") { var ss = reps(work, 15); title = "Sweet spot · " + ss.n + " × 15′ a 88–94%"; steps = [ss.n + " × 15′ a " + z.sweet + ", 5′ leves"]; work = ss.work; recMin = ss.n * 5; }
      else { var bl = reps(work, 20); title = "Limiar · " + bl.n + " × 20′ a 95–100%"; steps = [bl.n + " × 20′ a " + Math.round(ctx.inputs.ftp * 0.95) + "–" + ctx.inputs.ftp + " W, 5′ leves"]; work = bl.work; recMin = bl.n * 5; }
    } else {
      if (zone === "Z3") { var n50 = Math.max(8, Math.round(work / 0.9)); title = "Velocidade · " + n50 + " × 50 m forte"; steps = [n50 + " × 50 m forte (" + z.Z3 + "), 30″ a 40″ de pausa", "800 m com pull para fechar"]; work = n50 * 0.9; recMin = work * rec; }
      else if (phase === "especifico") { var n400 = Math.max(3, Math.round(work / (ctx.inputs.css * 4 / 60))); title = "Ritmo de prova · " + n400 + " × 400 m"; steps = [n400 + " × 400 m a " + ctx.racePace.swim + ", 30″ de pausa"]; work = n400 * ctx.inputs.css * 4 / 60; recMin = n400 * 0.5; }
      else { var n200 = Math.max(4, Math.round(work / (ctx.inputs.css * 2 / 60))); title = "CSS · " + n200 + " × 200 m"; steps = [n200 + " × 200 m na CSS (" + formatPace(ctx.inputs.css) + "/100 m), 15″ a 20″ de pausa"]; work = n200 * ctx.inputs.css * 2 / 60; recMin = n200 * 0.3; }
    }
    var parts = [part("Z1", warm[0], "aquecimento"), part(zone, work, "trabalho")];
    if (recMin) parts.push(part("Z1", recMin, "recuperação"));
    parts.push(part("Z1", warm[1], "volta à calma"));
    return session(sport, "key", zone, parts, title, steps);
  }

  function longSession(sport, min, phase, ctx, racePart) {
    var z = ctx.zones[sport], steps, title, parts;
    if (sport === "run") {
      title = "Longão · " + hm(min);
      if (racePart) { parts = [part("Z1", min - racePart, "Z1"), part("Z2", racePart, "ritmo de prova")]; steps = [hm(min - racePart) + " a " + z.Z1, "últimos " + Math.round(racePart) + "′ no ritmo de prova (" + ctx.racePace.run + ")", "testar a nutrição da prova"]; }
      else { parts = [part("Z1", min, "Z1")]; steps = [z.Z1 + ", conversando", phase === "base" ? "terreno variado, sem pressa" : "ritmo constante do início ao fim"]; }
    } else if (sport === "bike") {
      title = "Longo · " + hm(min);
      if (racePart) { parts = [part("Z1", min - racePart, "Z1"), part("Z2", racePart, "ritmo de prova")]; steps = [z.Z1 + " a maior parte", Math.round(racePart / 3) + " × " + Math.round(racePart / 3 / 5) * 5 + "′ a " + ctx.racePace.bike + " dentro do longo", "60 a 90 g de carboidrato por hora"]; }
      else { parts = [part("Z1", min, "Z1")]; steps = [z.Z1 + ", cadência 85 a 95 rpm", "comida e bebida como na prova"]; }
    } else {
      title = "Contínuo · " + hm(min);
      parts = [part("Z1", min, "Z1")];
      steps = [Math.round(min * 60 / (ctx.inputs.css + 10) / 100) * 100 + " m contínuos, " + z.Z1, "olhar à frente a cada 6 a 8 braçadas"];
    }
    return session(sport, "long", "Z1", parts, title, steps);
  }

  function easySession(sport, min, ctx, note) {
    var z = ctx.zones[sport], title, steps;
    if (sport === "run") { title = "Rodagem leve · " + hm(min); steps = [z.Z1, note || "6 strides de 20″ no fim"]; }
    else if (sport === "bike") { title = "Endurance · " + hm(min); steps = [z.Z1 + ", cadência 90+", note || "giro solto"]; }
    else { title = "Técnica + aeróbio · " + hm(min); steps = ["educativos de pegada e rotação (20% a 30% da sessão)", "restante contínuo a " + z.Z1]; }
    return session(sport, "easy", "Z1", [part("Z1", min, "Z1")], title, steps);
  }

  function transitionSession(ctx, min, zone, label, title) {
    var z = ctx.zones.run;
    return session("run", "brick", zone, [part(zone, min, "transição")], (title || "Transição") + " · " + min + "′ de corrida",
      [label || (zone === "Z2" ? "logo depois da bike, no ritmo de prova (" + ctx.racePace.run + ")" : "logo depois da bike, " + z.Z1 + ", cadência alta")], { brick: true });
  }

  var STRENGTH = {
    adaptacao: { title: "Força · adaptação", steps: ["agachamento, terra romeno, afundo: 2–3 × 12–15 a 60–70%", "panturrilha e core"], kind: "heavy" },
    forca: { title: "Força máxima de pernas", steps: ["agachamento 4 × 4–5 a 85%", "terra romeno 3 × 5, panturrilha pesada 3 × 6–8", "pausas de 2′ a 3′, 2 a 3 repetições em reserva"], kind: "heavy" },
    potencia: { title: "Potência e pliometria", steps: ["saltos na caixa 4 × 5, saltos unipodais 3 × 8", "agachamento com salto leve 3 × 5", "60 a 100 contatos no total"], kind: "heavy" },
    manutencao: { title: "Força · manutenção", steps: ["2–3 × 3–5 a 85%, uma vez por semana", "core 10′"], kind: "heavy" },
    core: { title: "Core e estabilidade", steps: ["anti-rotação, ponte, Copenhagen", "15′ a 20′, sem fadiga"], kind: "light" }
  };
  function strengthSession(content) {
    var c = STRENGTH[content], min = RULES.strength.minutes[content];
    return session("gym", c.kind, "F", [], c.title, c.steps, { min: min, load: RULES.strength.load[content], zone_min: { Z1: 0, Z2: 0, Z3: 0 }, content: content });
  }

  function testSession(sport, ctx) {
    if (sport === "run") return session("run", "key", "Z3", [part("Z1", 15, "aquecimento"), part("Z3", ctx.kindLong ? 30 : 20, "teste"), part("Z1", 10, "volta à calma")],
      ctx.kindLong ? "Teste · 30′ no máximo sustentável" : "Teste · 5 km no máximo", ["o resultado recalibra o VDOT e as zonas"], { test: true });
    if (sport === "bike") return session("bike", "key", "Z3", [part("Z1", 20, "aquecimento"), part("Z3", 20, "teste"), part("Z1", 15, "volta à calma")],
      "Teste de FTP · 20′", ["5′ forte de abertura, 10′ leves, 20′ no máximo sustentável", "FTP = 95% da média dos 20′"], { test: true });
    return session("swim", "key", "Z3", [part("Z1", 10, "aquecimento"), part("Z3", 12, "teste"), part("Z1", 8, "volta à calma")],
      "Teste de CSS · 400 m + 200 m", ["400 m no máximo, 5′ de pausa, 200 m no máximo", "CSS = (400 − 200) ÷ (t400 − t200)"], { test: true });
  }

  // ------------------------------------------------------------------------
  // Matriz de compatibilidade (mesma lógica do guia)
  // ------------------------------------------------------------------------

  function sessionClass(s) {
    if (s.sport === "gym") return s.kind === "heavy" ? "heavy" : "light";
    if (s.kind === "long") return "long";
    if (s.kind === "key" || s.zone === "Z3" || (s.kind === "brick" && s.zone === "Z2")) return "hard";
    return "easy";
  }
  /** [veredito, motivo] para a 1ª sessão `a` e a 2ª `b` no mesmo dia. */
  function verdict(a, b) {
    var A = sessionClass(a), B = sessionClass(b);
    if (A === "light" || B === "light") return ["ok", "Core e força leve cabem em qualquer dia."];
    if (A === "heavy" && B === "heavy") return ["no", "Duas sessões pesadas de força no mesmo dia."];
    if (A === "heavy") {
      if (b.sport === "swim") return ["ok", "Natação depois da força: pouca interferência."];
      if (B === "easy") return ["ok", "Sessão leve depois da força ajuda a recuperar."];
      return ["no", "Força pesada antes da sessão de endurance tira qualidade e piora a mecânica."];
    }
    if (B === "heavy") {
      if (a.sport === "swim" || A === "easy") return ["ok", "Força depois de uma sessão leve ou de natação."];
      if (A === "hard") return ["mid", "Força depois da sessão intensa, com 6 h ou mais: concentra o estresse no mesmo dia."];
      return ["no", "Força pesada depois de uma sessão longa atrasa a recuperação."];
    }
    if (a.brick || b.brick) return ["ok", "Brick: sessões encadeadas de propósito."];
    if (a.sport === b.sport) {
      if (A === "easy" && B === "easy") return a.sport === "run" ? ["mid", "Corrida dupla só com volume alto."] : ["ok", "Duas sessões leves."];
      if (A === "easy" || B === "easy") return a.sport === "run" ? ["mid", "Duas corridas no dia somam impacto."] : ["ok", "Sessão leve complementa a principal."];
      return ["no", "Duas sessões fortes ou longas da mesma modalidade no mesmo dia."];
    }
    if (a.sport === "bike" && b.sport === "run") {
      if (B === "easy") return ["ok", "Brick leve depois da bike."];
      if (A === "long" && B === "long") return ["no", "Bike longa e corrida longa no mesmo dia."];
      return ["mid", "Corrida forte depois da bike: só como brick planejado."];
    }
    if (A === "easy" || B === "easy") return ["ok", "Sessão leve de outra modalidade não compete com a principal."];
    if (A === "long" && B === "long") return ["no", "Duas sessões longas no mesmo dia."];
    if (A === "long" || B === "long") return a.sport === "swim" || b.sport === "swim" ? ["mid", "Natação forte e sessão longa no mesmo dia: 4 a 6 h entre elas."] : ["no", "Sessão longa e sessão intensa no mesmo dia: uma perde qualidade."];
    return ["mid", "Dia duro: duas sessões intensas de modalidades diferentes, com 4 a 6 h entre elas."];
  }

  // ------------------------------------------------------------------------
  // Entradas
  // ------------------------------------------------------------------------

  function parseInputs(payload) {
    var objKey = plain(payload.objetivo);
    var obj = OBJ[objKey];
    if (!obj) throw new PlanError("Escolha o objetivo: corrida, ciclismo, natação, aquathlon, duathlon ou triathlon.");
    var distKey = String(payload.distancia == null ? "" : payload.distancia).trim();
    var dist = obj.distances[distKey];
    if (!dist) throw new PlanError("Escolha a distância da prova.");
    var sports = obj.legs.filter(function (s, i, a) { return a.indexOf(s) === i; });
    var sharesKey = obj.shares || (dist.kind === "longo" ? "tri_longo" : "tri_curto");

    var manualLevel = blank(payload.nivel) || plain(payload.nivel) === "auto" ? null : plain(payload.nivel);
    if (manualLevel && LEVELS.indexOf(manualLevel) < 0) throw new PlanError("Nível desconhecido: " + payload.nivel + ".");
    var age = parseNumber(payload.idade, "Idade", 10, 100);
    var hoursMax = parseNumber(payload.horas_max, "Horas por semana", 2, 40);
    if (hoursMax == null) throw new PlanError("Informe as horas por semana no pico do plano.");

    var daysIn = Array.isArray(payload.dias) ? payload.dias : blank(payload.dias) ? [0, 1, 2, 3, 4, 5, 6] : String(payload.dias).split(",");
    var days = [];
    daysIn.forEach(function (v) { var d = parseInt(String(v).trim(), 10); if (d >= 0 && d <= 6 && days.indexOf(d) < 0) days.push(d); });
    days.sort(function (a, b) { return a - b; });
    if (days.length < 3) throw new PlanError("Marque pelo menos 3 dias para treinar.");
    var doubles = payload.duplos === true || String(payload.duplos) === "1" || String(payload.duplos) === "true";

    var r = payload.corrida || {}, b = payload.ciclismo || {}, s = payload.natacao || {}, g = payload.forca || {};
    var inputs = {
      run_km: parseNumber(r.km_semana, "Km de corrida por semana", 0, 300), run_longest: parseNumber(r.maior_corrida, "Maior corrida", 0, 100),
      vdot: null, run_recent: null, long_day: blank(r.dia_longo) ? null : parseInt(r.dia_longo, 10),
      bike_hours: parseNumber(b.horas, "Horas de bike por semana", 0, 40), ftp: parseNumber(b.ftp, "FTP", 50, 600), bike_longest: parseNumber(b.maior_pedal, "Maior pedal", 0, 12),
      swim_m: parseNumber(s.metros, "Metros por semana", 0, 60000), css: blank(s.css) ? null : parseTime(s.css, "CSS"),
      strength: g.incluir == null ? true : (g.incluir === true || String(g.incluir) === "1" || String(g.incluir) === "true"),
      strength_base: parseNumber(g.sessoes, "Sessões de força na base", 1, 3) || 2
    };
    if (!blank(r.prova_km) && !blank(r.prova_tempo)) {
      var pk = parseNumber(r.prova_km, "Distância da prova recente", 0.8, 100), pt = parseTime(r.prova_tempo, "Tempo da prova recente");
      inputs.vdot = vdotFromPerformance(pk, pt);
      inputs.run_recent = fmt(pk, pk % 1 ? 1 : 0) + " km em " + formatTime(pt);
    }
    if (inputs.long_day != null && days.indexOf(inputs.long_day) < 0) throw new PlanError("O dia do longão precisa ser um dos dias marcados.");

    var model = blank(payload.modelo) || plain(payload.modelo) === "auto" ? "auto" : plain(payload.modelo);
    if (["auto", "polarizado", "piramidal", "limiar"].indexOf(model) < 0) throw new PlanError("Modelo de intensidade desconhecido: " + payload.modelo + ".");
    var per = blank(payload.periodizacao) || plain(payload.periodizacao) === "auto" ? "auto" : plain(payload.periodizacao).replace(/\s/g, "");
    if (per === "31" || per === "3x1") per = "3:1";
    if (["auto", "3:1", "alternado"].indexOf(per) < 0) throw new PlanError("Periodização desconhecida: " + payload.periodizacao + ".");

    return { objKey: objKey, obj: obj, distKey: distKey, dist: dist, sports: sports, sharesKey: sharesKey, manualLevel: manualLevel, age: age,
      hoursMax: hoursMax, days: days, doubles: doubles, inputs: inputs, model: model, periodization: per,
      tests: payload.testes === true || String(payload.testes) === "1" || String(payload.testes) === "true" };
  }

  function levelFrom(p) {
    if (p.manualLevel) return { level: p.manualLevel, source: "manual", signals: [] };
    var ranks = [], signals = [], inp = p.inputs;
    function add(name, rank) { ranks.push(rank); signals.push(name + " → " + LEVEL_LABEL[LEVELS[rank]].toLowerCase()); }
    if (p.sports.indexOf("run") >= 0 && inp.vdot != null) add("VDOT " + fmt(inp.vdot, 1), inp.vdot >= 63 ? 3 : inp.vdot >= 50 ? 2 : inp.vdot >= 38 ? 1 : 0);
    if (p.sports.indexOf("bike") >= 0 && inp.ftp != null) add("FTP " + inp.ftp + " W", inp.ftp >= 300 ? 3 : inp.ftp >= 240 ? 2 : inp.ftp >= 180 ? 1 : 0);
    if (p.sports.indexOf("swim") >= 0 && inp.css != null) add("CSS " + formatPace(inp.css) + "/100 m", inp.css <= 95 ? 3 : inp.css <= 110 ? 2 : inp.css <= 130 ? 1 : 0);
    var hours = currentHours(p);
    add(fmt(hours, 1) + " h/semana hoje", hours >= 13 ? 3 : hours >= 8 ? 2 : hours >= 4 ? 1 : 0);
    var avg = ranks.reduce(function (a, b) { return a + b; }, 0) / ranks.length;
    return { level: LEVELS[Math.floor(avg + 0.25)], source: "auto", signals: signals };
  }

  // Horas atuais de treino aeróbio, a partir dos volumes informados.
  function currentHours(p) {
    var inp = p.inputs, h = 0;
    if (p.sports.indexOf("run") >= 0 && inp.run_km) h += inp.run_km * (inp.vdot ? paceAt(inp.vdot, 0.66) : 390) / 3600;
    if (p.sports.indexOf("bike") >= 0 && inp.bike_hours) h += inp.bike_hours;
    if (p.sports.indexOf("swim") >= 0 && inp.swim_m) h += inp.swim_m / 100 * ((inp.css || 115) + 10) / 3600;
    return h;
  }

  // ------------------------------------------------------------------------
  // Plano
  // ------------------------------------------------------------------------

  function phaseLayout(total, taper, beginner) {
    var n = total - taper;
    var base = Math.max(1, Math.round(n * (beginner ? RULES.phase_split.base_beginner : RULES.phase_split.base)));
    var spec = Math.max(1, Math.round(n * RULES.phase_split.specific));
    var build = n - base - spec;
    if (build < 1) { build = 1; base = Math.max(1, n - build - spec); if (base + build + spec > n) spec = n - base - build; }
    var out = [];
    for (var i = 0; i < base; i++) out.push("base");
    for (i = 0; i < build; i++) out.push("construcao");
    for (i = 0; i < spec; i++) out.push("especifico");
    for (i = 0; i < taper; i++) out.push("polimento");
    return out;
  }

  // Curva de horas das semanas de treino (sem o polimento), pelo modelo de mesociclo.
  function hoursCurve(model, phases, start, peak, growthMax) {
    var n = phases.length, out = [], level = start, specStart = phases.indexOf("especifico");
    if (specStart < 0) specStart = n;
    if (model === "3:1") {
      var loading = [];
      for (var i = 0; i < specStart; i++) if ((i + 1) % RULES.mesocycle.cycle !== 0) loading.push(i);
      var steps = Math.max(1, loading.length - 1);
      var step = Math.min(growthMax, Math.max(0, Math.pow(peak / Math.max(start, 0.1), 1 / steps) - 1));
      for (i = 0; i < n; i++) {
        var deload = (i + 1) % RULES.mesocycle.cycle === 0 && i !== n - 1 && phases[i] !== "especifico";
        if (deload) { out.push({ hours: level * RULES.mesocycle.deload, kind: "alivio" }); continue; }
        if (i > 0 && i < specStart) level = Math.min(peak, level * (1 + step));
        if (i >= specStart) level = Math.max(level, Math.min(peak, level));
        out.push({ hours: level, kind: i === 0 ? "inicio" : level >= peak - 1e-9 ? "pico" : "carga" });
      }
      return out;
    }
    var high = level, inc = RULES.mesocycle.alternate_growth;
    for (var j = 0; j < n; j++) {
      var pos = j % 4;
      if (pos === 0 && j > 0) level = high;
      if (pos === 1) high = Math.min(peak, level * (1 + Math.min(inc, growthMax)));
      if (pos === 0) out.push({ hours: level, kind: j === 0 ? "inicio" : level >= peak - 1e-9 ? "pico" : "patamar" });
      else if (pos === 2) out.push({ hours: level, kind: level >= peak - 1e-9 ? "pico" : "regenerativa" });
      else out.push({ hours: high, kind: high >= peak - 1e-9 ? "pico" : "acrescimo" });
    }
    return out;
  }

  function planFromPayload(payload, options) {
    options = options || {};
    var p = parseInputs(payload), inp = p.inputs, obj = p.obj, dist = p.dist;
    var warnings = [], reasons = [], notes = [];
    var lv = levelFrom(p), level = lv.level, li = LEVELS.indexOf(level);
    var kindLong = dist.kind === "longo";

    // --- Calendário ---------------------------------------------------------
    var today = options.today ? parseIsoDate(options.today) : todayLocal();
    var start = blank(payload.inicio) ? today + mod(7 - weekday(today), 7) : parseIsoDate(payload.inicio);
    if (start == null) throw new PlanError("Data de início inválida.");
    if (start < today) throw new PlanError("O início precisa ser hoje ou depois.");
    var monday = start - weekday(start);
    var byDate = !blank(payload.data_prova), total, raceDay;
    if (byDate) {
      raceDay = parseIsoDate(payload.data_prova);
      if (raceDay == null) throw new PlanError("Data da prova inválida.");
      if (raceDay < start) throw new PlanError("A prova precisa ser depois do início do plano.");
      total = Math.floor((raceDay - monday) / 7) + 1;
      if (total > 52) throw new PlanError("A prova está a mais de 52 semanas.");
    } else {
      total = parseNumber(payload.semanas, "Duração do plano", 2, 52);
      if (total == null) total = Math.max(dist.min_weeks, kindLong ? 16 : 12);
      if (total !== Math.floor(total)) throw new PlanError("A duração deve ser um número inteiro de semanas.");
      raceDay = monday + (total - 1) * 7 + 6;
    }
    if (total < dist.min_weeks) {
      throw new PlanError((byDate ? "Faltam " + total + " semanas até a prova; " : "") + "para " + dist.name + " o plano precisa de pelo menos " + dist.min_weeks + " semanas" +
        (byDate ? ". Escolha uma prova mais distante." : ". Aumente a duração."));
    }
    var taper = dist.taper;
    if (total < 10 && taper > 1) taper = Math.max(1, taper - 1);
    if (p.objKey === "triathlon" && p.distKey === "ironman" && total < 16) taper = 2;
    var phases = phaseLayout(total, taper, level === "iniciante");
    var raceWd = weekday(raceDay);

    // --- Modelo e periodização ------------------------------------------------
    var sessionsPerSport = {};
    p.sports.forEach(function (s) { sessionsPerSport[s] = RULES.sessions[p.sharesKey][s][li]; });
    var aerobicSessions = p.sports.reduce(function (a, s) { return a + sessionsPerSport[s]; }, 0);
    var modelByPhase = PHASES.map(function (ph) {
      if (p.model !== "auto") return p.model;
      if (p.hoursMax < RULES.model_auto.threshold_max_hours && aerobicSessions <= RULES.model_auto.threshold_max_sessions) return "limiar";
      if ((ph === "especifico" || ph === "polimento") && kindLong) return "piramidal";
      return "polarizado";
    });
    var per = p.periodization === "auto" ? (p.age != null && p.age >= RULES.mesocycle.alternate_min_age ? "alternado" : "3:1") : p.periodization;
    var growthMax = level === "iniciante" ? RULES.mesocycle.growth_beginner : RULES.mesocycle.growth_max;

    // --- Horas: início, pico, curva ---------------------------------------------
    // A curva é de horas totais (força incluída): o teto informado vale para a semana inteira.
    var nowHours = currentHours(p);
    var strengthMinBase = inp.strength ? inp.strength_base * RULES.strength.minutes.forca : 0;
    var peakTotal = p.hoursMax * 60;
    var startTotal = clamp(nowHours * 60 + strengthMinBase, peakTotal * 0.55, peakTotal);
    if (nowHours * 60 + strengthMinBase > peakTotal + 1e-9) warnings.push({ level: "warn", text: "Você já treina cerca de " + fmt(nowHours, 1) + " h por semana" + (strengthMinBase ? " mais a força" : "") + ", mais que o teto de " + fmt(p.hoursMax, 1) + " h. O plano fica no teto desde a primeira semana." });
    if (nowHours * 60 + strengthMinBase < peakTotal * 0.55) warnings.push({ level: "warn", text: "Você treina hoje cerca de " + fmt(nowHours, 1) + " h por semana; o plano começa em " + fmt(startTotal / 60, 1) + " h (55% do teto) e sobe até " + fmt(p.hoursMax, 1) + " h. Se for muito, reduza as horas no pico." });
    var trainPhases = phases.filter(function (ph) { return ph !== "polimento"; });
    var curve = hoursCurve(per, trainPhases, startTotal, peakTotal, growthMax);
    var startAerobic = startTotal - strengthMinBase;
    var peakReached = curve.reduce(function (a, w) { return Math.max(a, w.hours); }, 0);
    var tf = RULES.taper_fractions[taper];
    var weekHours = curve.map(function (w) { return w.hours; }).concat(tf.map(function (f) { return peakReached * f; }));
    var weekKind = curve.map(function (w) { return w.kind; }).concat(tf.map(function () { return "polimento"; }));
    if (peakReached < peakTotal - 1) warnings.push({ level: "warn", text: "Com o modelo " + per + " e aumento de até " + Math.round(growthMax * 100) + "% por semana, o plano chega a " + fmt(peakReached / 60, 1) + " h e não ao teto de " + fmt(p.hoursMax, 1) + " h antes do específico." });

    // --- Zonas e ritmos -------------------------------------------------------------
    var vdot = inp.vdot != null ? inp.vdot : DEFAULT_VDOT[level];
    var ftp = inp.ftp != null ? inp.ftp : DEFAULT_FTP[level];
    var css = inp.css != null ? inp.css : DEFAULT_CSS[level];
    var zones = { run: runZones(vdot), bike: bikeZones(ftp), swim: swimZones(css) };
    var racePace = {}, raceTime = {}, totalRace = 0;
    if (p.sports.indexOf("run") >= 0) {
      var runKm = dist.run, slow = p.objKey === "corrida" ? 1 : MULTI_RUN_SLOWDOWN[p.objKey === "triathlon" ? p.distKey : p.objKey];
      var legs = dist.run2 ? [dist.run, dist.run2] : [dist.run];
      var secs = legs.reduce(function (a, k) { return a + predictTimeS(vdot, k) * slow; }, 0);
      racePace.run = formatPace(secs / legs.reduce(function (a, k) { return a + k; }, 0)) + "/km";
      raceTime.run = secs; totalRace += secs;
      racePace.run_desc = legs.length > 1 ? "duas corridas" : fmt(runKm, runKm % 1 ? 1 : 0) + " km";
    }
    if (p.sports.indexOf("bike") >= 0) {
      var bint = RACE_INTENSITY.bike[p.objKey === "ciclismo" ? p.distKey : p.objKey === "duathlon" ? "padrao" : p.distKey] || 0.85;
      if (p.objKey === "duathlon") bint = p.distKey === "sprint" ? 0.93 : 0.9;
      var watts = Math.round(ftp * bint);
      racePace.bike = Math.round(ftp * (bint - 0.03)) + "–" + Math.round(ftp * (bint + 0.02)) + " W (" + Math.round(bint * 100) + "% do FTP)";
      var bikeS = dist.bike / bikeSpeed(watts) * 3600;
      raceTime.bike = bikeS; totalRace += bikeS;
    }
    if (p.sports.indexOf("swim") >= 0) {
      var sint = RACE_INTENSITY.swim[dist.swim] || 0.96;
      var sPace = css / sint;
      racePace.swim = formatPace(sPace) + "/100 m";
      var swimS = dist.swim / 100 * sPace;
      raceTime.swim = swimS; totalRace += swimS;
    }
    if (p.sports.length > 1) totalRace += (TRANSITIONS_MIN[p.objKey === "triathlon" ? p.distKey : p.objKey] || 3) * 60;

    var ctx = { zones: zones, inputs: { ftp: ftp, css: css, vdot: vdot }, racePace: racePace, kindLong: kindLong };

    // --- Dias: longão, longo de bike --------------------------------------------------
    var days = p.days;
    var runLongDay = inp.long_day != null ? inp.long_day : days.indexOf(6) >= 0 ? 6 : days.indexOf(5) >= 0 ? 5 : days[days.length - 1];
    var bikeLongDay = null;
    if (p.sports.indexOf("bike") >= 0) {
      var cands = days.filter(function (d) { return d !== runLongDay || p.sports.indexOf("run") < 0; });
      bikeLongDay = cands.indexOf(mod(runLongDay - 1, 7)) >= 0 && p.sports.indexOf("run") >= 0 ? mod(runLongDay - 1, 7) : cands.indexOf(5) >= 0 ? 5 : cands.indexOf(6) >= 0 ? 6 : cands[cands.length - 1];
    }

    // --- Semanas -------------------------------------------------------------------------
    var weeks = [], prevRunKm = inp.run_km != null && inp.run_km > 0 ? inp.run_km : null, runKmFloorNote = false;
    var strengthWeek = 0;
    var testWeeks = [];
    if (p.tests) {
      for (var ti = 1; ti < phases.length; ti++) if (phases[ti] !== phases[ti - 1] && phases[ti - 1] !== "especifico" && weekKind[ti - 1] === "alivio") testWeeks.push(ti - 1);
      if (!testWeeks.length) for (ti = 1; ti < phases.length; ti++) if (phases[ti] !== phases[ti - 1] && phases[ti] !== "polimento") testWeeks.push(ti - 1);
    }

    for (var w = 0; w < total; w++) {
      var phase = phases[w], pi = PHASES.indexOf(phase), model = modelByPhase[pi], dist3 = RULES.models[model][pi];
      var isRace = w === total - 1, isTaper = phase === "polimento", kind = weekKind[w];
      var wk = { number: w + 1, phase: phase, phase_label: PHASE_LABEL[phase], kind: kind, model: model, start_date: isoDate(monday + w * 7), is_race: isRace,
        deload: kind === "alivio" || kind === "regenerativa", sessions: [], conflicts: [], reasons: [], test: testWeeks.indexOf(w) >= 0 };
      var hoursMin = weekHours[w];
      var shares = RULES.shares[p.sharesKey];

      // Força: sessões e conteúdo desta semana.
      var strengthSessions = [];
      if (inp.strength) {
        var daysToRace = raceDay - (monday + w * 7);
        var count, content;
        if (phase === "base") { count = inp.strength_base; content = w < RULES.strength.adaptation_weeks ? "adaptacao" : "forca"; }
        else if (phase === "construcao") { var bIdx = phases.indexOf("construcao"), bLen = phases.lastIndexOf("construcao") - bIdx + 1; count = Math.min(RULES.strength.build, p.doubles || days.length >= 6 ? 2 : 1); content = w - bIdx < bLen / 2 ? "forca" : "potencia"; }
        else if (phase === "especifico") { count = RULES.strength.specific; content = "manutencao"; }
        else { count = 1; content = "core"; }
        if (daysToRace <= RULES.strength.last_heavy_days + 6 && content !== "core") { content = "core"; count = 1; }
        if (isRace) count = 0;
        if (wk.deload && count > 1) count -= 1;
        for (var si = 0; si < count; si++) strengthSessions.push(strengthSession(content));
        if (count && si) strengthWeek++;
      }
      var strengthMin = strengthSessions.reduce(function (a, s) { return a + s.min; }, 0);
      var aeroMin = Math.max(60, hoursMin - strengthMin);
      if (isRace) aeroMin = Math.min(aeroMin, Math.max(RULES.race_week_min, peakReached * RULES.race_week_frac));

      // Minutos por modalidade e sessões.
      var sportMin = {}, sportSessions = {};
      p.sports.forEach(function (s) {
        var share = shares[s][pi];
        if (s === "run" && RULES.run_share_cap[p.sharesKey]) share = Math.min(share, RULES.run_share_cap[p.sharesKey]);
        sportMin[s] = aeroMin * share;
      });
      // Teto de impacto: km de corrida crescem no máximo 10% por semana (semanas de carga).
      wk.run_km = null;
      if (p.sports.indexOf("run") >= 0) {
        var z1pace = (zones.run.E[0] + zones.run.E[1]) / 2;
        var kmPlan = sportMin.run * 60 / z1pace;
        if (prevRunKm != null && !wk.deload && !isTaper && kmPlan > prevRunKm * (1 + RULES.run.km_growth) + 1e-9) {
          var kmCap = prevRunKm * (1 + RULES.run.km_growth);
          var cut = sportMin.run - kmCap * z1pace / 60;
          sportMin.run -= cut;
          if (p.sports.indexOf("bike") >= 0) { sportMin.bike += cut; wk.reasons.push({ code: "impacto", text: "Teto de impacto: corrida limitada a " + fmt(kmCap, 0) + " km (+10% sobre " + fmt(prevRunKm, 0) + "); " + Math.round(cut) + "′ foram para a bike." }); }
          else { wk.reasons.push({ code: "impacto", text: "Teto de impacto: corrida limitada a " + fmt(kmCap, 0) + " km (+10% sobre a semana anterior); a semana fica " + Math.round(cut) + "′ abaixo das horas da curva." }); runKmFloorNote = true; }
          kmPlan = kmCap;
        }
        wk.run_km = round1(kmPlan);
        if (!wk.deload && !isTaper) prevRunKm = kmPlan;
      }

      // Capacidade de dias.
      var usableDays = days.filter(function (d) { return monday + w * 7 + d >= start; });
      if (isRace) usableDays = usableDays.filter(function (d) { return d <= raceWd; });
      var slots = usableDays.length * (p.doubles ? 2 : 1);
      var wanted = {};
      p.sports.forEach(function (s) {
        var base = sessionsPerSport[s], byHours = Math.round(sportMin[s] / RULES.avg_session[s][li]);
        wanted[s] = clamp(byHours, base, base + RULES.extra_sessions);
        if (isRace) wanted[s] = Math.min(wanted[s], kindLong ? 3 : 2);
      });
      var totalWanted = p.sports.reduce(function (a, s) { return a + wanted[s]; }, 0);
      while (totalWanted > slots) {
        var big = p.sports.slice().sort(function (a, b) { return wanted[b] - wanted[a]; })[0];
        if (wanted[big] <= 2) break;
        wanted[big]--; totalWanted--;
      }
      var freeSlots = Math.max(0, slots - totalWanted);
      if (isTaper && !isRace) p.sports.forEach(function (s) { if (wanted[s] > 3) wanted[s]--; });

      // Monta as sessões de cada modalidade.
      p.sports.forEach(function (s) {
        var minutes = sportMin[s], n = wanted[s], list = [];
        var z2 = minutes * dist3[1] / 100, z3 = minutes * dist3[2] / 100;
        if (isTaper) { z2 *= RULES.taper_key_work; z3 *= RULES.taper_key_work; }
        var longMax = dist.long_max[s] || 90, longMin = RULES.long.min[s];
        var longMinutes = 0;
        var longFrac = p.sports.length > 1 ? (kindLong ? RULES.long.frac_long_multi : RULES.long.frac_multi)[s] : RULES.long.frac[s];
        if (n >= 2 && minutes >= longMin * 2.2) {
          longMinutes = clamp(minutes * longFrac, longMin, longMax);
          if (wk.deload) longMinutes *= 0.8;
          if (isTaper) longMinutes = Math.min(longMinutes, longMax * (isRace ? 0.45 : 0.65));
        }
        var racePart = 0;
        if (phase === "especifico" && longMinutes && (s === "run" || s === "bike") && (kindLong || p.sports.length > 1)) {
          racePart = Math.min(z2, longMinutes * (s === "run" ? 0.35 : 0.4));
          z2 -= racePart;
        }
        var keyBudget = n - (longMinutes ? 1 : 0) - 1; // deixa ao menos uma sessão leve
        if (n <= 2) keyBudget = longMinutes ? 1 : n;
        var keys = [];
        var capZ3 = RULES.work_cap[s].Z3, capZ2 = RULES.work_cap[s].Z2;
        var order = z2 > z3 * 1.5 ? ["Z2", "Z3"] : ["Z3", "Z2"]; // com um só espaço, a zona com mais trabalho
        order.forEach(function (zn) {
          var wz = zn === "Z3" ? z3 : z2;
          if (wz >= RULES.work_min[zn] && keyBudget > 0) { keys.push(keySession(s, zn, Math.min(wz, zn === "Z3" ? capZ3 : capZ2), phase, ctx)); keyBudget--; }
        });
        if (wk.test && p.sports.length <= 3) {
          var tIdx = keys.findIndex(function (k) { return k.zone === "Z3"; });
          var t = testSession(s, ctx);
          if (tIdx >= 0) keys[tIdx] = t; else if (keys.length) keys[0] = t; else keys.push(t);
        }
        if (isRace) keys = keys.slice(0, 1).map(function (k) {
          return session(s, "key", "Z2", [part("Z1", 12, "aquecimento"), part("Z2", 6, "abertura"), part("Z1", 7, "volta")], "Abertura · 4 × 90″ no ritmo de prova", ["4 × 90″ no ritmo de prova, 90″ leves", "só para lembrar o ritmo"]);
        });
        if (isRace) longMinutes = 0;
        var used = longMinutes + keys.reduce(function (a, k) { return a + k.min; }, 0);
        var easyCount = n - (longMinutes ? 1 : 0) - keys.length;
        var easyMin = minutes - used;
        var easyMax = isRace ? (kindLong ? 50 : 35) : RULES.easy_min[s] + (RULES.easy_max[s] - RULES.easy_min[s]) * (isTaper ? 0.6 : 1);
        var easyEach = easyCount > 0 ? easyMin / easyCount : 0;
        // Se a leve planejada não cabe, a sessão-chave encolhe (até o trabalho mínimo) para abrir espaço.
        if (easyCount > 0 && easyEach < RULES.easy_min[s] && keys.length && !isRace) {
          var k0 = keys[0], wp = k0.parts.filter(function (x) { return x.label === "trabalho"; })[0];
          var need = RULES.easy_min[s] * Math.max(1, easyCount) - easyMin;
          if (wp && wp.min - need >= RULES.work_min[k0.zone]) {
            keys[0] = keySession(s, k0.zone, wp.min - need, phase, ctx);
            used = longMinutes + keys.reduce(function (a, k) { return a + k.min; }, 0);
            easyMin = minutes - used; easyEach = easyMin / easyCount;
          }
        }
        while (easyCount > 0 && easyEach < RULES.easy_min[s]) { easyCount--; easyEach = easyCount ? easyMin / easyCount : 0; }
        // Sobra: primeiro cresce a sessão longa até o teto, depois mais uma leve, e o que ainda sobrar fica de fora.
        var leftover = Math.max(0, easyMin - easyCount * easyMax);
        if (easyCount <= 0) leftover = Math.max(0, easyMin);
        if (leftover > 0 && longMinutes && longMinutes < longMax) { var grow = Math.min(leftover, longMax - longMinutes); longMinutes += grow; leftover -= grow; }
        if (leftover > RULES.easy_min[s] && freeSlots > 0 && !isRace) { easyCount++; n++; freeSlots--; leftover = Math.max(0, leftover - easyMax); }
        if (easyCount > 0) easyEach = Math.min(easyMax, (minutes - longMinutes - keys.reduce(function (a, k) { return a + k.min; }, 0)) / easyCount);
        // A sessão longa nunca fica menor que uma leve.
        if (longMinutes && easyCount > 0 && easyEach > longMinutes) { longMinutes = Math.min(longMax, easyEach + 5); easyEach = Math.min(easyMax, (minutes - longMinutes - keys.reduce(function (a, k) { return a + k.min; }, 0)) / easyCount); }
        // Sobra pequena vai para a volta à calma da sessão-chave.
        if (leftover > 0 && leftover <= RULES.easy_min[s] && keys.length) { keys[0].parts[keys[0].parts.length - 1].min += Math.round(leftover); keys[0] = session(s, "key", keys[0].zone, keys[0].parts, keys[0].title, keys[0].steps, keys[0].test ? { test: true } : null); leftover = 0; }
        if (leftover > 10 && !isRace) wk.reasons.push({ code: "sessoes", text: SPORT[s].name + ": " + Math.round(leftover) + "′ ficaram fora da semana, porque as sessões já estão no tamanho máximo. Mais dias ou dois treinos por dia absorvem esse tempo." });
        var longS = longMinutes ? longSession(s, longMinutes, phase, ctx, racePart) : null;
        if (longS) list.push(longS);
        keys.forEach(function (k) { list.push(k); });
        for (var e = 0; e < easyCount; e++) list.push(easySession(s, Math.round(easyEach / 5) * 5, ctx, s === "run" && z2 < RULES.work_min.Z2 && z2 > 3 && e === 0 ? "com 8 strides de 20″ (" + zones.run.Z3 + ")" : null));
        sportSessions[s] = list;
      });

      // Bricks e transições (o tempo da corrida de transição sai do orçamento da corrida).
      var bricks = [];
      if (p.sports.length > 1 && (phase === "construcao" || phase === "especifico" || isTaper) && !isRace) {
        var tMin = phase === "especifico" ? RULES.bricks.transition_specific : RULES.bricks.transition_build;
        if (p.objKey === "triathlon" || p.objKey === "duathlon") {
          var bikeKey = sportSessions.bike.filter(function (x) { return x.kind === "key"; })[0];
          var bikeLong = sportSessions.bike.filter(function (x) { return x.kind === "long"; })[0];
          if (kindLong && bikeLong) {
            var tl = phase === "especifico" ? RULES.bricks.transition_long_specific : RULES.bricks.transition_long;
            bricks.push([bikeLong, transitionSession(ctx, tl, phase === "especifico" ? "Z2" : "Z1")]);
          } else if (bikeKey) {
            bricks.push([bikeKey, transitionSession(ctx, tMin, "Z2")]);
            if (phase === "especifico" && bikeLong && p.objKey === "triathlon") bricks.push([bikeLong, transitionSession(ctx, tMin, "Z1")]);
          }
          if (p.objKey === "duathlon" && phase === "especifico" && bikeKey && (w % 2 === 0)) {
            bikeKey.title = "C–B–C · " + bikeKey.title.replace(/^.*· /, "");
            bikeKey.steps.unshift("antes: 15′ de corrida no ritmo de prova");
            bikeKey.parts.unshift(part("Z2", 0, ""));
            bricks[0] = [transitionSession(ctx, 15, "Z2", "15′ no ritmo de prova, direto para a bike", "Corrida inicial"), bikeKey, transitionSession(ctx, 15, "Z2")];
          }
        } else if (p.objKey === "aquathlon") {
          var swimKey = sportSessions.swim.filter(function (x) { return x.kind === "key"; })[0];
          if (swimKey) bricks.push([swimKey, transitionSession(ctx, tMin, "Z2", "saindo da água direto para a corrida, no ritmo de prova (" + racePace.run + ")")]);
        }
        // O tempo das transições sai de uma rodagem leve de corrida.
        var tMinTotal = bricks.reduce(function (a, b) { return a + b.filter(function (x) { return x.brick; }).reduce(function (c, x) { return c + x.min; }, 0); }, 0);
        if (tMinTotal) {
          var easies = sportSessions.run.filter(function (x) { return x.kind === "easy"; });
          if (easies.length) {
            var e0 = easies[easies.length - 1];
            if (e0.min - tMinTotal >= RULES.easy_min.run) { var ne = easySession("run", Math.round((e0.min - tMinTotal) / 5) * 5, ctx); sportSessions.run[sportSessions.run.indexOf(e0)] = ne; }
            else sportSessions.run.splice(sportSessions.run.indexOf(e0), 1);
          }
        }
      }

      // Todas as sessões da semana.
      var all = [];
      p.sports.forEach(function (s) { sportSessions[s].forEach(function (x) { all.push(x); }); });
      bricks.forEach(function (b) { b.forEach(function (x) { if (all.indexOf(x) < 0) all.push(x); }); });
      strengthSessions.forEach(function (x) { all.push(x); });
      if (isRace) all.push(session(obj.main, "race", kindLong ? "Z2" : "Z3", [part(kindLong ? "Z2" : "Z3", Math.round(totalRace / 60), "prova")], "PROVA · " + obj.name + " " + dist.name, ["a prova-alvo"], { race: true }));

      // --- Encaixe nos dias ----------------------------------------------------------------
      var dayList = [];
      for (var d = 0; d < 7; d++) dayList.push({ day: d, date: isoDate(monday + w * 7 + d), items: [], usable: usableDays.indexOf(d) >= 0 });
      var placedSessions = [];
      function at(d) { return dayList[mod(d, 7)].items; }
      function has(d, pred) { return at(d).some(pred); }
      function hardOrLong(x) { var c = sessionClass(x); return c === "hard" || c === "long"; }
      function penalty(d, s, forcedPair) {
        var items = at(d), day = dayList[d];
        if (!day.usable) return 9999;
        var cls = sessionClass(s), score = 0;
        var aerobic = items.filter(function (x) { return x.sport !== "gym"; }).length;
        if (s.sport !== "gym" && !forcedPair && aerobic >= (p.doubles ? 2 : 1)) return 9999;
        if (s.sport === "gym" && items.filter(function (x) { return x.sport === "gym"; }).length) return 9999;
        if (items.length >= 3) return 9999;
        if (isRace) {
          if (d === raceWd) return 9999;
          if (d === raceWd - 1 && cls !== "easy") score += 200;
          if (d === raceWd - 2 && (cls === "long" || cls === "heavy")) score += 200;
        }
        items.forEach(function (x) {
          var v = verdict(x, s)[0];
          if (v === "no") score += 120;
          if (v === "mid") score += 6;
          if (x.sport === s.sport && s.sport !== "gym") score += 25;
        });
        if (cls === "hard" || cls === "long") {
          [-1, 1].forEach(function (off) {
            if (has(d + off, function (x) { return x.sport === s.sport && hardOrLong(x); })) score += 40;
            if (has(d + off, function (x) { return hardOrLong(x) && x.sport !== s.sport; })) score += 8;
          });
          if (s.sport === "run" && has(d - 1, function (x) { return x.sport === "run" && x.kind === "long"; })) score += 30;
          if (s.sport === "run" && has(d - 1, function (x) { return x.sport === "gym" && x.kind === "heavy"; })) score += 80;
          if (s.sport === "bike" && has(d - 1, function (x) { return x.sport === "gym" && x.kind === "heavy"; })) score += 40;
          if (cls === "hard" && has(d - 1, function (x) { return x.sport === "bike" && x.kind === "long"; }) && s.sport === "run") score += 20;
          if (cls === "hard" && items.some(function (x) { return sessionClass(x) === "hard"; }) && p.doubles) score -= 4;
          if (items.length === 0) score -= 2;
        }
        if (cls === "heavy") {
          if (has(d + 1, function (x) { return x.sport === "run" && hardOrLong(x); })) score += 80;
          if (has(d + 2, function (x) { return x.sport === "run" && x.kind === "long"; })) score += 20;
          if (has(d + 1, function (x) { return x.sport === "bike" && hardOrLong(x); })) score += 40;
          if (has(d - 1, function (x) { return x.sport === "gym" && x.kind === "heavy"; }) || has(d + 1, function (x) { return x.sport === "gym" && x.kind === "heavy"; })) score += 30;
          if (items.some(function (x) { return sessionClass(x) === "hard" && x.sport !== "swim"; })) score -= 6;
          if (items.length === 0) score += 3;
        }
        if (cls === "easy") {
          if (items.length === 0) score -= 10;
          if (has(d + 1, function (x) { return x.sport === s.sport && x.kind === "long"; }) && s.sport === "run") score += 4;
        }
        if (cls === "light" && items.some(function (x) { return x.sport === "gym"; })) score += 50;
        return score;
      }
      function place(s, d) { at(d).push(s); s.day = d; placedSessions.push(s); }
      function best(s, cands, forcedPair) {
        var pick = null, low = Infinity;
        cands.forEach(function (d) { var v = penalty(d, s, forcedPair); if (v < low) { low = v; pick = d; } });
        return { day: pick, score: low };
      }
      var allDays = [0, 1, 2, 3, 4, 5, 6];
      // 1. Prova.
      all.filter(function (x) { return x.race; }).forEach(function (x) { at(raceWd).push(x); x.day = raceWd; placedSessions.push(x); });
      // 2. Sessões longas: corrida no dia do longão, bike no dia do longo; natação pelo custo.
      var longs = all.filter(function (x) { return x.kind === "long" && !x.day; });
      longs.filter(function (x) { return x.sport === "run"; }).forEach(function (x) {
        var d = dayList[runLongDay].usable && !isRace ? runLongDay : best(x, allDays).day;
        if (isRace) d = best(x, allDays).day;
        if (d != null && d !== undefined) place(x, d);
      });
      longs.filter(function (x) { return x.sport === "bike"; }).forEach(function (x) {
        var d = bikeLongDay != null && dayList[bikeLongDay].usable && penalty(bikeLongDay, x) < 100 ? bikeLongDay : best(x, allDays).day;
        if (d != null) place(x, d);
      });
      longs.filter(function (x) { return x.sport === "swim"; }).forEach(function (x) { var b = best(x, allDays); if (b.score < 9999) place(x, b.day); });
      // 3. Bricks: a transição vai para o dia da sessão de bike (ou natação) que a precede.
      bricks.forEach(function (b) {
        var anchor = b.filter(function (x) { return !x.brick; })[0];
        if (!anchor.day && anchor.day !== 0) { var ba = best(anchor, allDays); if (ba.score >= 9999) return; place(anchor, ba.day); }
        b.forEach(function (x) { if (x.brick && x.day == null) { at(anchor.day).push(x); x.day = anchor.day; placedSessions.push(x); } });
        b.brick_id = w + "-" + anchor.day;
        b.forEach(function (x, i) { x.brick_id = b.brick_id; x.brick_pos = i; });
      });
      // 4. Sessões-chave, modalidade principal primeiro.
      var mainSport = obj.main;
      var keysAll = all.filter(function (x) { return x.kind === "key" && x.day == null; }).sort(function (a, b) {
        return (a.sport === mainSport ? 0 : 1) - (b.sport === mainSport ? 0 : 1) || (a.zone === "Z3" ? 0 : 1) - (b.zone === "Z3" ? 0 : 1);
      });
      keysAll.forEach(function (x) { var b = best(x, allDays); if (b.score < 9999) place(x, b.day); else x.dropped = true; });
      // 5. Força pesada, 6. leves, 7. core.
      all.filter(function (x) { return x.sport === "gym" && x.kind === "heavy"; }).forEach(function (x) { var b = best(x, allDays); if (b.score < 9999) place(x, b.day); else x.dropped = true; });
      all.filter(function (x) { return x.kind === "easy" && x.day == null; }).forEach(function (x) { var b = best(x, allDays); if (b.score < 9999) place(x, b.day); else x.dropped = true; });
      all.filter(function (x) { return x.sport === "gym" && x.kind === "light"; }).forEach(function (x) { var b = best(x, allDays); if (b.score < 9999) place(x, b.day); else x.dropped = true; });
      // Soltura na véspera, mesmo que não seja um dia habitual de treino: são 20 minutos.
      if (isRace && raceWd > 0 && !at(raceWd - 1).length) {
        var ms = obj.main;
        place(session(ms, "easy", "Z1", [part("Z1", 16, "Z1"), part("Z2", 4, "acelerações")], "Soltura · 20′", ["15′ bem leves + 4 × 30″ no ritmo de prova", "só para soltar as pernas"]), raceWd - 1);
      }
      var dropped = all.filter(function (x) { return x.dropped; });
      if (dropped.length) wk.reasons.push({ code: "dias", text: "Sem dia para " + joinList(dropped.map(function (x) { return x.title.toLowerCase(); })) + ": " + (p.doubles ? "faltam dias livres." : "marque mais dias ou permita dois treinos no mesmo dia.") });

      // Ordem dentro do dia e conflitos.
      var ORDER = { hard: 0, long: 0, easy: 2, heavy: 3, light: 4 };
      dayList.forEach(function (day) {
        day.items.sort(function (a, b) {
          if (a.brick_id && a.brick_id === b.brick_id) return a.brick_pos - b.brick_pos;
          return ORDER[sessionClass(a)] - ORDER[sessionClass(b)];
        });
        for (var i = 0; i + 1 < day.items.length; i++) {
          var v = verdict(day.items[i], day.items[i + 1]);
          if (v[0] === "no") wk.conflicts.push({ day: day.day, text: day.items[i].title + " + " + day.items[i + 1].title + ": " + v[1] });
          else if (v[0] === "mid" && !(day.items[i].brick_id && day.items[i].brick_id === day.items[i + 1].brick_id)) day.items[i + 1].note = v[1];
        }
      });
      for (var dd = 1; dd < 7; dd++) {
        var prev = dayList[dd - 1].items, cur = dayList[dd].items;
        if (prev.some(function (x) { return x.sport === "gym" && x.kind === "heavy"; }) && cur.some(function (x) { return x.sport === "run" && hardOrLong(x); }))
          wk.conflicts.push({ day: dd, text: "Força pesada na véspera de " + cur.filter(function (x) { return x.sport === "run" && hardOrLong(x); })[0].title.toLowerCase() + ": o método pede 48 h." });
        if (prev.some(function (x) { return x.sport === "run" && x.kind === "long"; }) && cur.some(function (x) { return x.sport === "run" && sessionClass(x) === "hard"; }))
          wk.conflicts.push({ day: dd, text: "Corrida intensa no dia seguinte ao longão: o método pede 48 a 72 h." });
      }

      // Totais.
      var minutesBy = {}, loadBy = {}, zoneMin = { Z1: 0, Z2: 0, Z3: 0 };
      placedSessions.forEach(function (x) {
        minutesBy[x.sport] = (minutesBy[x.sport] || 0) + x.min;
        loadBy[x.sport] = (loadBy[x.sport] || 0) + x.load;
        if (x.zone_min && !x.race) { zoneMin.Z1 += x.zone_min.Z1; zoneMin.Z2 += x.zone_min.Z2; zoneMin.Z3 += x.zone_min.Z3; }
      });
      var aero = zoneMin.Z1 + zoneMin.Z2 + zoneMin.Z3;
      wk.days = dayList.map(function (day) { return { day: day.day, date: day.date, items: day.items.map(function (x) { var o = {}; Object.keys(x).forEach(function (k) { if (k !== "day") o[k] = x[k]; }); return o; }) }; });
      wk.minutes = minutesBy;
      wk.minutes_total = placedSessions.reduce(function (a, x) { return a + x.min; }, 0);
      wk.load = placedSessions.reduce(function (a, x) { return a + x.load; }, 0);
      wk.load_by = loadBy;
      wk.zone_pct = aero ? [zoneMin.Z1 / aero * 100, zoneMin.Z2 / aero * 100, zoneMin.Z3 / aero * 100] : [0, 0, 0];
      wk.target_pct = dist3;
      wk.hours_target = hoursMin / 60;
      wk.strength_content = strengthSessions.length ? strengthSessions[0].content : null;
      wk.reasons.unshift({ code: "volume", text: ({
        inicio: "Início: " + fmt(hoursMin / 60, 1) + " h na semana (força incluída), o seu volume atual.",
        carga: "Semana de carga (" + per + "): " + fmt(hoursMin / 60, 1) + " h, até " + Math.round(growthMax * 100) + "% acima da anterior.",
        pico: "Volume do pico: " + fmt(hoursMin / 60, 1) + " h, o teto informado (força incluída).",
        alivio: "Alívio do mesociclo: 70% do volume (" + fmt(hoursMin / 60, 1) + " h), sessões-chave mantidas e mais curtas.",
        patamar: "Novo patamar (alternado): " + fmt(hoursMin / 60, 1) + " h.", acrescimo: "Acréscimo (alternado): " + fmt(hoursMin / 60, 1) + " h, até 10% a mais.",
        regenerativa: "Regenerativa (alternado): volta ao patamar, " + fmt(hoursMin / 60, 1) + " h.",
        polimento: "Polimento: " + Math.round(tf[w - trainPhases.length] * 100) + "% do pico (" + fmt(hoursMin / 60, 1) + " h), intensidade e frequência mantidas."
      })[kind] });
      wk.reasons.push({ code: "intensidade", text: "Modelo " + model + " na fase " + PHASE_LABEL[phase].toLowerCase() + ": alvo Z1 " + dist3[0] + "% · Z2 " + dist3[1] + "% · Z3 " + dist3[2] + "%; a semana ficou em " + wk.zone_pct.map(function (x) { return Math.round(x) + "%"; }).join(" · ") + " (aquecimentos e recuperações contam como Z1)." });
      if (strengthSessions.length) wk.reasons.push({ code: "forca", text: "Força: " + strengthSessions.length + "× " + STRENGTH[strengthSessions[0].content].title.toLowerCase() + ", depois da sessão intensa ou em dia leve, nunca na véspera de corrida forte ou longa." });
      if (bricks.length) wk.reasons.push({ code: "brick", text: bricks.length + (bricks.length > 1 ? " bricks" : " brick") + ": a transição de corrida sai do tempo de uma rodagem leve." });
      weeks.push(wk);
    }

    // --- Carga: CTL, ATL, TSB -----------------------------------------------------------
    var daily = [];
    weeks.forEach(function (wk) { wk.days.forEach(function (d) { daily.push(d.items.reduce(function (a, x) { return a + x.load; }, 0)); }); });
    var kC = 1 - Math.exp(-1 / RULES.load.ctl_days), kA = 1 - Math.exp(-1 / RULES.load.atl_days);
    var ctl = weeks[0].load / 7, atl = ctl, series = [];
    daily.forEach(function (l, i) {
      var tsb = ctl - atl;
      ctl += (l - ctl) * kC; atl += (l - atl) * kA;
      series.push({ day: i, load: l, ctl: ctl, atl: atl, tsb: tsb });
    });
    weeks.forEach(function (wk, i) { var s = series[i * 7 + 6]; wk.ctl = Math.round(s.ctl); wk.atl = Math.round(s.atl); wk.tsb = Math.round(s.ctl - s.atl); });
    var raceIdx = (total - 1) * 7 + raceWd;
    var tsbRace = Math.round(series[raceIdx].tsb);
    var ctlPeak = Math.max.apply(null, weeks.map(function (x) { return x.ctl; }));
    var ramps = [];
    for (var ri = 2; ri < weeks.length; ri++) ramps.push(weeks[ri].ctl - weeks[ri - 1].ctl);
    var maxRamp = Math.max.apply(null, ramps);
    if (maxRamp > RULES.load.ctl_ramp_max + 2) warnings.push({ level: "warn", text: "A carga crônica (CTL) sobe até " + maxRamp + " pontos numa semana; o método recomenda +3 a +5 para amadores. Reduza as horas no pico ou aumente a duração." });
    var tsbRange = RULES.load.tsb_race[dist.kind];
    if (tsbRace < tsbRange[0]) warnings.push({ level: "warn", text: "Forma na prova (TSB) estimada em " + tsbRace + ", abaixo da faixa de +" + tsbRange[0] + " a +" + tsbRange[1] + " para esta prova: o polimento pode estar curto para esta carga." });
    if (tsbRace > tsbRange[1] + 5) notes.push("TSB de +" + tsbRace + " na prova, acima da faixa de +" + tsbRange[0] + " a +" + tsbRange[1] + ": dá para polir um pouco menos.");

    // --- Conflitos e avisos gerais ------------------------------------------------------
    var conflicts = weeks.reduce(function (a, wk) { return a + wk.conflicts.length; }, 0);
    if (conflicts) warnings.push({ level: "warn", text: conflicts + (conflicts === 1 ? " conflito" : " conflitos") + " de compatibilidade entre sessões. Mais dias ou dois treinos por dia costumam resolver; veja cada semana." });
    if (p.sports.indexOf("swim") >= 0 && sessionsPerSport.swim < RULES.swim_min_sessions) notes.push("Natação com " + sessionsPerSport.swim + " sessões por semana: a técnica se mantém melhor com 3 ou mais.");
    if (runKmFloorNote) notes.push("Em algumas semanas o teto de impacto da corrida deixou a semana abaixo das horas da curva, porque não há bike no plano para absorver o tempo.");
    if (inp.run_longest != null && p.sports.indexOf("run") >= 0 && dist.run && dist.run > 15 && inp.run_longest < dist.run * 0.4) notes.push("Sua maior corrida recente é de " + fmt(inp.run_longest, 1) + " km; o longão vai crescer até " + hm(dist.long_max.run) + ", com o teto de 10% por semana no volume.");

    // --- Como o plano foi montado ----------------------------------------------------------
    reasons.push("Demanda: " + obj.name + " " + dist.name + (kindLong ? ", prova longa: o plano gira em torno de Z1 e durabilidade, e o específico é piramidal." : ", prova curta: mais peso ao tempo acima do limiar."));
    reasons.push("Nível " + LEVEL_LABEL[level].toLowerCase() + (lv.source === "manual" ? ", escolhido no formulário." : " (" + lv.signals.join("; ") + ")."));
    reasons.push("Fases: base " + phases.filter(function (x) { return x === "base"; }).length + ", construção " + phases.filter(function (x) { return x === "construcao"; }).length +
      ", específico " + phases.filter(function (x) { return x === "especifico"; }).length + ", polimento " + taper + " (" + total + " semanas, mínimo " + dist.min_weeks + " para esta prova).");
    reasons.push("Modelo de intensidade: " + modelByPhase.map(function (m, i) { return PHASE_LABEL[PHASES[i]].toLowerCase() + " " + m; }).join(", ") + (p.model === "auto" ? " (automático: polarizado com 6 h ou mais; piramidal no específico de prova longa; limiar só com pouco tempo)." : " (escolhido)."));
    reasons.push("Periodização " + per + (p.periodization === "auto" ? (per === "alternado" ? " (automático: a partir de 50 anos)" : " (automático)") : "") + ": começa em " + fmt(startTotal / 60, 1) + " h e sobe até " + fmt(peakReached / 60, 1) + " h por semana, força incluída, com aumento de até " + Math.round(growthMax * 100) + "% por semana" + (per === "3:1" ? " e alívio de 30% a cada 4ª semana." : ", alternando acréscimo e regenerativa."));
    if (p.sports.length > 1) reasons.push("Divisão do tempo por fase (" + p.sharesKey.replace("_", " ") + "): " + PHASES.map(function (ph, i) { return PHASE_LABEL[ph].toLowerCase() + " " + p.sports.map(function (s) { return SPORT[s].name.toLowerCase() + " " + Math.round(RULES.shares[p.sharesKey][s][i] * 100) + "%"; }).join(" / "); }).join("; ") + ".");
    reasons.push("Sessões por semana: " + p.sports.map(function (s) { return sessionsPerSport[s] + " de " + SPORT[s].name.toLowerCase(); }).join(", ") + (inp.strength ? " e força " + inp.strength_base + "× na base, " + Math.min(RULES.strength.build, p.doubles || days.length >= 6 ? 2 : 1) + "× na construção, 1× no específico, só core no polimento." : ", sem força."));
    if (p.sports.indexOf("run") >= 0) reasons.push("Longão " + DAY_AT[runLongDay] + (bikeLongDay != null ? ", longo de bike " + DAY_AT[bikeLongDay] : "") + ". Teto de impacto: km de corrida sobem no máximo 10% por semana" + (p.sports.length > 1 ? " e a corrida fica em até " + Math.round((RULES.run_share_cap[p.sharesKey] || Math.max.apply(null, RULES.shares[p.sharesKey].run)) * 100) + "% do tempo." : "."));
    reasons.push("Carga: TSS por zona (IF 0,65 / 0,90 / 1,08) e sRPE da força, somados; CTL e ATL pelo modelo de Banister (42 e 7 dias). TSB na prova: " + (tsbRace > 0 ? "+" : "") + tsbRace + ".");
    reasons.push("Dias: as sessões são encaixadas pela matriz de compatibilidade (sessão longa primeiro, depois bricks, sessões-chave, força pesada, leves e core), minimizando conflitos.");

    var plan = {
      version: VERSION, objetivo: p.objKey, objetivo_nome: obj.name, distancia: p.distKey, distancia_nome: dist.name, kind: dist.kind,
      sports: p.sports, level: level, level_label: LEVEL_LABEL[level], level_source: lv.source,
      model: p.model, model_by_phase: modelByPhase, periodization: per, phases: phases, taper_weeks: taper,
      weeks_count: total, start_date: isoDate(start), race_date: isoDate(raceDay), race_weekday: raceWd,
      hours_max: p.hoursMax, start_hours: round1(startTotal / 60), peak_hours: round1(peakReached / 60), days: days, doubles: p.doubles,
      run_long_day: runLongDay, bike_long_day: bikeLongDay, sessions_per_sport: sessionsPerSport,
      zones: zones, race_pace: racePace, race_time: raceTime, race_total_s: totalRace, race_total: formatTime(totalRace),
      weeks: weeks, series: series, ctl_peak: ctlPeak, tsb_race: tsbRace, tsb_range: tsbRange, conflicts: conflicts, main: obj.main,
      warnings: warnings, notes: notes, reasons: reasons, strength: inp.strength, tests: p.tests
    };
    plan.markdown = toMarkdown(plan);
    return plan;
  }

  function toMarkdown(plan) {
    var out = ["# " + plan.objetivo_nome + " · " + plan.distancia_nome, "", "- " + plan.weeks_count + " semanas, de " + plan.start_date + " a " + plan.race_date + " · nível " + plan.level_label.toLowerCase() + " · " + plan.periodization,
      "- Pico " + fmt(plan.peak_hours, 1) + " h/semana · CTL máximo " + plan.ctl_peak + " · TSB na prova " + plan.tsb_race, "- Ritmos de prova: " + plan.sports.map(function (s) { return SPORT[s].name + " " + plan.race_pace[s]; }).join(" · ") + " · estimativa " + plan.race_total];
    plan.warnings.forEach(function (w) { out.push("- Atenção: " + w.text); });
    plan.weeks.forEach(function (w) {
      out.push("", "## Semana " + w.number + " · " + w.phase_label + (w.deload ? " (alívio)" : "") + " · " + hm(w.minutes_total) + " · carga " + w.load);
      w.days.forEach(function (d) { if (d.items.length) out.push("- " + DAY_SHORT[d.day] + " " + d.date.slice(8, 10) + "/" + d.date.slice(5, 7) + ": " + d.items.map(function (x) { return SPORT[x.sport].name + " · " + x.title + (x.steps.length ? " (" + x.steps.join("; ") + ")" : ""); }).join(" + ")); });
    });
    out.push("", "Gerado pela engine do método " + VERSION + ".");
    return out.join("\n");
  }

  function describeRules() {
    return [
      ["Fases", "Polimento de 1 a 3 semanas conforme a prova; das semanas restantes, 40% base (50% para iniciante), 25% específico e o resto construção."],
      ["Intensidade", "Polarizado (Z1 ~80%, Z2 ~5%, Z3 ~15%) para 6 h ou mais; piramidal no específico de provas longas; limiar só com menos de 5 h e até 4 sessões. Aquecimentos e recuperações contam como Z1."],
      ["Mesociclos", "3:1: três semanas de carga e uma de alívio a 70%. Alternado (a partir de 50 anos): acréscimo de até 10% e semana regenerativa no patamar. Aumento de até 10% por semana (8% iniciante)."],
      ["Horas", "O plano começa no seu volume atual (entre 55% e 100% do teto) e chega ao teto no início do específico. A força é reservada antes da divisão."],
      ["Sessões", "Longa até o teto da prova; sessões-chave com o trabalho em Z2 e Z3 da distribuição (limiar, VO2máx, sweet spot, CSS, velocidade, ritmo de prova); o resto em sessões leves. Trabalho pequeno demais vira strides na rodagem."],
      ["Combinações", "Divisão do tempo por fase (triathlon curto e longo, duathlon, aquathlon); corrida com teto de participação e de impacto; bricks na construção e no específico; C–B–C no duathlon."],
      ["Dias", "Matriz de compatibilidade: força pesada depois da sessão intensa (6 h) ou em dia leve, nunca 48 h antes de corrida forte ou longa; sessões fortes da mesma modalidade com 48 h; longão sem intensidade no dia seguinte."],
      ["Força", "Adaptação (3 semanas), força máxima, potência na segunda metade da construção, manutenção 1× no específico, só core no polimento; última pesada 7 a 10 dias antes da prova."],
      ["Carga", "TSS = IF² × horas × 100 por zona (IF 0,65 / 0,90 / 1,08) e sRPE da força; CTL 42 dias, ATL 7 dias; alvo de TSB na prova entre +5 e +20 (prova curta) ou +10 e +25 (longa); rampa de CTL até +5 por semana."],
      ["Testes", "Nas semanas de alívio que fecham a base e a construção: 5 km ou 30′ na corrida, 20′ na bike, 400 + 200 m na natação, no lugar da sessão de Z3."]
    ];
  }

  return { VERSION: VERSION, PlanError: PlanError, OBJ: OBJ, SPORT: SPORT, LEVELS: LEVELS, LEVEL_LABEL: LEVEL_LABEL, PHASES: PHASES, PHASE_LABEL: PHASE_LABEL,
    PHASE_FOCUS: PHASE_FOCUS, RULES: RULES, planFromPayload: planFromPayload, describeRules: describeRules, verdict: verdict, sessionClass: sessionClass,
    formatTime: formatTime, formatPace: formatPace, hm: hm };
});
