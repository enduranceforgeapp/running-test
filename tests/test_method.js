// Testes da engine do método. Uso: node tests/test_method.js
"use strict";
const assert = require("assert");
const path = require("path");
const E = require(path.join(__dirname, "..", "method_engine.js"));
const TODAY = "2026-10-07";
let passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { console.error("FALHOU: " + name + "\n" + e.stack); process.exitCode = 1; } }
const plan = (o) => E.planFromPayload(o, { today: TODAY });
const base = (extra) => Object.assign({ objetivo: "corrida", distancia: "42k", semanas: "18", horas_max: "8", dias: [1, 2, 3, 5, 6], duplos: true, idade: "38",
  corrida: { km_semana: "40", maior_corrida: "18", prova_km: "10", prova_tempo: "48:30" }, ciclismo: { horas: "4", ftp: "220", maior_pedal: "2" },
  natacao: { metros: "4000", css: "1:55" }, forca: { incluir: true, sessoes: 2 }, testes: true }, extra || {});
const items = (w) => w.days.flatMap((d) => d.items);

test("fases, polimento e tempo mínimo", () => {
  const p = plan(base());
  assert.strictEqual(p.weeks_count, 18);
  assert.deepStrictEqual([...new Set(p.phases)], ["base", "construcao", "especifico", "polimento"]);
  assert.strictEqual(p.phases.filter((x) => x === "polimento").length, 2);
  assert.strictEqual(p.start_date, "2026-10-12");
  assert.throws(() => plan(base({ semanas: "8" })), /pelo menos 12 semanas/);
  assert.throws(() => plan(base({ objetivo: "triathlon", distancia: "ironman", semanas: "10" })), /14 semanas/);
});

test("horas: começa no volume atual, respeita o teto e o alívio do 3:1", () => {
  const p = plan(base());
  p.weeks.forEach((w) => assert.ok(w.minutes_total <= 8 * 60 + 15 || w.is_race, "semana " + w.number + " " + w.minutes_total));
  assert.ok(p.start_hours < p.peak_hours);
  const w4 = p.weeks[3];
  assert.ok(w4.deload && w4.hours_target < p.weeks[2].hours_target * 0.75);
  for (let i = 1; i < p.weeks.length; i++) {
    const a = p.weeks[i - 1], b = p.weeks[i];
    if (!a.deload && !b.deload && b.phase !== "polimento") assert.ok(b.hours_target <= a.hours_target * 1.1 + 1e-6, "semana " + b.number);
  }
});

test("teto de impacto: km de corrida sobem no máximo 10% entre semanas de carga", () => {
  const p = plan(base({ corrida: { km_semana: "20", maior_corrida: "10", prova_km: "10", prova_tempo: "48:30" } }));
  let last = null;
  p.weeks.forEach((w) => { if (w.deload || w.phase === "polimento") return; if (last != null) assert.ok(w.run_km <= last * 1.1 + 0.15, "semana " + w.number + " " + w.run_km + " vs " + last); last = w.run_km; });
});

test("distribuição por fase segue o modelo (Z1 dominante no polarizado)", () => {
  const p = plan(base());
  p.weeks.filter((w) => w.phase === "base" && !w.deload).forEach((w) => assert.ok(w.zone_pct[0] >= 78, "base Z1 " + w.zone_pct));
  p.weeks.filter((w) => w.phase === "especifico").forEach((w) => { assert.strictEqual(w.model, "piramidal"); assert.ok(w.zone_pct[1] >= 12, "específico Z2"); });
  const lim = plan(base({ objetivo: "corrida", distancia: "10k", semanas: "8", horas_max: "4", dias: [1, 3, 6], duplos: false, nivel: "iniciante", corrida: { km_semana: "15", maior_corrida: "6" } }));
  assert.strictEqual(lim.model_by_phase[0], "limiar");
});

test("força: periodizada e nunca na véspera de corrida forte ou longa", () => {
  const p = plan(base());
  const contents = p.weeks.map((w) => w.strength_content);
  assert.deepStrictEqual(contents.slice(0, 3), ["adaptacao", "adaptacao", "adaptacao"]);
  assert.ok(contents.includes("forca") && contents.includes("potencia") && contents.includes("manutencao"));
  assert.strictEqual(contents[contents.length - 1], null);
  p.weeks.forEach((w) => {
    for (let d = 1; d < 7; d++) {
      const prev = w.days[d - 1].items, cur = w.days[d].items;
      const heavy = prev.some((x) => x.sport === "gym" && x.kind === "heavy");
      const hardRun = cur.some((x) => x.sport === "run" && (x.kind === "key" || x.kind === "long"));
      assert.ok(!(heavy && hardRun), "semana " + w.number + " dia " + d);
    }
  });
  assert.strictEqual(p.conflicts, 0);
});

test("semana da prova: prova no dia certo, soltura na véspera, nada depois", () => {
  const p = plan(base({ semanas: "", data_prova: "2027-02-13" })); // sábado
  const last = p.weeks[p.weeks.length - 1];
  assert.strictEqual(p.race_date, "2027-02-13");
  assert.ok(last.days[5].items.some((x) => x.race));
  assert.ok(last.days[4].items.some((x) => /Soltura/.test(x.title)));
  assert.strictEqual(last.days[6].items.length, 0);
  assert.ok(!items(last).some((x) => x.kind === "long"));
});

test("triathlon: três modalidades, bricks e corrida limitada", () => {
  const p = plan(base({ objetivo: "triathlon", distancia: "olimpico", semanas: "16", horas_max: "10", dias: [0, 1, 2, 3, 4, 5, 6] }));
  assert.deepStrictEqual(p.sports, ["swim", "bike", "run"]);
  const build = p.weeks.find((w) => w.phase === "construcao" && !w.deload);
  const bricks = items(build).filter((x) => x.brick_id);
  assert.ok(bricks.length >= 2 && bricks.some((x) => x.brick && x.sport === "run"));
  const dayOfBrick = build.days.find((d) => d.items.some((x) => x.brick));
  assert.ok(dayOfBrick.items.findIndex((x) => x.sport === "bike") < dayOfBrick.items.findIndex((x) => x.brick));
  p.weeks.filter((w) => !w.is_race).forEach((w) => assert.ok(w.minutes.run <= w.minutes_total * 0.4, "corrida semana " + w.number));
  assert.ok(p.race_pace.swim && p.race_pace.bike && p.race_pace.run);
});

test("duathlon: C–B–C no específico, corrida como modalidade principal", () => {
  const p = plan(base({ objetivo: "duathlon", distancia: "padrao", semanas: "12", horas_max: "7", dias: [1, 2, 3, 4, 5, 6], duplos: false }));
  const spec = p.weeks.filter((w) => w.phase === "especifico");
  const cbc = spec.some((w) => w.days.some((d) => d.items.length >= 3 && d.items[0].sport === "run" && d.items[1].sport === "bike" && d.items[2].sport === "run"));
  assert.ok(cbc, "C–B–C");
  assert.strictEqual(p.main, "run");
  assert.strictEqual(items(p.weeks[p.weeks.length - 1]).find((x) => x.race).sport, "run");
});

test("aquathlon e modalidades isoladas geram sem erro", () => {
  ["aquathlon:sprint", "ciclismo:gf100", "natacao:3k", "corrida:5k", "triathlon:ironman"].forEach((k) => {
    const [o, d] = k.split(":");
    const p = plan(base({ objetivo: o, distancia: d, semanas: d === "ironman" ? "20" : "12", horas_max: d === "ironman" ? "14" : "7" }));
    assert.ok(p.weeks.length > 0 && p.tsb_race > -5, k);
    p.weeks.forEach((w) => w.days.forEach((d) => d.items.forEach((x) => assert.ok(x.min > 0 && x.title, k))));
  });
});

test("alternado a partir dos 50 anos e matriz de compatibilidade", () => {
  const p = plan(base({ idade: "55" }));
  assert.strictEqual(p.periodization, "alternado");
  const heavy = { sport: "gym", kind: "heavy" }, runKey = { sport: "run", kind: "key", zone: "Z3" }, swimEasy = { sport: "swim", kind: "easy", zone: "Z1" };
  assert.strictEqual(E.verdict(heavy, runKey)[0], "no");
  assert.strictEqual(E.verdict(runKey, heavy)[0], "mid");
  assert.strictEqual(E.verdict(heavy, swimEasy)[0], "ok");
});

test("carga: CTL, ATL e TSB coerentes", () => {
  const p = plan(base());
  assert.strictEqual(p.series.length, p.weeks_count * 7);
  p.weeks.forEach((w) => assert.ok(Math.abs(w.tsb - (w.ctl - w.atl)) <= 1));
  assert.ok(p.tsb_race >= 5 && p.tsb_race <= 35, "TSB " + p.tsb_race);
});

console.log(passed + " testes passaram");
