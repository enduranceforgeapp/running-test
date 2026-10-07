// Testes da engine de controle de volume. Uso: node tests/test_engine.js
"use strict";
const assert = require("assert");
const path = require("path");
const E = require(path.join(__dirname, "..", "volume_engine.js"));
const SHEET = require(path.join(__dirname, "planilha_valores.json"));

const TODAY = "2026-10-07"; // quarta: o plano começa na segunda 12/10/2026
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error("FALHOU: " + name + "\n" + e.stack); process.exitCode = 1; }
}
function base(extra) {
  return Object.assign({
    distance: "10k", weeks: "", race_date: "", weekly_km: "30", longest_run_km: "9",
    run_days: "1,2,3,5,6", long_run_day: "", recent_distance: "5", recent_time: "25:00",
    goal_time: "", level: "auto", events: [], pace_tests: ""
  }, extra || {});
}
function plan(extra) { return E.planFromPayload(base(extra), { today: TODAY }); }
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("tabela da engine = fórmulas da planilha (25 linhas)", () => {
  const table = E.sheetTable();
  assert.strictEqual(table.length, SHEET.length);
  table.forEach((r, i) => {
    const s = SHEET[i];
    assert.strictEqual(r.line, s.linha, "linha");
    assert.strictEqual(r.runs, s.sessoes_corrida, "corridas linha " + s.linha);
    assert.strictEqual(r.strength, s.sessoes_resistido, "resistido linha " + s.linha);
    assert.strictEqual(r.weeks, parseInt(s.semanas, 10), "semanas linha " + s.linha);
    assert.strictEqual(r.min_weeks, parseInt(s.tempo_minimo, 10), "mínimo linha " + s.linha);
    assert.ok(near(r.weekly_km, s.distancia_semanal), "H linha " + s.linha);
    assert.ok(near(r.long_km, s.longao), "I linha " + s.linha);
    assert.ok(near(r.vsdl_km, s.vsdl), "J linha " + s.linha);
    assert.ok(near(r.avg_km, s.media_vsdl), "K linha " + s.linha);
  });
});

test("nível pela velocidade, com faixas diferentes do 21 km em diante", () => {
  assert.strictEqual(E.levelForSpeed("5k", 7.99), "principiante");
  assert.strictEqual(E.levelForSpeed("5k", 8), "iniciante");
  assert.strictEqual(E.levelForSpeed("10k", 11.99), "iniciante");
  assert.strictEqual(E.levelForSpeed("10k", 12), "intermediario");
  assert.strictEqual(E.levelForSpeed("21k", 9.5), "principiante");
  assert.strictEqual(E.levelForSpeed("42k", 10), "iniciante");
  assert.strictEqual(E.levelForSpeed("50k", 14), "avancado");
  assert.strictEqual(E.levelForSpeed("50k", 16), "elite");
  const c = E.classify(base({ recent_distance: "10", recent_time: "48:30" }));
  assert.strictEqual(c.level, "intermediario"); // 12,37 km/h
  assert.strictEqual(c.source, "velocidade");
});

test("sem prova recente o nível vem do volume; nível manual tem prioridade", () => {
  assert.strictEqual(E.classify(base({ recent_distance: "", recent_time: "" })).level, "principiante"); // 30 km < 32,4
  assert.strictEqual(E.classify(base({ recent_distance: "", weekly_km: "40" })).level, "intermediario");
  assert.strictEqual(E.classify(base({ level: "elite" })).level, "elite");
});

test("plano padrão: semanas, corridas e força da linha", () => {
  const p = plan();
  const R = p.rule;
  assert.strictEqual(p.level, "intermediario");
  assert.strictEqual(p.weeks_count, 16);
  assert.strictEqual(p.start_date, "2026-10-12");
  assert.strictEqual(p.race_date, "2027-01-31");
  assert.deepStrictEqual(p.run_days.length, R.runs);
  p.weeks.slice(0, -1).forEach((w) => {
    assert.strictEqual(w.run_count, R.runs, "corridas semana " + w.number);
    assert.strictEqual(w.strength_count, R.strength, "força semana " + w.number);
    assert.ok(Math.abs(w.total_km - w.target_km) < 0.051, "total semana " + w.number);
    const long = w.days.flatMap((d) => d.items).find((x) => x.type === "longao");
    assert.ok(Math.abs(long.km - w.target_km * R.long_pct) < 0.006, "longão semana " + w.number);
  });
  const atRule = p.weeks.filter((w) => w.phase === "regra" && !w.is_cutback);
  assert.ok(atRule.length > 0);
  atRule.forEach((w) => assert.ok(near(w.target_km, R.weekly_km)));
  const race = p.weeks[p.weeks.length - 1];
  assert.ok(race.days.flatMap((d) => d.items).some((x) => x.type === "prova" && x.km === 10));
  assert.ok(!race.days.flatMap((d) => d.items).some((x) => x.type === "longao"));
});

const r1 = (x) => Math.round(x * 10) / 10;

test("3:1: três semanas de manutenção e uma de aumento de até 30%, em degraus até a regra", () => {
  const curve = E.trainingCurve("3:1", 12, 30, 46.6).map((w) => r1(w.target));
  assert.deepStrictEqual(curve, [30, 30, 30, 39, 39, 39, 39, 46.6, 46.6, 46.6, 46.6, 46.6]);
  const p = plan({ weekly_km: "20", periodization: "3:1" });
  p.weeks.filter((w) => w.phase !== "polimento").forEach((w, i, all) => {
    assert.ok(w.target_km <= p.rule.weekly_km + 1e-9);
    if (i === 0) return;
    const growth = w.target_km / all[i - 1].target_km - 1;
    if (w.number % 4 === 0) assert.ok(growth <= 0.30 + 1e-9, "semana " + w.number);
    else assert.ok(Math.abs(growth) < 1e-9, "semana " + w.number + " deveria manter");
  });
});

test("alternado: acréscimo de até 10% e regenerativa que volta ao patamar", () => {
  const curve = E.trainingCurve("alternado", 9, 30, 46.6);
  assert.deepStrictEqual(curve.map((w) => r1(w.target)), [30, 33, 30, 33, 33, 36.3, 33, 36.3, 36.3]);
  assert.deepStrictEqual(curve.slice(0, 4).map((w) => w.kind), ["inicio", "acrescimo", "regenerativa", "acrescimo"]);
  const p = plan({ weekly_km: "20", periodization: "alternado" });
  p.weeks.filter((w) => w.phase !== "polimento").forEach((w, i, all) => {
    assert.ok(w.target_km <= p.rule.weekly_km + 1e-9);
    if (i > 0) assert.ok(w.target_km <= all[i - 1].target_km * 1.1 + 1e-9, "semana " + w.number);
  });
  assert.strictEqual(r1(E.trainingCurve("alternado", 8, 38.8, 38.8)[1].target), 38.8); // na regra, não sobe mais
});

test("divisão da semana: mínimos dos contínuos e teto dos tiros", () => {
  E.sheetTable().forEach((r) => {
    const m = r.mix, by = {};
    m.sessions.forEach((s) => { by[s.type] = s.share; });
    const sum = m.sessions.reduce((a, s) => a + s.share, 0);
    assert.ok(near(sum, 1), "soma linha " + r.line);
    assert.strictEqual(m.sessions.length, r.runs);
    assert.ok(near(by.longao, r.long_pct));
    assert.ok(by.cm >= 0.25 - 1e-9, "CM linha " + r.line);
    if (r.runs === 3) assert.ok(!("cf" in by));
    else assert.ok(by.cf >= 0.20 - 1e-9, "CF linha " + r.line);
    assert.ok(m.work <= 0.15 + 1e-9 && m.part <= 0.05 + 1e-9 && 2 * m.part <= 0.10 + 1e-9, "tiros linha " + r.line);
    assert.ok(m.work < by.tiros, "aquecimento linha " + r.line);
    m.sessions.forEach((s) => assert.ok(s.share > 0, s.type + " linha " + r.line));
  });
  const m = E.rule("10k", "intermediario").mix; // 4 corridas: 30 / 25 / 23,3 / 21,7
  assert.deepStrictEqual(m.sessions.map((s) => [s.type, r1(s.share * 100)]), [["longao", 30], ["cm", 25], ["cf", 23.3], ["tiros", 21.7]]);
});

test("treinos fortes longe uns dos outros e sessão de tiros completa", () => {
  const p = plan();
  const order = [0, 1, 2, 3, 4, 5, 6].map((d) => p.type_by_day[d] || "");
  const w = { tiros: 3, cf: 2, longao: 2 };
  for (let d = 0; d < 7; d++) assert.ok(!(w[order[d]] && w[order[(d + 1) % 7]]), "dias " + d + " e " + (d + 1));
  const t = p.weeks[4].days.flatMap((d) => d.items).find((x) => x.type === "tiros");
  assert.ok(Math.abs(t.parts.reduce((a, x) => a + x.km, 0) - t.km) < 0.02);
  assert.deepStrictEqual(t.parts.map((x) => x.label), ["Aquecimento", "IF", "IM", "IL", "Desaquecimento"]);
});

test("abaixo do tempo mínimo o plano não é gerado", () => {
  assert.throws(() => plan({ weeks: "7" }), /tempo mínimo .* 8 semanas/);
  assert.throws(() => plan({ distance: "42k", weekly_km: "70", longest_run_km: "25", weeks: "15" }), /16 semanas/);
  assert.doesNotThrow(() => plan({ weeks: "8" }));
});

test("menos dias marcados que corridas da linha", () => {
  assert.throws(() => plan({ run_days: "1,3,6" }), /4 corridas/);
});

test("pré-requisito da distância", () => {
  const bad = plan({ distance: "42k", weekly_km: "40", longest_run_km: "18" });
  assert.ok(bad.warnings.some((w) => w.code === "prereq"));
  assert.strictEqual(bad.prereq.met, false);
  const ok = plan({ distance: "21k", weekly_km: "47", longest_run_km: "11.1" }); // 11,1 >= 95% de 11,6
  assert.strictEqual(ok.prereq.met, true);
  const strict = plan({ distance: "42k", weekly_km: "70", longest_run_km: "21" }); // "maior que 21"
  assert.strictEqual(strict.prereq.long_ok, false);
  assert.strictEqual(plan({ distance: "5k" }).prereq, null);
});

test("data da prova: semanas contadas até ela e prova no dia certo", () => {
  const p = plan({ race_date: "2027-01-30", weeks: "" }); // sábado
  assert.strictEqual(p.weeks_count, 16);
  assert.strictEqual(p.race_date, "2027-01-30");
  const last = p.weeks[p.weeks.length - 1];
  assert.strictEqual(last.days[5].items[0].type, "prova");
  assert.strictEqual(last.days[6].items[0].type, "descanso");
  assert.throws(() => plan({ race_date: "2026-11-20" }), /tempo mínimo/);
});

test("força dobra com a corrida quando faltam dias livres", () => {
  const p = plan({ distance: "50k", weekly_km: "95", longest_run_km: "45", recent_distance: "10", recent_time: "48:00",
                   run_days: "0,1,2,3,4,5,6" }); // intermediário: 5 corridas e 4 de força
  assert.strictEqual(p.rule.runs, 5);
  assert.strictEqual(p.rule.strength, 4);
  assert.strictEqual(p.strength_doubled.length, 2);
  assert.ok(!p.strength_doubled.includes(p.long_day));
});

test("provas, testes e testes automáticos", () => {
  const p = plan({ events: [{ kind: "prova", week: "6", distance_km: "5", time: "23:00" }], pace_tests: "1" });
  const w6 = p.weeks[5].days.flatMap((d) => d.items);
  assert.ok(w6.some((x) => x.type === "prova" && x.km === 5));
  assert.ok(!w6.some((x) => x.type === "longao"));
  assert.ok(p.events.some((e) => e.auto && e.week === 7)); // a semana 6 já tem a prova: o teste vai para a 7
  const alt = plan({ periodization: "alternado", pace_tests: "1", weekly_km: "30" });
  alt.events.forEach((e) => assert.ok(alt.weeks[e.week - 1].days.some((d) => d.items.some((x) => x.type === "teste"))));
  assert.strictEqual(p.events.find((e) => !e.auto).speed_level, "intermediario"); // 13,0 km/h
});

test("linhas em que o longão é menor que as outras corridas geram aviso", () => {
  const p = plan({ distance: "5k", weekly_km: "10", longest_run_km: "4", recent_distance: "5", recent_time: "40:00",
                   run_days: "1,3,6" });
  assert.strictEqual(p.level, "principiante");
  assert.ok(p.warnings.some((w) => w.level === "info" && /fica menor que/.test(w.text)));
});

console.log(passed + " testes passaram");
