/*
 * Engine de corrida por controle de volume.
 *
 * Três fontes de regras, mantidas separadas para que fique claro de onde vem cada número:
 *
 * - SHEET / PREREQ: a planilha regras/regras_de_controle_de_volume.xlsx. Para cada distância
 *   e nível: distância semanal, percentual do longão, número de corridas e de treinos de
 *   exercício resistido, duração do plano, tempo mínimo, faixa de velocidade que define o nível
 *   e o pré-requisito para passar à distância seguinte.
 * - COACH: as regras do treinador sobre intensidade (teto dos tiros e mínimo dos contínuos, em %
 *   do volume semanal) e os dois modelos de periodização (3:1 e alternado).
 * - COMPLEMENT: o que nenhuma das duas define e a engine precisou decidir (polimento, escolha
 *   dos dias, aquecimento dos tiros...). describeRules() lista tudo para a página.
 *
 * Funciona no navegador (window.VolumeEngine) e no Node (require).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VolumeEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.1.0";

  function PlanError(message) {
    this.name = "PlanError";
    this.message = message;
  }
  PlanError.prototype = Object.create(Error.prototype);
  PlanError.prototype.constructor = PlanError;

  // ------------------------------------------------------------------------
  // Planilha
  // ------------------------------------------------------------------------

  var LEVELS = ["principiante", "iniciante", "intermediario", "avancado", "elite"];
  var LEVEL_LABEL = {
    principiante: "Principiante", iniciante: "Iniciante", intermediario: "Intermediário",
    avancado: "Avançado", elite: "Elite"
  };

  var DISTANCES = ["5k", "10k", "21k", "42k", "50k"];
  var DISTANCE_KM = { "5k": 5, "10k": 10, "21k": 21.0975, "42k": 42.195, "50k": 50 };
  var DISTANCE_LABEL = {
    "5k": "5 km", "10k": "10 km", "21k": "Meia maratona", "42k": "Maratona", "50k": "Ultramaratona (50 km)"
  };
  var SHEET_DISTANCE = { "5k": "5 km", "10k": "10 km", "21k": "21 km", "42k": "42 km", "50k": "Ultramaratona" };
  var DISTANCE_ALIASES = {
    "5k": ["5", "5k", "5km"], "10k": ["10", "10k", "10km"],
    "21k": ["21", "21k", "21km", "meia"], "42k": ["42", "42k", "42km", "maratona"],
    "50k": ["50", "50k", "50km", "ultra", "ultramaratona"]
  };

  // Uma linha por distância e nível, na ordem da planilha. `weekly` reproduz a fórmula da
  // coluna H: ["fixo", km], ["igual", distância, nível] ou ["mais", fração sobre o nível anterior].
  // long = fórmula da coluna I (fração da distância semanal), runs = F, strength = G, min = E.
  function row(line, runs, strength, min, long, weekly) {
    return { line: line, runs: runs, strength: strength, min_weeks: min, long_pct: long, weekly: weekly };
  }
  var SHEET = {
    "5k": { weeks: 16, slow: 8, rows: {
      principiante: row(2, 3, 2, 8, 0.30, ["fixo", 12]),
      iniciante: row(3, 4, 2, 8, 0.30, ["mais", 0.2]),
      intermediario: row(4, 4, 2, 8, 0.30, ["mais", 0.2]),
      avancado: row(5, 4, 3, 12, 0.30, ["mais", 0.2]),
      elite: row(6, 5, 3, 12, 0.35, ["mais", 0.3])
    } },
    "10k": { weeks: 16, slow: 8, rows: {
      principiante: row(8, 3, 2, 8, 0.30, ["igual", "5k", "elite"]),
      iniciante: row(9, 3, 2, 8, 0.30, ["mais", 0.2]),
      intermediario: row(10, 4, 2, 8, 0.30, ["mais", 0.2]),
      avancado: row(11, 4, 3, 12, 0.30, ["mais", 0.2]),
      elite: row(12, 5, 3, 12, 0.25, ["mais", 0.3])
    } },
    "21k": { weeks: 20, slow: 10, rows: {
      principiante: row(14, 4, 2, 12, 0.30, ["igual", "10k", "avancado"]),
      iniciante: row(15, 4, 2, 12, 0.30, ["mais", 0.1]),
      intermediario: row(16, 5, 3, 12, 0.30, ["mais", 0.15]),
      avancado: row(17, 5, 3, 12, 0.28, ["mais", 0.15]),
      elite: row(18, 6, 3, 12, 0.25, ["mais", 0.2])
    } },
    "42k": { weeks: 20, slow: 10, rows: {
      principiante: row(20, 4, 3, 16, 0.35, ["igual", "21k", "avancado"]),
      iniciante: row(21, 5, 3, 16, 0.35, ["mais", 0.1]),
      intermediario: row(22, 5, 3, 16, 0.35, ["mais", 0.1]),
      avancado: row(23, 6, 3, 16, 0.35, ["mais", 0.1]),
      elite: row(24, 6, 3, 16, 0.35, ["mais", 0.2])
    } },
    // H26 = H21 na planilha: a ultra principiante parte do 42 km iniciante.
    "50k": { weeks: 20, slow: 10, rows: {
      principiante: row(26, 4, 3, 16, 0.40, ["igual", "42k", "iniciante"]),
      iniciante: row(27, 4, 3, 16, 0.40, ["mais", 0.1]),
      intermediario: row(28, 5, 4, 16, 0.40, ["mais", 0.1]),
      avancado: row(29, 5, 4, 16, 0.40, ["mais", 0.1]),
      elite: row(30, 6, 4, 16, 0.40, ["mais", 0.2])
    } }
  };

  // Pré-requisito para entrar em cada distância (linhas 7, 13, 19 e 25 da planilha).
  var PREREQ = {
    "10k": { from: "5k", line: 7, km: 21, long_km: 6.2, mode: "proximo",
             text: "rodagem mínima de 21 km/semana e um longão próximo a 6,2 km" },
    "21k": { from: "10k", line: 13, km: 47, long_km: 11.6, mode: "proximo",
             text: "rodagem mínima de 47 km/semana e um longão próximo a 11,6 km" },
    "42k": { from: "21k", line: 19, km: 68, long_km: 21, mode: "maior",
             text: "rodagem mínima de 68 km/semana e um longão maior que 21 km" },
    "50k": { from: "42k", line: 25, km: 90, long_km: 42, mode: "maior",
             text: "rodagem mínima de 90 km/semana e um longão maior que 42 km" }
  };
  var NEXT_DISTANCE = { "5k": "10k", "10k": "21k", "21k": "42k", "42k": "50k" };

  // Coluna H calculada como na planilha (cada nível sobre o anterior, e o principiante de uma
  // distância igual a um nível da distância anterior).
  var WEEKLY = {};
  DISTANCES.forEach(function (d) {
    WEEKLY[d] = {};
    var previous = null;
    LEVELS.forEach(function (lv) {
      var w = SHEET[d].rows[lv].weekly, value;
      if (w[0] === "fixo") value = w[1];
      else if (w[0] === "igual") value = WEEKLY[w[1]][w[2]];
      else value = previous * w[1] + previous;
      WEEKLY[d][lv] = value;
      previous = value;
    });
  });

  // ------------------------------------------------------------------------
  // Regras do treinador: intensidade e periodização
  // ------------------------------------------------------------------------

  var COACH = {
    // Teto dos tiros, cumulativo: IF até 5%, IF + IM até 10%, IF + IM + IL até 15% da semana.
    tiros_caps: [["IF", 0.05], ["IF+IM", 0.10], ["IF+IM+IL", 0.15]],
    // Mínimo de cada treino contínuo, em % da semana. O longão é o contínuo leve (CL).
    continuous_min: { CF: 0.20, CM: 0.25, CL: 0.30 },
    periodization: {
      "3:1": { label: "3:1", name: "3 semanas de manutenção e 1 de aumento", increase: 0.30 },
      alternado: { label: "Alternado", name: "semanas de acréscimo e regenerativas", increase: 0.10 }
    }
  };
  var PERIODIZATIONS = ["3:1", "alternado"];

  // ------------------------------------------------------------------------
  // Complementos (nem a planilha nem as regras do treinador definem)
  // ------------------------------------------------------------------------

  var COMPLEMENT = {
    start_floor: 0.5,          // começa no volume atual, nunca abaixo de 50% da regra
    taper: { "5k": [0.6], "10k": [0.6], "21k": [0.75, 0.6], "42k": [0.8, 0.65, 0.5], "50k": [0.8, 0.65, 0.5] },
    tiros_work_max: 0.6,       // tiros ocupam até 60% da sessão; o resto é aquecimento e desaquecimento
    near_fraction: 0.95,       // "próximo a X km" aceito a partir de 95% de X
    test_every: 6,             // testes de nivelamento a cada ~6 semanas
    test_km: 5,
    race_strength_gap: 2       // na semana da prova, nada de força nos 2 dias antes dela
  };

  var SESSION = {
    longao: { title: "Longão", code: "CL", weight: 2 },
    cm: { title: "Contínuo moderado", code: "CM", weight: 1 },
    cf: { title: "Contínuo forte", code: "CF", weight: 2 },
    tiros: { title: "Tiros", code: "IF+IM+IL", weight: 3 },
    leve: { title: "Rodagem leve", code: "", weight: 0 }
  };

  function pct(x) { return Math.round(x * 100) + "%"; }
  function pct1(x) { var v = Math.round(x * 1000) / 10; return String(v).replace(".", ",") + "%"; }

  function speedRangeText(distance, level) {
    var slow = SHEET[distance].slow;
    return {
      principiante: "abaixo de " + slow + " km/h",
      iniciante: slow + " a 12 km/h",
      intermediario: "12 a 14 km/h",
      avancado: "14 a 16 km/h",
      elite: "acima de 16 km/h"
    }[level];
  }

  function weeklyFormula(distance, level) {
    var r = SHEET[distance].rows[level], w = r.weekly;
    if (w[0] === "fixo") return "valor fixo da planilha";
    if (w[0] === "igual") {
      var src = SHEET[w[1]].rows[w[2]];
      return "igual ao " + SHEET_DISTANCE[w[1]] + " " + LEVEL_LABEL[w[2]].toLowerCase() + " (H" + r.line + " = H" + src.line + ")";
    }
    var p = Math.round(w[1] * 100);
    return "nível anterior + " + p + "% (H" + r.line + " = H" + (r.line - 1) + " + " + p + "%)";
  }

  /**
   * Divisão da semana entre as sessões, em fração do volume semanal.
   * Parte da média VSDL da planilha (as outras corridas iguais) e corrige pelos mínimos do
   * treinador: CM sobe até 25% e CF até 20%; o que eles ganham sai, em partes iguais, das
   * sessões sem mínimo (tiros e rodagens leves). Com 3 corridas não cabe o CF.
   */
  function sessionMix(runs, longPct) {
    var types = runs === 3 ? ["cm", "tiros"] : ["cm", "cf", "tiros"];
    while (types.length < runs - 1) types.push("leve");
    var equal = (1 - longPct) / (runs - 1);
    var mins = { cm: COACH.continuous_min.CM, cf: COACH.continuous_min.CF };
    var shares = {}, raised = 0, flexible = [];
    types.forEach(function (t, i) {
      var key = t + (t === "leve" ? i : "");
      if (mins[t] != null) {
        shares[key] = Math.max(equal, mins[t]);
        raised += shares[key] - equal;
      } else flexible.push(key);
    });
    flexible.forEach(function (key) { shares[key] = equal - raised / flexible.length; });
    var sessions = [{ type: "longao", share: longPct }].concat(types.map(function (t, i) {
      return { type: t, share: shares[t + (t === "leve" ? i : "")] };
    }));
    var tiros = sessions.filter(function (s) { return s.type === "tiros"; })[0];
    var work = Math.min(COACH.tiros_caps[2][1], tiros.share * COMPLEMENT.tiros_work_max);
    return { sessions: sessions, equal: equal, tiros_share: tiros.share, work: work, part: work / 3 };
  }

  /** A linha da planilha para a distância e o nível, com as colunas H a K calculadas. */
  function rule(distance, level) {
    var r = SHEET[distance].rows[level];
    var weekly = WEEKLY[distance][level];
    var long = weekly * r.long_pct;
    var vsdl = weekly - long;
    return {
      distance: distance, level: level, line: r.line,
      runs: r.runs, strength: r.strength, weeks: SHEET[distance].weeks, min_weeks: r.min_weeks,
      speed_range: speedRangeText(distance, level),
      weekly_km: weekly, long_pct: r.long_pct, long_km: long, vsdl_km: vsdl, avg_km: vsdl / (r.runs - 1),
      weekly_formula: weeklyFormula(distance, level),
      mix: sessionMix(r.runs, r.long_pct)
    };
  }

  /** As 25 linhas da planilha, na ordem dela. */
  function sheetTable() {
    var out = [];
    DISTANCES.forEach(function (d) {
      LEVELS.forEach(function (lv) { out.push(rule(d, lv)); });
    });
    return out;
  }

  /** Nível pela velocidade de nivelamento (coluna C). */
  function levelForSpeed(distance, kmh) {
    if (kmh < SHEET[distance].slow) return "principiante";
    if (kmh < 12) return "iniciante";
    if (kmh < 14) return "intermediario";
    if (kmh < 16) return "avancado";
    return "elite";
  }

  /** Sem velocidade: o maior nível cuja distância semanal cabe no volume atual. */
  function levelForVolume(distance, weeklyKm) {
    var found = "principiante";
    LEVELS.forEach(function (lv) { if (WEEKLY[distance][lv] <= weeklyKm + 1e-9) found = lv; });
    return found;
  }

  function prereqStatus(distance, weeklyKm, longestKm) {
    var p = PREREQ[distance];
    if (!p) return null;
    var longMin = p.mode === "proximo" ? p.long_km * COMPLEMENT.near_fraction : p.long_km;
    var kmOk = weeklyKm >= p.km;
    var longOk = p.mode === "proximo" ? longestKm >= longMin : longestKm > p.long_km;
    return {
      distance: distance, from: p.from, line: p.line, text: p.text, km: p.km, long_km: p.long_km, mode: p.mode,
      long_min_km: longMin, weekly_km: weeklyKm, longest_km: longestKm,
      km_ok: kmOk, long_ok: longOk, met: kmOk && longOk
    };
  }

  /** O que é regra da planilha, do treinador e complemento, para mostrar na página. */
  function describeRules() {
    var c = COMPLEMENT;
    return {
      planilha: [
        ["Nível", "Pela velocidade de nivelamento (km/h): abaixo de 8 principiante (abaixo de 10 do 21 km em diante), 8 ou 10 a 12 iniciante, 12 a 14 intermediário, 14 a 16 avançado, acima de 16 elite."],
        ["Duração", "16 semanas para 5 e 10 km, 20 semanas do 21 km em diante. Abaixo do tempo mínimo da linha, o plano não é gerado."],
        ["Sessões", "Número de corridas e de treinos de exercício resistido por semana, conforme a linha."],
        ["Distância semanal", "Volume-alvo da linha (coluna H). Cada nível soma 10% a 30% ao anterior e o principiante de uma distância parte de um nível da distância anterior."],
        ["Longão", "Percentual fixo da distância semanal (25% a 40%, coluna I)."],
        ["Demais corridas", "VSDL = distância semanal − longão, dividido entre as outras corridas (média VSDL). As regras de intensidade ajustam essa divisão."],
        ["Pré-requisito", "Para passar à distância seguinte: rodagem semanal mínima e longão (linhas 7, 13, 19 e 25)."]
      ],
      treinador: [
        ["Tiros", "Teto em % do volume semanal: IF até 5%, IF + IM até 10%, IF + IM + IL até 15%."],
        ["Contínuos", "Mínimo em % do volume semanal: CF 20%, CM 25%, CL 30%. Uma sessão de cada; o longão é o CL."],
        ["3:1", "3 semanas de manutenção e 1 de aumento, de até 30%. O novo volume vira o patamar das semanas seguintes."],
        ["Alternado", "Semanas de acréscimo (até 10%) alternadas com regenerativas, que voltam ao patamar. A cada dois pares, o patamar sobe para o volume do acréscimo."]
      ],
      complemento: [
        ["Início e teto", "O plano começa no seu volume atual, entre " + pct(c.start_floor) + " e 100% da distância semanal da linha, e para de subir quando chega nela."],
        ["Divisão das sessões", "Parte da média VSDL. CM e CF sobem até o mínimo, e a diferença sai igualmente dos tiros e das rodagens leves. Com 3 corridas não cabe o CF; com 5 ou 6, as corridas a mais são rodagens leves."],
        ["Sessão de tiros", "Tiros em até " + pct(c.tiros_work_max) + " da sessão (e no máximo 15% da semana), divididos igualmente entre IF, IM e IL. O resto é aquecimento e desaquecimento."],
        ["Ordem na semana", "Os treinos mais fortes ficam longe uns dos outros e da véspera do longão. A força vai nos dias sem corrida; se faltar dia, entra depois da corrida mais leve. Na semana da prova, sem força nos " + c.race_strength_gap + " dias antes dela e a véspera vira rodagem leve."],
        ["Polimento", "Últimas semanas com menos volume (5 e 10 km: 60% na semana da prova; 21 km: 75% e 60%; 42 km e ultra: 80%, 65% e 50%). Na semana da prova, a prova entra no lugar do longão."],
        ["Próximo a", "“Longão próximo a X km” é aceito a partir de " + pct(c.near_fraction) + " de X."],
        ["Testes", "Teste de nivelamento de " + c.test_km + " km a cada ~" + c.test_every + " semanas (de preferência numa regenerativa), no lugar dos tiros."],
        ["Sem prova recente", "Sem velocidade de nivelamento, o nível sai do volume atual: o maior nível cuja distância semanal você já corre."]
      ]
    };
  }

  // ------------------------------------------------------------------------
  // Utilitários
  // ------------------------------------------------------------------------

  function plain(value) {
    return String(value).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  function round1(x) { return Math.round(x * 10 + 1e-9) / 10; }
  function km1(x) { return round1(x).toFixed(1).replace(".", ","); }
  function kmh1(x) { return (Math.round(x * 10) / 10).toFixed(1).replace(".", ","); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function mod(a, b) { return ((a % b) + b) % b; }
  function blank(v) { return v == null || String(v).trim() === ""; }

  function parseNumber(value, label, min, max) {
    if (blank(value)) return null;
    var n = Number(String(value).trim().replace(",", "."));
    if (!isFinite(n)) throw new PlanError(label + ": número inválido (" + value + ").");
    if (min != null && n < min) throw new PlanError(label + " deve ser pelo menos " + String(min).replace(".", ",") + ".");
    if (max != null && n > max) throw new PlanError(label + " deve ser no máximo " + String(max).replace(".", ",") + ".");
    return n;
  }

  function formatTimeDigits(digits) {
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return digits.slice(0, -2) + ":" + digits.slice(-2);
    return digits.slice(0, -4) + ":" + digits.slice(-4, -2) + ":" + digits.slice(-2);
  }
  /** "48:30", "1:45:00" ou só dígitos ("4830") -> segundos. */
  function parseTime(value, label) {
    var text = String(value).trim();
    if (/^\d+$/.test(text)) text = formatTimeDigits(text);
    var parts = text.split(":");
    var ok = parts.length >= 2 && parts.length <= 3 && parts.every(function (p) { return /^\d+$/.test(p); });
    if (!ok) throw new PlanError(label + ": tempo inválido (" + value + "). Use mm:ss ou h:mm:ss.");
    var n = parts.map(function (p) { return parseInt(p, 10); });
    if (n.slice(1).some(function (x) { return x >= 60; })) throw new PlanError(label + ": minutos e segundos vão até 59.");
    var s = 0;
    n.forEach(function (x) { s = s * 60 + x; });
    if (s <= 0) throw new PlanError(label + ": tempo inválido (" + value + ").");
    return s;
  }
  function formatTime(seconds) {
    var t = Math.round(seconds), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? h + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
  }
  function speedKmh(distanceKm, seconds) { return distanceKm / (seconds / 3600); }

  function parseDistance(value) {
    var key = plain(value).replace(/\s/g, "");
    for (var i = 0; i < DISTANCES.length; i++) {
      if (DISTANCE_ALIASES[DISTANCES[i]].indexOf(key) >= 0) return DISTANCES[i];
    }
    throw new PlanError("Escolha a prova-alvo: 5, 10, 21, 42 km ou ultra.");
  }
  function parseLevel(value) {
    if (blank(value) || plain(value) === "auto") return null;
    var key = plain(value);
    if (LEVELS.indexOf(key) < 0) throw new PlanError("Nível desconhecido: " + value + ".");
    return key;
  }
  function parsePeriodization(value) {
    if (blank(value)) return "3:1";
    var key = plain(value).replace(/\s/g, "");
    if (key === "3:1" || key === "31" || key === "3x1") return "3:1";
    if (key === "alternado") return "alternado";
    throw new PlanError("Periodização desconhecida: " + value + " (use 3:1 ou alternado).");
  }

  // Datas como dias desde 1970-01-01 (UTC). Dia da semana: 0 = segunda ... 6 = domingo.
  var DAY_MS = 86400000;
  function parseIsoDate(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return Math.round(t / DAY_MS);
  }
  function isoDate(day) { return new Date(day * DAY_MS).toISOString().slice(0, 10); }
  function weekday(day) { return mod(day + 3, 7); }
  function todayLocal() {
    var now = new Date();
    return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
  }
  function ddmm(day, year) {
    var p = isoDate(day).split("-");
    return p[2] + "/" + p[1] + (year ? "/" + p[0] : "");
  }

  var DAY_SHORT = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  var DAY_AT = ["na segunda", "na terça", "na quarta", "na quinta", "na sexta", "no sábado", "no domingo"];
  function joinList(names) {
    return names.length > 1 ? names.slice(0, -1).join(", ") + " e " + names[names.length - 1] : names.join("");
  }
  function dayList(days) { return joinList(days.map(function (d) { return DAY_SHORT[d]; })); }

  // ------------------------------------------------------------------------
  // Dias da semana
  // ------------------------------------------------------------------------

  function combinations(items, k) {
    var out = [];
    (function rec(start, acc) {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (var i = start; i < items.length; i++) { acc.push(items[i]); rec(i + 1, acc); acc.pop(); }
    })(0, []);
    return out;
  }
  function permutations(items) {
    if (items.length <= 1) return [items.slice()];
    var out = [];
    items.forEach(function (x, i) {
      var rest = items.slice(0, i).concat(items.slice(i + 1));
      permutations(rest).forEach(function (p) { out.push([x].concat(p)); });
    });
    return out;
  }
  function circularGaps(days) {
    var s = days.slice().sort(function (a, b) { return a - b; });
    if (s.length < 2) return [7];
    return s.map(function (d, i) { return i === s.length - 1 ? s[0] + 7 - d : s[i + 1] - d; });
  }
  function best(options, score) {
    var pick = null, low = Infinity;
    options.forEach(function (o) { var v = score(o); if (v < low - 1e-9) { low = v; pick = o; } });
    return pick;
  }

  /** Corridas: o dia do longão e mais `runs - 1` dias marcados, os mais espaçados. */
  function pickRunDays(marked, longDay, runs) {
    var others = marked.filter(function (d) { return d !== longDay; });
    var before = mod(longDay - 1, 7), after = mod(longDay + 1, 7);
    var chosen = best(combinations(others, runs - 1), function (set) {
      var gaps = circularGaps(set.concat([longDay]));
      var b2b = gaps.filter(function (g) { return g === 1; }).length;
      return 10 * b2b + 3 * (set.indexOf(before) >= 0) + 2 * (set.indexOf(after) >= 0) - Math.min.apply(null, gaps);
    });
    return chosen.concat([longDay]).sort(function (a, b) { return a - b; });
  }

  /**
   * Tipo de sessão de cada dia de corrida: os treinos mais fortes longe uns dos outros.
   * Minimiza a soma, entre dias seguidos, do produto dos pesos de intensidade.
   */
  function assignSessionTypes(runDays, longDay, types) {
    var others = runDays.filter(function (d) { return d !== longDay; });
    var assignment = best(permutations(types), function (perm) {
      var w = [0, 0, 0, 0, 0, 0, 0];
      w[longDay] = SESSION.longao.weight;
      others.forEach(function (d, i) { w[d] = SESSION[perm[i]].weight; });
      var s = 0;
      for (var d = 0; d < 7; d++) s += w[d] * w[(d + 1) % 7];
      return s;
    });
    var byDay = {};
    byDay[longDay] = "longao";
    others.forEach(function (d, i) { byDay[d] = assignment[i]; });
    return byDay;
  }

  /** Exercício resistido: dias sem corrida primeiro; se faltar, depois da corrida mais leve. */
  function pickStrengthDays(runDays, longDay, count, typeByDay) {
    var free = [0, 1, 2, 3, 4, 5, 6].filter(function (d) { return runDays.indexOf(d) < 0; });
    var before = mod(longDay - 1, 7);
    function score(set) {
      var gaps = circularGaps(set);
      var b2b = set.length > 1 ? gaps.filter(function (g) { return g === 1; }).length : 0;
      var load = set.reduce(function (s, d) { return s + (typeByDay[d] ? SESSION[typeByDay[d]].weight : 0); }, 0);
      return 10 * b2b + 4 * (set.indexOf(before) >= 0) + 6 * load - Math.min.apply(null, gaps);
    }
    if (free.length >= count) {
      return { days: best(combinations(free, count), score).sort(function (a, b) { return a - b; }), doubled: [] };
    }
    var shortRuns = runDays.filter(function (d) { return d !== longDay; });
    var extra = best(combinations(shortRuns, count - free.length), function (set) { return score(free.concat(set)); });
    return { days: free.concat(extra).sort(function (a, b) { return a - b; }), doubled: extra.slice().sort(function (a, b) { return a - b; }) };
  }

  // ------------------------------------------------------------------------
  // Volume semana a semana (modelos de periodização)
  // ------------------------------------------------------------------------

  var KIND_LABEL = {
    inicio: "Início", manutencao: "Manutenção", aumento: "Aumento", patamar: "Novo patamar", acrescimo: "Acréscimo",
    regenerativa: "Regenerativa", regra: "", polimento: ""
  };

  /** Alvo de cada semana de treino (sem o polimento) pelo modelo escolhido. */
  function trainingCurve(model, weeks, startKm, H) {
    var out = [], level = startKm, inc = COACH.periodization[model].increase;
    if (model === "3:1") {
      for (var i = 0; i < weeks; i++) {
        var n = i + 1, kind, from = level;
        if (n % 4 === 0 && level < H - 1e-9) { level = Math.min(H, level * (1 + inc)); kind = "aumento"; }
        else kind = level >= H - 1e-9 ? "regra" : "manutencao";
        out.push({ target: level, kind: kind, from: from });
      }
      return out;
    }
    var high = level;
    for (var j = 0; j < weeks; j++) {
      var pos = j % 4, k, t, prev = j ? out[j - 1].target : level;
      if (pos === 0 && j > 0) level = high;
      if (pos === 1) high = Math.min(H, level * (1 + inc));
      if (pos === 0) { t = level; k = level >= H - 1e-9 ? "regra" : j === 0 ? "inicio" : "patamar"; }
      else if (pos === 2) { t = level; k = level >= H - 1e-9 ? "regra" : "regenerativa"; }
      else { t = high; k = high > level + 1e-9 ? "acrescimo" : "regra"; }
      out.push({ target: t, kind: k, from: prev });
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // Plano
  // ------------------------------------------------------------------------

  /** Nível e linha da planilha a partir das entradas (usado também nas dicas do formulário). */
  function classify(payload) {
    var distance = parseDistance(payload.distance);
    var manual = parseLevel(payload.level);
    var weekly = parseNumber(payload.weekly_km, "Km por semana", 0, 400) || 0;
    var speed = null, speedText = null;
    if (!blank(payload.recent_distance) && !blank(payload.recent_time)) {
      var rk = parseNumber(payload.recent_distance, "Distância da prova recente", 0.4, 200);
      var rs = parseTime(payload.recent_time, "Tempo da prova recente");
      speed = speedKmh(rk, rs);
      speedText = String(Math.round(rk * 10) / 10).replace(".", ",") + " km em " + formatTime(rs);
    }
    var level, source;
    if (manual) { level = manual; source = "manual"; }
    else if (speed != null) { level = levelForSpeed(distance, speed); source = "velocidade"; }
    else { level = levelForVolume(distance, weekly); source = "volume"; }
    return {
      distance: distance, level: level, source: source, speed_kmh: speed, speed_text: speedText,
      speed_level: speed != null ? levelForSpeed(distance, speed) : null, rule: rule(distance, level)
    };
  }

  function parseRunDays(value) {
    var list = Array.isArray(value) ? value : blank(value) ? [] : String(value).split(",");
    var days = [];
    list.forEach(function (v) {
      var d = parseInt(String(v).trim(), 10);
      if (!(d >= 0 && d <= 6)) throw new PlanError("Dia de corrida inválido: " + v + ".");
      if (days.indexOf(d) < 0) days.push(d);
    });
    return days.sort(function (a, b) { return a - b; });
  }

  function parseEvents(list, byDate, start) {
    if (!Array.isArray(list)) return [];
    return list.map(function (ev, i) {
      var label = "Prova ou teste " + (i + 1);
      var kind = plain(ev.kind || "prova") === "teste" ? "teste" : "prova";
      var kmv = parseNumber(ev.distance_km, label + " · distância", 0.4, 200);
      if (kmv == null) throw new PlanError(label + ": informe a distância.");
      var week, day = null, date = null;
      if (byDate || !blank(ev.date)) {
        date = parseIsoDate(ev.date);
        if (date == null) throw new PlanError(label + ": informe a data.");
        week = Math.floor((date - start) / 7) + 1;
        day = weekday(date);
      } else {
        week = parseNumber(ev.week, label + " · semana", 1, 52);
        if (week == null || week !== Math.floor(week)) throw new PlanError(label + ": informe a semana do plano.");
      }
      var time = blank(ev.time) ? null : parseTime(ev.time, label);
      return { kind: kind, week: week, day: day, date: date, distance_km: kmv, time_s: time, auto: false };
    });
  }

  // km com 2 casas: a tela mostra 1 casa, e o total da semana não acumula erro de arredondamento.
  function r2(x) { return Math.round(x * 100) / 100; }
  function item(type, title, kmv, note, extra) {
    var it = { type: type, title: title, km: kmv == null ? null : r2(kmv), note: note || "" };
    if (extra) Object.keys(extra).forEach(function (k) { it[k] = extra[k]; });
    return it;
  }

  function sessionItem(type, share, weekKm, mix) {
    var kmv = share * weekKm, s = SESSION[type];
    if (type === "longao") return item("longao", s.title, kmv, "CL · " + pct1(share) + " da semana", { share: share, code: "CL" });
    if (type === "cm") return item("cm", s.title, kmv, pct1(share) + " da semana (mínimo 25%)", { share: share, code: "CM" });
    if (type === "cf") return item("cf", s.title, kmv, pct1(share) + " da semana (mínimo 20%)", { share: share, code: "CF" });
    if (type === "leve") return item("leve", s.title, kmv, pct1(share) + " da semana", { share: share, code: "" });
    var part = mix.part * weekKm, warm = (kmv - 3 * part) / 2;
    return item("tiros", s.title, kmv, pct1(share) + " da semana · " + pct1(mix.work) + " em tiros (máximo 15%)", {
      share: share, code: "IF+IM+IL",
      parts: [["Aquecimento", warm], ["IF", part], ["IM", part], ["IL", part], ["Desaquecimento", warm]].map(function (p) {
        return { label: p[0], km: r2(p[1]) };
      })
    });
  }

  /**
   * Monta o plano. `payload` tem os mesmos campos do formulário da Endurance Forge
   * (strings, como vêm do formulário) e `periodization` ("3:1" ou "alternado").
   * `options.today` (AAAA-MM-DD) fixa a data de hoje nos testes.
   */
  function planFromPayload(payload, options) {
    options = options || {};
    var c = classify(payload);
    var distance = c.distance, level = c.level, R = c.rule, H = R.weekly_km, mix = R.mix;
    var model = parsePeriodization(payload.periodization), M = COACH.periodization[model];
    var weeklyNow = parseNumber(payload.weekly_km, "Km por semana", 0, 400);
    if (weeklyNow == null) throw new PlanError("Informe quantos km você corre por semana (0 se ainda não corre).");
    var longestNow = parseNumber(payload.longest_run_km, "Maior corrida", 0, 200) || 0;
    var warnings = [], notes = [], reasons = [];

    // --- Prazo -----------------------------------------------------------
    var today = options.today ? parseIsoDate(options.today) : todayLocal();
    var start = today + mod(7 - weekday(today), 7); // próxima segunda (hoje, se for segunda)
    var byDate = !blank(payload.race_date);
    var total, raceDate = null;
    if (byDate) {
      raceDate = parseIsoDate(payload.race_date);
      if (raceDate == null) throw new PlanError("Data da prova inválida.");
      if (raceDate < start) throw new PlanError("A prova precisa ser a partir de " + ddmm(start, true) + ", quando o plano começa.");
      total = Math.floor((raceDate - start) / 7) + 1;
      if (total > 52) throw new PlanError("A prova está a mais de 52 semanas. Escolha uma data mais próxima.");
    } else {
      total = parseNumber(payload.weeks, "Duração do plano", 1, 52);
      if (total == null) total = R.weeks;
      if (total !== Math.floor(total)) throw new PlanError("A duração do plano deve ser um número inteiro de semanas.");
    }
    if (total < R.min_weeks) {
      throw new PlanError((byDate ? "Faltam " + total + (total === 1 ? " semana" : " semanas") + " até a prova, mas o" : "O") +
        " tempo mínimo da planilha para " + SHEET_DISTANCE[distance] + " no nível " + LEVEL_LABEL[level].toLowerCase() +
        " é de " + R.min_weeks + " semanas (o plano padrão tem " + R.weeks + ")." +
        (byDate ? " Escolha uma prova mais distante." : " Aumente a duração."));
    }

    // --- Dias ------------------------------------------------------------
    var marked = parseRunDays(payload.run_days);
    if (marked.length < R.runs) {
      throw new PlanError("A planilha pede " + R.runs + " corridas por semana para " + SHEET_DISTANCE[distance] + " no nível " +
        LEVEL_LABEL[level].toLowerCase() + ". Marque pelo menos " + R.runs + " dias de corrida (" +
        marked.length + (marked.length === 1 ? " marcado" : " marcados") + ").");
    }
    var longDay;
    if (!blank(payload.long_run_day)) {
      longDay = parseInt(payload.long_run_day, 10);
      if (marked.indexOf(longDay) < 0) throw new PlanError("O dia do longão precisa ser um dos dias de corrida marcados.");
    } else {
      longDay = marked.indexOf(6) >= 0 ? 6 : marked.indexOf(5) >= 0 ? 5 : marked[marked.length - 1];
    }
    var runDays = pickRunDays(marked, longDay, R.runs);
    var typeByDay = assignSessionTypes(runDays, longDay, mix.sessions.slice(1).map(function (s) { return s.type; }));
    var strength = pickStrengthDays(runDays, longDay, R.strength, typeByDay);
    var raceDay = byDate ? weekday(raceDate) : longDay;
    var tirosDay = +Object.keys(typeByDay).filter(function (d) { return typeByDay[d] === "tiros"; })[0];

    // --- Volume semana a semana -------------------------------------------
    var taperFr = COMPLEMENT.taper[distance]; // o tempo mínimo (8+ semanas) sempre comporta o polimento
    var nTrain = total - taperFr.length;
    var startKm = Math.min(Math.max(weeklyNow, H * COMPLEMENT.start_floor), H);
    var curve = trainingCurve(model, nTrain, startKm, H);
    var peak = Math.max.apply(null, curve.map(function (w) { return w.target; }));
    var reachedAt = null;
    curve.forEach(function (w, i) { if (reachedAt == null && w.target >= H - 1e-9) reachedAt = i + 1; });

    var weeksPlan = [];
    for (var i = 0; i < total; i++) {
      var n = i + 1, w = { number: n, is_race: n === total, reasons: [] };
      if (i < nTrain) {
        var cw = curve[i];
        w.target_km = cw.target;
        w.kind = cw.kind;
        w.phase = cw.target >= H - 1e-9 ? "regra" : "progressao";
        var why = {
          manutencao: "Manutenção (" + M.label + "): mantém " + km1(cw.target) + " km.",
          aumento: "Aumento (" + M.label + "): " + km1(cw.from) + " → " + km1(cw.target) + " km (+" + pct(cw.target / cw.from - 1) + ", até " + pct(M.increase) + ").",
          patamar: "Novo patamar (alternado): " + km1(cw.target) + " km, o volume das últimas semanas de acréscimo.",
          acrescimo: "Acréscimo (alternado): " + km1(cw.from) + " → " + km1(cw.target) + " km (+" + pct(cw.target / cw.from - 1) + ", até 10%).",
          regenerativa: "Regenerativa (alternado): volta ao patamar de " + km1(cw.target) + " km.",
          regra: "Distância semanal da regra: " + km1(H) + " km (" + R.weekly_formula + ")."
        }[cw.kind];
        if (i === 0 && cw.kind !== "regra") {
          why = "Início: " + km1(cw.target) + " km" + (weeklyNow < H * COMPLEMENT.start_floor ? ", 50% da regra (complemento)." : ", o seu volume atual.") +
            " A regra é " + km1(H) + " km.";
        }
        w.reasons.push({ code: "volume", text: why });
      } else {
        var k = i - nTrain;
        w.phase = "polimento";
        w.kind = "polimento";
        w.target_km = peak * taperFr[k];
        w.reasons.push({ code: "volume", text: "Polimento (complemento): " + pct(taperFr[k]) + " de " + km1(peak) + " km = " + km1(w.target_km) + " km." });
      }
      w.is_regen = w.kind === "regenerativa";
      w.is_increase = w.kind === "aumento" || w.kind === "acrescimo";
      weeksPlan.push(w);
    }

    // --- Provas e testes ------------------------------------------------------
    var events = parseEvents(payload.events, byDate, start);
    var ignored = [];
    events = events.filter(function (ev) {
      if (ev.week >= 1 && ev.week < total) return true;
      ignored.push(ev);
      return false;
    });
    if (ignored.length) {
      warnings.push({ level: "warn", text: (ignored.length === 1 ? "Uma prova ou teste ficou" : ignored.length + " provas ou testes ficaram") +
        " fora do plano: só valem entre a semana 1 e a semana " + (total - 1) + " (a semana " + total + " é a da prova-alvo)." });
    }
    if (String(payload.pace_tests) === "1" || payload.pace_tests === true) {
      var last = 0;
      for (var t = 1; t <= nTrain; t++) {
        if (t - last < COMPLEMENT.test_every) continue;
        var pick = t;
        if (!weeksPlan[t - 1].is_regen && t < nTrain && weeksPlan[t].is_regen) pick = t + 1;
        if (events.some(function (e) { return e.week === pick; })) continue;
        events.push({ kind: "teste", week: pick, day: null, date: null, distance_km: COMPLEMENT.test_km, time_s: null, auto: true });
        last = pick;
        t = pick;
      }
      events.sort(function (a, b) { return a.week - b.week; });
    }

    // --- Sessões ---------------------------------------------------------
    weeksPlan.forEach(function (w) {
      var monday = start + (w.number - 1) * 7;
      w.start_date = isoDate(monday);
      var days = [];
      for (var d = 0; d < 7; d++) days.push({ day: d, date: isoDate(monday + d), items: [] });
      var shareByType = {};
      mix.sessions.forEach(function (s) { shareByType[s.type] = s.share; });
      runDays.forEach(function (d) {
        days[d].items.push(sessionItem(typeByDay[d], shareByType[typeByDay[d]], w.target_km, mix));
      });
      strength.days.forEach(function (d) {
        days[d].items.push(item("forca", "Exercício resistido", null, strength.doubled.indexOf(d) >= 0 ? "depois da corrida" : ""));
      });
      if (!w.is_race) {
        w.reasons.push({ code: "sessoes", text: mix.sessions.map(function (s) {
          return (s.type === "longao" ? "Longão (CL)" : SESSION[s.type].title + (SESSION[s.type].code && s.type !== "tiros" ? " (" + SESSION[s.type].code + ")" : "")) +
            " " + pct1(s.share) + " = " + km1(s.share * w.target_km) + " km";
        }).join("; ") + "." });
        w.reasons.push({ code: "tiros", text: "Tiros: " + pct1(mix.work) + " da semana = " + km1(mix.work * w.target_km) + " km (IF, IM e IL com " +
          km1(mix.part * w.target_km) + " km cada; teto de 15%)." });
      }

      function place(day, it) { days[day].items = [it]; }
      function dropType(type) {
        days.forEach(function (dd) { dd.items = dd.items.filter(function (x) { return x.type !== type; }); });
      }
      function dropStrength(from, to) {
        for (var dd = Math.max(0, from); dd <= to; dd++) days[dd].items = days[dd].items.filter(function (x) { return x.type !== "forca"; });
      }

      events.filter(function (e) { return e.week === w.number; }).forEach(function (e) {
        var kmText = String(Math.round(e.distance_km * 10) / 10).replace(".", ",") + " km";
        if (e.kind === "prova") {
          var dayP = e.day == null ? longDay : e.day;
          dropType("longao");
          place(dayP, item("prova", "Prova de " + kmText, e.distance_km, "no lugar do longão"));
          if (dayP > 0) dropStrength(dayP - 1, dayP - 1);
          w.reasons.push({ code: "prova", text: "Prova de " + kmText + " " + DAY_AT[dayP] + ", no lugar do longão." });
        } else {
          var dayT = e.day == null ? tirosDay : e.day;
          dropType("tiros");
          place(dayT, item("teste", e.auto ? "Teste de nivelamento · " + kmText : "Teste de " + kmText,
            e.distance_km, "no seu melhor ritmo: a velocidade média define o nível"));
          w.reasons.push({ code: "teste", text: (e.auto ? "Teste de nivelamento automático (complemento)" : "Teste de " + kmText) + " " + DAY_AT[dayT] + ", no lugar dos tiros." });
        }
      });

      if (w.is_race) {
        dropType("longao");
        for (var a = raceDay + 1; a < 7; a++) days[a].items = [];
        place(raceDay, item("prova", "PROVA · " + DISTANCE_LABEL[distance], DISTANCE_KM[distance], "prova-alvo"));
        dropStrength(raceDay - COMPLEMENT.race_strength_gap, raceDay - 1);
        if (raceDay > 0) {
          days[raceDay - 1].items = days[raceDay - 1].items.map(function (x) {
            if (["cm", "cf", "tiros", "leve"].indexOf(x.type) < 0) return x;
            return item("leve", "Rodagem leve", x.km, "véspera da prova" + (x.type !== "leve" ? ", no lugar do " + SESSION[x.type].title.toLowerCase() : ""));
          });
        }
        w.reasons.push({ code: "prova", text: "Semana da prova: a prova entra no lugar do longão e a véspera é leve" +
          (raceDay < 6 ? "; os dias depois dela ficam livres." : ".") });
      }
      days.forEach(function (dd) {
        if (!dd.items.length) dd.items.push(item("descanso", "Descanso", null, ""));
      });
      w.days = days;
      w.total_km = round1(days.reduce(function (s, dd) {
        return s + dd.items.reduce(function (t2, x) { return t2 + (x.km || 0); }, 0);
      }, 0));
      w.run_count = days.reduce(function (s, dd) {
        return s + dd.items.filter(function (x) { return x.km; }).length;
      }, 0);
      w.strength_count = days.reduce(function (s, dd) {
        return s + dd.items.filter(function (x) { return x.type === "forca"; }).length;
      }, 0);
    });

    // --- Pré-requisitos ----------------------------------------------------
    var prereq = prereqStatus(distance, weeklyNow, longestNow);
    if (prereq && !prereq.met) {
      var miss = [];
      if (!prereq.km_ok) miss.push("rodagem de " + km1(weeklyNow) + " km/semana (mínimo " + prereq.km + ")");
      if (!prereq.long_ok) miss.push("maior corrida de " + km1(longestNow) + " km (" + (prereq.mode === "proximo" ? "próximo a " : "maior que ") + String(prereq.long_km).replace(".", ",") + ")");
      warnings.unshift({ level: "bad", code: "prereq", text: "Pré-requisito para " + SHEET_DISTANCE[distance] + " não atendido: " + miss.join(" e ") +
        ". A planilha pede " + prereq.text + ". O recomendado é fazer antes o plano de " + SHEET_DISTANCE[prereq.from] + "." });
    }
    var next = NEXT_DISTANCE[distance];
    var peakLong = round1(peak * R.long_pct);
    var nextPhase = next ? prereqStatus(next, round1(peak), peakLong) : null;

    // --- Avisos e notas ------------------------------------------------------
    if (weeklyNow > H + 1e-9) {
      warnings.push({ level: "warn", text: "Você já corre " + km1(weeklyNow) + " km/semana, mais que a distância semanal da regra (" + km1(H) +
        " km). O plano segue a planilha e fica em " + km1(H) + " km." });
    } else if (weeklyNow < H * COMPLEMENT.start_floor) {
      warnings.push({ level: "warn", text: "Você corre " + km1(weeklyNow) + " km/semana, menos da metade da regra (" + km1(H) +
        " km). O plano começa em " + km1(startKm) + " km, um salto grande para a primeira semana." });
    }
    if (reachedAt == null) {
      warnings.push({ level: "warn", text: "Com o modelo " + M.label.toLowerCase() + ", o plano não chega à distância semanal da regra (" +
        km1(H) + " km) antes do polimento: o pico fica em " + km1(peak) + " km." +
        (model === "alternado" ? " O 3:1 sobe mais rápido." : " Comece com mais volume ou aumente a duração.") });
    }
    if (R.long_pct < COACH.continuous_min.CL - 1e-9) {
      warnings.push({ level: "info", text: "A linha " + R.line + " pede longão de " + pct(R.long_pct) + ", abaixo do mínimo de 30% do contínuo leve (CL). O plano segue a planilha." });
    }
    var bigger = mix.sessions.filter(function (s) { return s.type !== "longao" && s.share > R.long_pct + 1e-9; });
    if (bigger.length) {
      warnings.push({ level: "info", text: "Nesta linha o longão (" + pct(R.long_pct) + ") fica menor que " +
        joinList(bigger.map(function (s) { return SESSION[s.type].title.toLowerCase() + " (" + pct1(s.share) + ")"; })) +
        ": com " + R.runs + " corridas, a média VSDL é " + pct1(mix.equal) + " da semana." });
    }
    if (R.runs === 3) notes.push("Com 3 corridas não cabe o contínuo forte (CF): a semana tem longão, CM e tiros.");
    if (marked.length > R.runs) {
      notes.push("Você marcou " + marked.length + " dias; a planilha pede " + R.runs + " corridas. Dias usados: " + dayList(runDays) + ".");
    }
    if (!byDate && total > R.weeks) {
      notes.push("A planilha prevê " + R.weeks + " semanas; com " + total + ", o plano passa mais semanas na distância semanal da regra.");
    }

    // Duração máxima do longão: sem regra; só um alerta pela velocidade de nivelamento.
    var capMin = parseNumber(payload.long_run_max_min, "Duração máxima do longão", 10, 600);
    var maxLong = peak * R.long_pct;
    if (capMin && c.speed_kmh && maxLong / c.speed_kmh * 60 > capMin) {
      warnings.push({ level: "warn", text: "O maior longão (" + km1(maxLong) + " km) leva pelo menos " + Math.round(maxLong / c.speed_kmh * 60) +
        " min mesmo na velocidade da sua prova recente, acima do limite de " + capMin + " min. A planilha não tem limite de duração; o longão segue o percentual da regra." });
    }

    // Meta e resultados com tempo: em que nível cairiam pela velocidade.
    var goal = null;
    if (!blank(payload.goal_time)) {
      var gs = parseTime(payload.goal_time, "Tempo-alvo");
      var gkmh = speedKmh(DISTANCE_KM[distance], gs);
      goal = { time: formatTime(gs), speed_kmh: gkmh, level: levelForSpeed(distance, gkmh) };
      if (goal.level !== level) {
        notes.push("A meta de " + goal.time + " exige " + kmh1(gkmh) + " km/h, a faixa do nível " + LEVEL_LABEL[goal.level].toLowerCase() +
          ". A planilha usa a velocidade atual (prova recente) para o nível, não a meta.");
      }
    }
    events.forEach(function (e) {
      if (e.time_s) {
        e.speed_kmh = speedKmh(e.distance_km, e.time_s);
        e.speed_level = levelForSpeed(distance, e.speed_kmh);
        e.time = formatTime(e.time_s);
      }
      e.date_iso = e.date != null ? isoDate(e.date) : null;
      e.day_of_week = e.day == null ? (e.kind === "prova" ? longDay : tirosDay) : e.day;
    });
    events.filter(function (e) { return e.speed_level && e.speed_level !== level; }).forEach(function (e) {
      notes.push("O " + (e.kind === "prova" ? "resultado da prova" : "teste") + " da semana " + e.week + " (" + kmh1(e.speed_kmh) + " km/h) cai no nível " +
        LEVEL_LABEL[e.speed_level].toLowerCase() + ". A planilha não diz se o nível muda no meio do plano: para seguir a nova linha, gere um plano novo com esse resultado como prova recente.");
    });

    // Entradas do formulário sem regra.
    var unused = [];
    var terrain = plain(payload.terrain || "plano"), surface = plain(payload.surface || "asfalto");
    if (terrain !== "plano" || surface !== "asfalto" || !blank(payload.elevation_gain_m)) {
      unused.push("Percurso (" + terrain + ", " + surface + (blank(payload.elevation_gain_m) ? "" : ", D+ " + payload.elevation_gain_m + " m") + ")");
    } else unused.push("Percurso");
    unused.push("Volume (" + (blank(payload.volume) ? "padrão" : plain(payload.volume)) + ")");
    unused.push("Dificuldade dos treinos fortes");
    unused.push("Foco");
    if (!blank(payload.age)) unused.push("Idade");
    if (capMin) unused.push("Duração máxima do longão (só gera alerta)");
    if (goal) unused.push("Tempo-alvo (só informa a faixa de velocidade)");

    // --- Como o plano foi montado -------------------------------------------
    reasons.push(c.source === "velocidade"
      ? "Nível " + LEVEL_LABEL[level].toLowerCase() + " pela velocidade de nivelamento: " + c.speed_text + " = " + kmh1(c.speed_kmh) + " km/h (faixa " + R.speed_range + ")."
      : c.source === "manual"
        ? "Nível " + LEVEL_LABEL[level].toLowerCase() + ", escolhido no formulário." + (c.speed_level && c.speed_level !== level ? " Pela velocidade (" + kmh1(c.speed_kmh) + " km/h) seria " + LEVEL_LABEL[c.speed_level].toLowerCase() + "." : "")
        : "Nível " + LEVEL_LABEL[level].toLowerCase() + " pelo volume atual (complemento: sem prova recente, não há velocidade de nivelamento).");
    reasons.push("Linha " + R.line + " da planilha (" + SHEET_DISTANCE[distance] + ", " + LEVEL_LABEL[level].toLowerCase() + "): " + R.runs + " corridas e " + R.strength +
      " treinos de exercício resistido por semana; " + R.weeks + " semanas, mínimo " + R.min_weeks + ".");
    reasons.push("Distância semanal: " + km1(H) + " km, " + R.weekly_formula + ".");
    reasons.push("Divisão da semana: " + mix.sessions.map(function (s) {
      return (s.type === "longao" ? "longão (CL)" : SESSION[s.type].title.toLowerCase()) + " " + pct1(s.share);
    }).join(", ") + ". A média VSDL seria " + pct1(mix.equal) + " para cada corrida; CM e CF sobem até o mínimo e a diferença sai das sessões sem mínimo.");
    reasons.push("Tiros: " + pct1(mix.work) + " da semana (teto de 15% para IF + IM + IL), dentro de uma sessão de " + pct1(mix.tiros_share) + ".");
    reasons.push("Dias: " + runDays.map(function (d) {
      var t = typeByDay[d];
      return DAY_SHORT[d] + " " + (t === "longao" ? "longão" : t === "tiros" ? "tiros" : t === "leve" ? "rodagem leve" : SESSION[t].code);
    }).join(", ") + ". Exercício resistido: " + dayList(strength.days) +
      (strength.doubled.length ? " (" + dayList(strength.doubled) + " depois da corrida, por falta de dia livre)." : "."));
    reasons.push("Periodização " + M.label + " (" + M.name + "): começa em " + km1(startKm) + " km" +
      (reachedAt ? " e chega à regra na semana " + reachedAt + "." : " e não chega à regra antes do polimento."));
    reasons.push("Polimento (complemento): " + (taperFr.length === 1 ? "semana " + total : "semanas " + (nTrain + 1) + " a " + total) + " com " +
      taperFr.map(pct).join(", ") + " do pico; a prova entra no lugar do longão.");

    var plan = {
      version: VERSION,
      distance: distance, distance_label: DISTANCE_LABEL[distance], sheet_distance: SHEET_DISTANCE[distance], distance_km: DISTANCE_KM[distance],
      level: level, level_label: LEVEL_LABEL[level], level_source: c.source, speed_kmh: c.speed_kmh, speed_text: c.speed_text, speed_level: c.speed_level,
      rule: R, mix: mix, periodization: model, periodization_label: M.label, periodization_name: M.name,
      weeks_count: total, start_date: isoDate(start), race_date: isoDate(start + (total - 1) * 7 + raceDay), race_day: raceDay,
      by_date: byDate, run_days: runDays, marked_days: marked, long_day: longDay, type_by_day: typeByDay,
      strength_days: strength.days, strength_doubled: strength.doubled,
      start_km: round1(startKm), peak_km: round1(peak), peak_long_km: peakLong, reached_week: reachedAt,
      weeks: weeksPlan, events: events, prereq: prereq, next_phase: nextPhase, goal: goal,
      warnings: warnings, notes: notes, reasons: reasons, unused_inputs: unused
    };
    plan.markdown = toMarkdown(plan);
    return plan;
  }

  var PHASE_LABEL = { progressao: "Progressão", regra: "Volume da regra", polimento: "Polimento" };

  function itemText(x) {
    var head = x.title + (x.km ? " " + km1(x.km) + " km" : "");
    if (x.parts) head += " (" + x.parts.map(function (p) { return p.label + " " + km1(p.km); }).join(", ") + ")";
    else if (x.note) head += " (" + x.note + ")";
    return head;
  }

  function toMarkdown(plan) {
    var R = plan.rule, out = [];
    out.push("# Plano de " + plan.distance_label + " · " + plan.level_label);
    out.push("");
    out.push("- Linha " + R.line + " da planilha: " + km1(R.weekly_km) + " km/semana, " + R.runs + " corridas e " + R.strength + " treinos de exercício resistido");
    out.push("- Divisão da semana: " + plan.mix.sessions.map(function (s) {
      return (s.type === "longao" ? "longão (CL)" : SESSION[s.type].title.toLowerCase()) + " " + pct1(s.share);
    }).join(", ") + "; tiros " + pct1(plan.mix.work));
    out.push("- Periodização " + plan.periodization_label + "; " + plan.weeks_count + " semanas, de " + ddmm(parseIsoDate(plan.start_date), true) +
      " até a prova em " + ddmm(parseIsoDate(plan.race_date), true));
    plan.warnings.forEach(function (w) { out.push("- Atenção: " + w.text); });
    plan.weeks.forEach(function (w) {
      out.push("");
      out.push("## Semana " + w.number + " · " + PHASE_LABEL[w.phase] + (KIND_LABEL[w.kind] ? " (" + KIND_LABEL[w.kind].toLowerCase() + ")" : "") + " · " + km1(w.total_km) + " km");
      w.days.forEach(function (dd) {
        out.push("- " + DAY_SHORT[dd.day] + " " + ddmm(parseIsoDate(dd.date)) + ": " + dd.items.map(itemText).join(" + "));
      });
    });
    out.push("");
    out.push("Gerado pela engine de controle de volume " + VERSION + ".");
    return out.join("\n");
  }

  return {
    VERSION: VERSION, PlanError: PlanError, LEVELS: LEVELS, LEVEL_LABEL: LEVEL_LABEL, DISTANCES: DISTANCES,
    DISTANCE_KM: DISTANCE_KM, DISTANCE_LABEL: DISTANCE_LABEL, SHEET_DISTANCE: SHEET_DISTANCE, PHASE_LABEL: PHASE_LABEL,
    KIND_LABEL: KIND_LABEL, SESSION: SESSION, COACH: COACH, COMPLEMENT: COMPLEMENT, PREREQ: PREREQ, PERIODIZATIONS: PERIODIZATIONS,
    rule: rule, sheetTable: sheetTable, sessionMix: sessionMix, trainingCurve: trainingCurve,
    levelForSpeed: levelForSpeed, levelForVolume: levelForVolume,
    classify: classify, prereqStatus: prereqStatus, describeRules: describeRules,
    planFromPayload: planFromPayload, parseTime: parseTime, formatTime: formatTime
  };
});
