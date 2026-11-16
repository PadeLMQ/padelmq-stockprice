// Spanje eerst, ook bij Belgische voorraad — tests zonder Shopify (node --test).
// Shopify wordt volledig nagebootst via een vervangen global fetch: elke mutatie wordt
// vastgelegd, zodat bewezen kan worden wat er WEL en NIET geschreven wordt.
process.env.SHOPIFY_SHOP = "test.myshopify.com";
process.env.SHOPIFY_ADMIN_TOKEN = "test";
process.env.APPLY_CHANGES = "true"; // alleen tegen de nagebootste Shopify hieronder
delete process.env.SPAIN_FIRST_MIN_ES;

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server.js");

const BE_LOC = "gid://shopify/Location/99030794589";
const SW_LOC = "gid://shopify/Location/111552692573";
const ES_LOC = "gid://shopify/Location/109744292189";
const PROFIEL_ALGEMEEN = "gid://shopify/DeliveryProfile/118956327261";
const PROFIEL_BALLEN = "gid://shopify/DeliveryProfile/149705458013";
const WILSON = "gid://shopify/Product/14923553866077";

// ---------- nagebootste Shopify ----------
function maakShop({ be, es, sw = 0, spainFirst, state = "", price = "119.95", extraMeta = {} }) {
  const meta = { price_a: "119.95", price_b: "109.95", enabled: "true", locked: "false", state, ...extraMeta };
  if (spainFirst !== undefined) meta.spain_first = spainFirst;
  const shop = {
    meta, price, tags: [], mutaties: [], inventaris: { [BE_LOC]: be, [SW_LOC]: sw, [ES_LOC]: es },
  };
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
    if (query.includes("productVariantsBulkUpdate")) { shop.price = variables.v[0].price; return ok({ productVariantsBulkUpdate: { userErrors: [] } }); }
    if (query.includes("deliveryProfileUpdate")) return ok({ deliveryProfileUpdate: { userErrors: [] } });
    if (query.includes("metafieldsSet")) { for (const m of variables.m) shop.meta[m.key] = m.value; return ok({ metafieldsSet: { userErrors: [] } }); }
    if (query.includes("metafieldsDelete")) { for (const m of variables.m) delete shop.meta[m.key]; return ok({ metafieldsDelete: { deletedMetafields: [], userErrors: [] } }); }
    if (query.includes("tagsAdd")) { shop.tags.push(...variables.t); return ok({ tagsAdd: { userErrors: [] } }); }
    if (query.includes("tagsRemove")) { shop.tags = shop.tags.filter((t) => !variables.t.includes(t)); return ok({ tagsRemove: { userErrors: [] } }); }
    if (query.includes("priceListFixedPricesAdd")) return ok({ priceListFixedPricesAdd: { userErrors: [] } });
    if (query.includes("publicationUpdate")) return ok({ publicationUpdate: { userErrors: [] } });
    if (/inventory/i.test(query) && query.trim().startsWith("mutation")) throw new Error("VOORRAADMUTATIE: mag nooit");
    throw new Error("onbekende query: " + query.slice(0, 80));
  };
  return shop;
}
const profielVan = (shop) => shop.mutaties.filter((m) => m.query.includes("deliveryProfileUpdate")).map((m) => m.variables.id);
const geenVoorraadMutatie = (shop) => assert.equal(shop.mutaties.some((m) => /inventory(Set|Adjust|Move|Activate)/i.test(m.query)), false);

// ---------- de beslisregel ----------
test("vinkje UIT: decideRoute is exact de bestaande decideState", () => {
  for (const be of [-1, 0, 1, 6]) for (const es of [-2, 0, 1, 40]) {
    assert.equal(S.decideRoute(be, es, false).state, S.decideState(be, es), `be=${be} es=${es}`);
  }
});

test("vinkje AAN: Spanje genoeg -> Spanje, ook met Belgische voorraad", () => {
  assert.deepEqual(S.decideRoute(6, 12, true), { state: "stock-es", reason: "spanje_eerst" });
  assert.deepEqual(S.decideRoute(0, 12, true), { state: "stock-es", reason: "spanje_eerst" });
});

test("vinkje AAN: Spanje leeg of te weinig en BE kan -> België, prijs A", () => {
  assert.deepEqual(S.decideRoute(6, 0, true), { state: "stock-be", reason: "spanje_leeg" });
  assert.deepEqual(S.decideRoute(6, -3, true), { state: "stock-be", reason: "spanje_leeg" });
  assert.deepEqual(S.decideRoute(6, 1, true, 2), { state: "stock-be", reason: "spanje_te_weinig" });
});

test("vinkje AAN: beide leeg -> uitverkocht; enkel Spanje onder de drempel -> nog steeds Spanje", () => {
  assert.deepEqual(S.decideRoute(0, 0, true), { state: "stock-leeg", reason: "beide_leeg" });
  assert.deepEqual(S.decideRoute(-1, 0, true), { state: "stock-leeg", reason: "beide_leeg" });
  assert.deepEqual(S.decideRoute(0, 1, true, 4), { state: "stock-es", reason: "alleen_spanje" });
});

test("de standaarddrempel is 1 (letterlijk: Spanje heeft voorraad)", () => {
  assert.equal(S.SPAIN_FIRST_MIN_ES, 1);
  assert.equal(S.decideRoute(6, 1, true).state, "stock-es");
});

test("elke reden heeft een tekst voor Master en het dashboard", () => {
  for (const r of ["belgie_voorraad", "alleen_spanje", "spanje_eerst", "spanje_te_weinig", "spanje_leeg", "beide_leeg"]) {
    assert.ok(S.REDEN_TEKST[r] && S.REDEN_TEKST[r].length > 10, r);
  }
});

// Vervangt de oude mandRoute-test, die "2 dozen bij ES=1/BE=6 = vertrek BE met prijs B" als
// GOED vastlegde. De regel van Mathias vraagt daar België met prijs A en gratis verzending.
// Met de standaarddrempel 1 doet de winkel dat NIET: dat is nu een benoemde afwijking.
test("mand: 1 -> 2 dozen terwijl Spanje er 1 heeft: regel = België prijs A; winkel (drempel 1) = prijs B -> afwijking", () => {
  assert.deepEqual(S.regelVoorMand(2, 6, 1, true), { prijs: "A", profiel: "algemeen", termijn: "BE", vertrek: "BE", leverbaar: true, regel: "spanje_te_weinig_belgie" });
  const m1 = S.mandKlopt(1, 6, 1, true);
  assert.equal(m1.klopt, true);
  const m2 = S.mandKlopt(2, 6, 1, true);
  assert.equal(m2.klopt, false);
  assert.deepEqual(m2.afwijkingen, ["prijs", "verzending"]);
  assert.equal(m2.winkel.prijs, "B");
  assert.equal(m2.winkel.vertrek, "BE");
  assert.equal(S.mandKloptTot(6, 1, true), 1);
  assert.equal(S.mandKlopt(9, 6, 1, true).winkel.leverbaar, false);
  assert.equal(S.mandKlopt(1, 0, 0, true).winkel.leverbaar, false);
});

test("es_qty voor het thema: afgekapt op 10, negatief = 0", () => {
  assert.equal(S.esQtyLabel(-4), "0");
  assert.equal(S.esQtyLabel(3), "3");
  assert.equal(S.esQtyLabel(457), "10");
});

test("POST: een ontbrekende spainFirst-sleutel laat het vinkje ongemoeid", () => {
  assert.deepEqual(S.spainFirstVeld({ id: "x", priceA: "1" }), {});
  assert.deepEqual(S.spainFirstVeld({ spainFirst: true }), { spain_first: "true" });
  assert.deepEqual(S.spainFirstVeld({ spainFirst: false }), { spain_first: "false" });
  assert.deepEqual(S.spainFirstVeld({ spainFirst: "true" }), { spain_first: "true" });
});

// ---------- de schrijver (reconcileAll) tegen een nagebootste Shopify ----------
test("Wilson, vinkje UIT, BE 6 + ES 40: blijft België, prijs A, niets gewijzigd", async () => {
  const shop = maakShop({ be: 6, es: 40, state: "stock-be", extraMeta: { route_reason: "belgie_voorraad", es_qty: "10", eu_state: "on:109.95" } });
  const [r] = await S.reconcileAll();
  assert.equal(r.to, "stock-be");
  assert.equal(r.action, "geen wissel");
  assert.equal(shop.price, "119.95");
  assert.deepEqual(profielVan(shop), []);
  geenVoorraadMutatie(shop);
});

test("Wilson, vinkje AAN, BE 6 + ES 40: Spanje, prijs B 109,95, profiel Ballendozen, BE-voorraad onaangeroerd", async () => {
  const shop = maakShop({ be: 6, es: 40, spainFirst: "true", state: "stock-be" });
  const [r] = await S.reconcileAll();
  assert.equal(r.to, "stock-es");
  assert.equal(r.reason, "spanje_eerst");
  assert.equal(shop.price, "109.95");
  assert.deepEqual(profielVan(shop), [PROFIEL_BALLEN]);
  assert.equal(shop.meta.state, "stock-es");
  assert.equal(shop.meta.route_reason, "spanje_eerst");
  assert.equal(shop.meta.es_qty, "10");
  assert.ok(shop.tags.includes("ballen_toeslag") && !shop.tags.includes("ballen_gratis"));
  assert.equal(shop.inventaris[BE_LOC], 6);
  geenVoorraadMutatie(shop);
});

test("omschakeling in beide richtingen: Spanje op -> België (A), aangevuld -> terug naar Spanje (B), vinkje blijft", async () => {
  const shop = maakShop({ be: 6, es: 1, spainFirst: "true", state: "" });
  await S.reconcileAll();
  assert.equal(shop.meta.state, "stock-es");
  assert.equal(shop.price, "109.95");

  shop.inventaris[ES_LOC] = 0; // Spanje uitverkocht
  shop.mutaties = [];
  const [r2] = await S.reconcileAll();
  assert.equal(r2.to, "stock-be");
  assert.equal(r2.reason, "spanje_leeg");
  assert.equal(shop.price, "119.95");
  assert.deepEqual(profielVan(shop), [PROFIEL_ALGEMEEN]);
  assert.ok(shop.tags.includes("ballen_gratis"));
  assert.equal(shop.meta.spain_first, "true");

  shop.inventaris[ES_LOC] = 24; // Spanje aangevuld
  shop.mutaties = [];
  const [r3] = await S.reconcileAll();
  assert.equal(r3.to, "stock-es");
  assert.equal(shop.price, "109.95");
  assert.deepEqual(profielVan(shop), [PROFIEL_BALLEN]);
  assert.equal(shop.meta.spain_first, "true");
  geenVoorraadMutatie(shop);
});

test("beide leeg met vinkje AAN: uitverkocht, prijs blijft staan zoals vandaag", async () => {
  const shop = maakShop({ be: 0, es: 0, spainFirst: "true", state: "stock-es", price: "109.95" });
  const [r] = await S.reconcileAll();
  assert.equal(r.to, "stock-leeg");
  assert.equal(shop.price, "109.95");
  assert.deepEqual(profielVan(shop), []);
});

test("vinkje weer UIT met BE + ES: terug naar de bestaande werking (België, prijs A)", async () => {
  const shop = maakShop({ be: 6, es: 40, spainFirst: "false", state: "stock-es", price: "109.95" });
  const [r] = await S.reconcileAll();
  assert.equal(r.to, "stock-be");
  assert.equal(shop.price, "119.95");
  assert.deepEqual(profielVan(shop), [PROFIEL_ALGEMEEN]);
});

test("alleen de uitleg verandert: metafield-update, geen prijs- of profielwrite", async () => {
  const shop = maakShop({ be: 6, es: 7, spainFirst: "true", state: "stock-es", price: "109.95",
    extraMeta: { route_reason: "spanje_eerst", es_qty: "8", eu_state: "on:109.95" } });
  const [r] = await S.reconcileAll();
  assert.equal(r.action, "alleen route-uitleg bijgewerkt");
  assert.equal(shop.meta.es_qty, "7");
  assert.equal(shop.mutaties.some((m) => m.query.includes("productVariantsBulkUpdate")), false);
  assert.deepEqual(profielVan(shop), []);
});

test("vergrendeld of uitgeschakeld: ook met vinkje AAN geen enkele write", async () => {
  for (const extra of [{ locked: "true" }, { enabled: "false" }]) {
    const shop = maakShop({ be: 6, es: 40, spainFirst: "true", state: "stock-be", extraMeta: extra });
    await S.reconcileAll();
    assert.equal(shop.mutaties.length, 0, JSON.stringify(extra));
  }
});

test("eigen dashboard van de dienst toont het vinkje en stuurt het mee", () => {
  assert.match(S.PAGE, /Spanje eerst, ook bij Belgische voorraad/);
  assert.match(S.PAGE, /spainFirst/);
});
