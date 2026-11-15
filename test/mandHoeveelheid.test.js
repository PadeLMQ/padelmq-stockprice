// Mandhoeveelheid x scenario — wat de klant werkelijk betaalt en wat de regel van Mathias vraagt.
// (codecontrole master-ai-kanaal #15, comment 6901355891)
//
// Werkwijze: per scenario draait de ECHTE ronde (reconcileAll) tegen een nagebootste Shopify.
// Daarna lezen we wat die ronde op het product zette (variantprijs + leveringsprofiel) en
// rekenen we de mand uit zoals de checkout dat doet: aantal x variantprijs + EEN verzendregel
// uit het profiel. De tarieven hieronder zijn de live gelezen profieltarieven van 15-11-2026
// (Master GET /api/verzendconfig, rapport S) en staan BEWUST alleen in deze test: de dienst
// rekent zelf geen verzendkost uit. Ze zijn niet in een echte checkout bewezen.
process.env.SHOPIFY_SHOP = "test.myshopify.com";
process.env.SHOPIFY_ADMIN_TOKEN = "test";
process.env.APPLY_CHANGES = "true"; // alleen tegen de nagebootste Shopify hieronder
delete process.env.SPAIN_FIRST_MIN_ES;

const test = require("node:test");
const assert = require("node:assert/strict");

const SERVER = require.resolve("../server.js");
function laad(minEs) {
  delete require.cache[SERVER];
  if (minEs == null) delete process.env.SPAIN_FIRST_MIN_ES; else process.env.SPAIN_FIRST_MIN_ES = String(minEs);
  const S = require(SERVER);
  delete process.env.SPAIN_FIRST_MIN_ES;
  return S;
}

const BE_LOC = "gid://shopify/Location/99030794589";
const SW_LOC = "gid://shopify/Location/111552692573";
const ES_LOC = "gid://shopify/Location/109744292189";
const PROFIEL = {
  "gid://shopify/DeliveryProfile/118956327261": "algemeen",
  "gid://shopify/DeliveryProfile/149705458013": "ballendozen",
};
const WILSON = "gid://shopify/Product/14923553866077";
const PRIJS = { A: 119.95, B: 109.95 };
const KG_PER_DOOS = 9.0; // Wilson, memory padelmq-iberia-staffel

// Eén verzendregel per mand, BE-klant (NL heeft dezelfde tarieven).
function verzendregel(profiel, aantal, subtotaal) {
  if (profiel === "ballendozen") {
    const kg = aantal * KG_PER_DOOS;
    return kg <= 9 ? 9.95 : kg <= 18 ? 14.95 : kg <= 27 ? 19.95 : 24.95;
  }
  if (profiel === "algemeen") return subtotaal >= 100 ? 0 : 9.95;
  throw new Error("geen profiel");
}
const r2 = (x) => Math.round(x * 100) / 100;

function maakShop({ be, es, spainFirst, state, price, profiel }) {
  const meta = { price_a: String(PRIJS.A), price_b: String(PRIJS.B), enabled: "true", locked: "false", state };
  if (spainFirst !== undefined) meta.spain_first = spainFirst;
  const shop = { meta, price, profiel, tags: [], mutaties: [], inventaris: { [BE_LOC]: be, [SW_LOC]: 0, [ES_LOC]: es } };
  global.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const ok = (data) => ({ json: async () => ({ data }) });
    if (query.includes("products(first:50")) {
      return ok({ products: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: {
        id: WILSON, title: "Wilson Premier Padel Speed - doos van 24 tubes", status: "ACTIVE", tags: shop.tags,
        metafields: { edges: Object.entries(shop.meta).map(([key, value]) => ({ node: { key, value } })) },
        variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/1", price: shop.price,
          inventoryItem: { inventoryLevels: { edges: Object.entries(shop.inventaris).map(([id, q]) => ({
            node: { location: { id }, quantities: [{ name: "available", quantity: q }] } })) } } } }] },
      } }] } });
    }
    shop.mutaties.push({ query, variables });
    if (/inventory/i.test(query) && query.trim().startsWith("mutation")) throw new Error("VOORRAADMUTATIE: mag nooit");
    if (query.includes("productVariantsBulkUpdate")) { shop.price = variables.v[0].price; return ok({ productVariantsBulkUpdate: { userErrors: [] } }); }
    if (query.includes("deliveryProfileUpdate")) { shop.profiel = PROFIEL[variables.id]; return ok({ deliveryProfileUpdate: { userErrors: [] } }); }
    if (query.includes("metafieldsSet")) { for (const m of variables.m) shop.meta[m.key] = m.value; return ok({ metafieldsSet: { userErrors: [] } }); }
    if (query.includes("metafieldsDelete")) { for (const m of variables.m) delete shop.meta[m.key]; return ok({ metafieldsDelete: { deletedMetafields: [], userErrors: [] } }); }
    if (query.includes("tagsAdd")) { shop.tags.push(...variables.t); return ok({ tagsAdd: { userErrors: [] } }); }
    if (query.includes("tagsRemove")) { shop.tags = shop.tags.filter((t) => !variables.t.includes(t)); return ok({ tagsRemove: { userErrors: [] } }); }
    if (query.includes("priceListFixedPricesAdd")) return ok({ priceListFixedPricesAdd: { userErrors: [] } });
    if (query.includes("publicationUpdate")) return ok({ publicationUpdate: { userErrors: [] } });
    throw new Error("onbekende query: " + query.slice(0, 80));
  };
  return shop;
}

// Wat de klant in de checkout betaalt, uit wat de ronde WERKELIJK op het product zette.
function checkout(shop, aantal) {
  if (shop.meta.state === "stock-leeg") return { uitverkocht: true };
  const sub = r2(aantal * Number(shop.price));
  const verzending = verzendregel(shop.profiel, aantal, sub);
  return { prijs: Number(shop.price), profiel: shop.profiel, verzendregels: [verzending], totaal: r2(sub + verzending) };
}
// Wat de regel van Mathias voor dit aantal vraagt, in euro.
function regelTotaal(S, aantal, be, es, spainFirst) {
  const r = S.regelVoorMand(aantal, be, es, spainFirst);
  if (!r.leverbaar) return { uitverkocht: true, termijn: null };
  const p = PRIJS[r.prijs];
  const sub = r2(aantal * p);
  return { prijs: p, profiel: r.profiel, totaal: r2(sub + verzendregel(r.profiel, aantal, sub)), termijn: r.termijn };
}

// Elke rij: scenario, voorraad, vinkje, drempel, en per aantal de verwachte uitkomst in de winkel.
// "klopt" = de winkel rekent wat de regel vraagt (prijs, verzending, termijn).
const MATRIX = [
  { naam: "vinkje UIT, BE 6 + ES 40 (huidige werking)", be: 6, es: 40, sf: "false", min: null, van: "stock-be",
    verwacht: { 1: [119.95, "algemeen", 119.95, "BE", true], 2: [119.95, "algemeen", 239.90, "BE", true], 4: [119.95, "algemeen", 479.80, "BE", true] } },
  { naam: "vinkje AAN, Spanje voldoende (BE 6 + ES 40)", be: 6, es: 40, sf: "true", min: null, van: "stock-be",
    verwacht: { 1: [109.95, "ballendozen", 119.90, "ES", true], 2: [109.95, "ballendozen", 234.85, "ES", true], 4: [109.95, "ballendozen", 464.75, "ES", true] } },
  { naam: "vinkje AAN, ES 1 + BE 6, drempel 1 (standaard)", be: 6, es: 1, sf: "true", min: null, van: "stock-be",
    verwacht: { 1: [109.95, "ballendozen", 119.90, "ES", true], 2: [109.95, "ballendozen", 234.85, "BE", false], 4: [109.95, "ballendozen", 464.75, "BE", false] } },
  { naam: "vinkje AAN, ES 1 + BE 6, drempel 4 (configureerbaar)", be: 6, es: 1, sf: "true", min: 4, van: "stock-es",
    verwacht: { 1: [119.95, "algemeen", 119.95, "BE", false], 2: [119.95, "algemeen", 239.90, "BE", true], 4: [119.95, "algemeen", 479.80, "BE", true] } },
  { naam: "vinkje AAN, ES 4 + BE 6, drempel 4", be: 6, es: 4, sf: "true", min: 4, van: "stock-be",
    verwacht: { 1: [109.95, "ballendozen", 119.90, "ES", true], 2: [109.95, "ballendozen", 234.85, "ES", true], 4: [109.95, "ballendozen", 464.75, "ES", true] } },
  { naam: "vinkje AAN, ES 0 + BE 6", be: 6, es: 0, sf: "true", min: null, van: "stock-es",
    verwacht: { 1: [119.95, "algemeen", 119.95, "BE", true], 2: [119.95, "algemeen", 239.90, "BE", true], 4: [119.95, "algemeen", 479.80, "BE", true] } },
  { naam: "vinkje AAN, beide 0", be: 0, es: 0, sf: "true", min: null, van: "stock-es",
    verwacht: { 1: null, 2: null, 4: null } },
];

for (const rij of MATRIX) {
  test(`matrix: ${rij.naam}`, async () => {
    const S = laad(rij.min);
    const beginPrijs = rij.van === "stock-be" ? String(PRIJS.A) : String(PRIJS.B);
    const beginProfiel = rij.van === "stock-be" ? "algemeen" : "ballendozen";
    const shop = maakShop({ be: rij.be, es: rij.es, spainFirst: rij.sf, state: rij.van, price: beginPrijs, profiel: beginProfiel });
    await S.reconcileAll();
    // de echte voorraad blijft onaangeroerd
    assert.equal(shop.mutaties.some((m) => /inventory(Set|Adjust|Move|Activate)/i.test(m.query)), false);
    assert.equal(shop.inventaris[BE_LOC], rij.be);
    // precies één verzendprofiel op de variant, en hoogstens één profielwrite in de ronde
    assert.ok(shop.mutaties.filter((m) => m.query.includes("deliveryProfileUpdate")).length <= 1);
    // precies één van de twee weergavetags (of geen bij uitverkocht)
    const tags = ["ballen_gratis", "ballen_toeslag"].filter((t) => shop.tags.includes(t));
    assert.equal(tags.length, shop.meta.state === "stock-leeg" ? 0 : 1);

    for (const [aantalTxt, exp] of Object.entries(rij.verwacht)) {
      const aantal = Number(aantalTxt);
      const co = checkout(shop, aantal);
      const m = S.mandKlopt(aantal, rij.be, rij.es, rij.sf === "true");
      const label = `${rij.naam}, ${aantal} doos/dozen`;
      if (exp === null) {
        assert.equal(co.uitverkocht, true, label);
        assert.equal(m.winkel.leverbaar, false, label);
        assert.equal(m.klopt, true, label);
        continue;
      }
      const [prijs, profiel, totaal, termijn, klopt] = exp;
      assert.equal(co.prijs, prijs, label + " prijs");
      assert.equal(co.profiel, profiel, label + " profiel");
      assert.equal(co.verzendregels.length, 1, label + " exact één verzendregel");
      assert.equal(co.totaal, totaal, label + " totaal");
      // de pure functie zegt hetzelfde als de echte ronde
      assert.equal(PRIJS[m.winkel.prijs], co.prijs, label + " winkelVoorMand = ronde");
      assert.equal(m.winkel.profiel, co.profiel, label + " winkelVoorMand = ronde (profiel)");
      assert.equal(m.winkel.termijn, termijn, label + " termijn");
      assert.equal(m.klopt, klopt, label + " klopt " + JSON.stringify(m.afwijkingen));
      // klopt <=> de klant betaalt exact wat de regel vraagt
      const rg = regelTotaal(S, aantal, rij.be, rij.es, rij.sf === "true");
      assert.equal(rg.totaal === co.totaal && rg.termijn === termijn, klopt, label + " regel " + JSON.stringify(rg));
    }
  });
}

test("ES 1 + BE 6, drempel 1: de mand naar 2 dozen kost de klant 234,85 i.p.v. 239,90 (regel) en vertrekt uit België", () => {
  const S = laad(null);
  const m = S.mandKlopt(2, 6, 1, true);
  assert.deepEqual(m.afwijkingen, ["prijs", "verzending"]);
  assert.equal(m.winkel.vertrek, "BE");
  assert.equal(m.regel.vertrek, "BE");
  assert.equal(S.mandKloptTot(6, 1, true), 1);
});

test("Spanje voldoende maar ook België voldoende: vertrek is NIET gegarandeerd (Shopify-orderrouting)", () => {
  const S = laad(null);
  const m = S.mandKlopt(2, 6, 40, true);
  assert.equal(m.klopt, true);
  assert.equal(m.winkel.vertrek, "routing");
  assert.equal(m.vertrekGegarandeerd, false);
  // zonder Belgische voorraad kan alleen Spanje: dan wel gegarandeerd
  assert.equal(S.mandKlopt(2, 0, 40, true).vertrekGegarandeerd, true);
});

test("drempel N: elke bestelling t/m N klopt zolang Spanje >= N; daarboven niet", () => {
  for (const n of [1, 2, 4, 6]) {
    const S = laad(n);
    assert.equal(S.SPAIN_FIRST_MIN_ES, n);
    assert.equal(S.mandKloptTot(6, n, true, n), Math.min(n, 10), `drempel ${n}`);
    // Spanje onder de drempel en België voorraad: elke hoeveelheid tot BE klopt, behalve wat
    // Spanje zelf volledig kon leveren (de regel vraagt daar Spanje)
    if (n > 1) assert.equal(S.mandKlopt(1, 6, n - 1, true, n).klopt, false, `drempel ${n}: 1 doos bij ES ${n - 1}`);
  }
});

test("Spanje aangevuld: ES 0 -> België; ES 24 -> terug naar Spanje, 1/2/4 dozen volgens de regel", async () => {
  const S = laad(null);
  const shop = maakShop({ be: 6, es: 0, spainFirst: "true", state: "stock-es", price: String(PRIJS.B), profiel: "ballendozen" });
  await S.reconcileAll();
  assert.equal(shop.meta.state, "stock-be");
  assert.deepEqual([1, 2, 4].map((q) => checkout(shop, q).totaal), [119.95, 239.90, 479.80]);
  shop.inventaris[ES_LOC] = 24;
  await S.reconcileAll();
  assert.equal(shop.meta.state, "stock-es");
  assert.equal(shop.meta.spain_first, "true");
  assert.deepEqual([1, 2, 4].map((q) => checkout(shop, q).totaal), [119.90, 234.85, 464.75]);
  for (const q of [1, 2, 4]) assert.equal(S.mandKlopt(q, 6, 24, true).klopt, true);
});

test("vinkje UIT: de vergelijking verandert niets aan de bestaande werking (altijd 'huidige_werking')", () => {
  const S = laad(null);
  for (const [be, es] of [[6, 40], [6, 0], [0, 40], [0, 0], [1, 3]]) for (const q of [1, 2, 4]) {
    const m = S.mandKlopt(q, be, es, false);
    assert.equal(m.klopt, true);
    if (m.regel.leverbaar !== false) assert.equal(m.regel.regel, "huidige_werking");
  }
});

test("GET /api/products geeft mandKloptTot mee (alleen lezen) en het dashboard waarschuwt", async () => {
  const S = laad(null);
  const shop = maakShop({ be: 6, es: 1, spainFirst: "true", state: "stock-es", price: String(PRIJS.B), profiel: "ballendozen" });
  await new Promise((res) => S.server.listen(0, res));
  try {
    const port = S.server.address().port;
    const body = await new Promise((res, rej) => {
      require("node:http").get(`http://127.0.0.1:${port}/api/products`, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej);
    });
    const j = JSON.parse(body);
    assert.equal(j.ok, true);
    assert.equal(j.rows[0].mandKloptTot, 1);
    assert.equal(j.rows[0].routeState, "stock-es");
    assert.equal(shop.mutaties.length, 0, "GET schrijft niets");
  } finally { await new Promise((res) => S.server.close(res)); }
  assert.match(S.PAGE, /mandKloptTot/);
});
