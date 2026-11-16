// SPAIN_FIRST_MODE=korting — de productroute voor de Discount Function padelmq-ballendoos-spanje
// (app PadeLMQ Master Discounts, tak ballendoos-spanje-korting in padelmq-pro). Standaard = de
// bestaande werking; deze proeven bewijzen dat eerst, en daarna wat de nieuwe modus schrijft.
process.env.SHOPIFY_SHOP = "test.myshopify.com";
process.env.SHOPIFY_ADMIN_TOKEN = "test";
process.env.APPLY_CHANGES = "true"; // alleen tegen de nagebootste Shopify hieronder
delete process.env.SPAIN_FIRST_MIN_ES;
delete process.env.SPAIN_FIRST_MODE;

const test = require("node:test");
const assert = require("node:assert/strict");

const SERVER = require.resolve("../server.js");
function laad(modus) {
  delete require.cache[SERVER];
  if (modus == null) delete process.env.SPAIN_FIRST_MODE; else process.env.SPAIN_FIRST_MODE = modus;
  const S = require(SERVER);
  delete process.env.SPAIN_FIRST_MODE;
  return S;
}

const BE_LOC = "gid://shopify/Location/99030794589";
const ES_LOC = "gid://shopify/Location/109744292189";
const ALGEMEEN = "gid://shopify/DeliveryProfile/118956327261";
const WILSON = "gid://shopify/Product/14923553866077";
const RASTER = [];
for (const be of [0, 1, 6]) for (const es of [0, 1, 4, 40]) for (const sf of [false, true]) RASTER.push([be, es, sf]);

test("standaard (geen variabele) is modus route en exact de bestaande beslisregel", () => {
  const S = laad(null);
  assert.equal(S.SPAIN_FIRST_MODE, "route");
  const K = laad("korting");
  for (const [be, es, sf] of RASTER) {
    assert.deepEqual(S.decideRoute(be, es, sf), S.decideRoute(be, es, sf, S.SPAIN_FIRST_MIN_ES, "route"), `${be}/${es}/${sf}`);
    // ook in de korting-build geeft een expliciete "route" het oude antwoord
    assert.deepEqual(K.decideRoute(be, es, sf, 1, "route"), S.decideRoute(be, es, sf), `${be}/${es}/${sf}`);
  }
  assert.deepEqual(S.decideRoute(6, 1, true), { state: "stock-es", reason: "spanje_eerst" });
});

test("alleen de exacte waarde 'korting' zet de modus aan", () => {
  for (const v of ["Korting", "KORTING", "1", "true", "aan", ""]) assert.equal(laad(v).SPAIN_FIRST_MODE, "route", v);
  assert.equal(laad("korting").SPAIN_FIRST_MODE, "korting");
});

test("modus korting: BE > 0 blijft België met reden spanje_eerst_korting; BE = 0 ongewijzigd", () => {
  const S = laad("korting");
  assert.deepEqual(S.decideRoute(6, 1, true), { state: "stock-be", reason: "spanje_eerst_korting" });
  assert.deepEqual(S.decideRoute(6, 40, true), { state: "stock-be", reason: "spanje_eerst_korting" });
  assert.deepEqual(S.decideRoute(6, 0, true), { state: "stock-be", reason: "spanje_leeg" });
  assert.deepEqual(S.decideRoute(0, 40, true), { state: "stock-es", reason: "alleen_spanje" });
  assert.deepEqual(S.decideRoute(0, 0, true), { state: "stock-leeg", reason: "beide_leeg" });
  assert.ok(S.REDEN_TEKST.spanje_eerst_korting);
});

test("modus korting, vinkje UIT: identiek aan de bestaande werking", () => {
  const S = laad("korting");
  const R = laad(null);
  for (const [be, es] of RASTER) assert.deepEqual(S.decideRoute(be, es, false), R.decideRoute(be, es, false));
});

test("mand ES1/BE6 in modus korting: 1 doos prijs B + doosverzending (termijn nog BE), 2 en 4 dozen België", () => {
  const S = laad("korting");
  const m1 = S.mandKlopt(1, 6, 1, true);
  assert.equal(m1.winkel.prijs, "B");
  assert.equal(m1.winkel.profiel, "ballendozen");
  assert.equal(m1.winkel.via, "korting");
  assert.deepEqual(m1.afwijkingen, ["termijn"]); // het thema kent de reden nog niet
  for (const q of [2, 4]) {
    const m = S.mandKlopt(q, 6, 1, true);
    assert.equal(m.klopt, true, `q=${q} ${JSON.stringify(m.afwijkingen)}`);
    assert.equal(m.winkel.prijs, "A");
  }
  // ter vergelijking, de bestaande modus: 2 en 4 dozen wijken af op prijs en verzending
  const R = laad(null);
  assert.deepEqual(R.mandKlopt(2, 6, 1, true).afwijkingen, ["prijs", "verzending"]);
});

test("mand met Spanje aangevuld (ES 40) in modus korting: prijs en verzending kloppen voor 1/2/4", () => {
  const S = laad("korting");
  for (const q of [1, 2, 4]) {
    const m = S.mandKlopt(q, 6, 40, true);
    assert.equal(m.winkel.prijs, "B");
    assert.deepEqual(m.afwijkingen, ["termijn"]);
  }
  // boven de afkap van es_qty (10) geeft de Function niets: dan België (A), wat de regel niet vraagt
  assert.equal(S.mandKlopt(11, 20, 40, true).winkel.prijs, "A");
});

function maakShop({ be, es, state, price, profiel }) {
  const meta = { price_a: "119.95", price_b: "109.95", enabled: "true", locked: "false", state, spain_first: "true" };
  const shop = { meta, price, profiel, tags: ["ballen_toeslag"], mutaties: [], inventaris: { [BE_LOC]: be, [ES_LOC]: es } };
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
    if (query.includes("deliveryProfileUpdate")) { shop.profiel = variables.id; return ok({ deliveryProfileUpdate: { userErrors: [] } }); }
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

test("ronde in modus korting (BE 6, ES 1, was route Spanje): prijs A, profiel Algemeen, reden en es_qty voor de Function", async () => {
  const S = laad("korting");
  const shop = maakShop({ be: 6, es: 1, state: "stock-es", price: "109.95", profiel: "ballendozen" });
  await S.reconcileAll();
  assert.equal(shop.price, "119.95");
  assert.equal(shop.profiel, ALGEMEEN);
  assert.equal(shop.meta.state, "stock-be");
  assert.equal(shop.meta.route_reason, "spanje_eerst_korting");
  assert.equal(shop.meta.es_qty, "1");
  assert.equal(shop.meta.spain_first, "true");
  assert.ok(shop.tags.includes("ballen_gratis"));
  assert.equal(shop.inventaris[BE_LOC], 6);
  assert.equal(shop.mutaties.some((m) => /inventory(Set|Adjust|Move|Activate)/i.test(m.query)), false);
});

test("dezelfde ronde zonder variabele: de bestaande werking (route Spanje, prijs B)", async () => {
  const S = laad(null);
  const shop = maakShop({ be: 6, es: 1, state: "stock-es", price: "109.95", profiel: "ballendozen" });
  await S.reconcileAll();
  assert.equal(shop.price, "109.95");
  assert.equal(shop.meta.state, "stock-es");
  assert.equal(shop.meta.route_reason, "spanje_eerst");
});

test("terugzetten: variabele weg -> de volgende ronde zet de doos terug op route Spanje", async () => {
  const K = laad("korting");
  const shop = maakShop({ be: 6, es: 1, state: "stock-es", price: "109.95", profiel: "ballendozen" });
  await K.reconcileAll();
  assert.equal(shop.meta.state, "stock-be");
  const R = laad(null);
  await R.reconcileAll();
  assert.equal(shop.meta.state, "stock-es");
  assert.equal(shop.price, "109.95");
  assert.equal(shop.meta.route_reason, "spanje_eerst");
});
