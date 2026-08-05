// PadeLMQ — Voorraad- & locatie-gestuurde prijzen (één-bestand Node-app, geen build/deps).
// Zet product-prijs + verzendprofiel + markt-beschikbaarheid automatisch o.b.v. voorraad per locatie.
// Regels worden bewaard als Shopify-metafields op het product zelf (geen database).

const http = require("http");

// ---------- Config ----------
const SHOP = process.env.SHOPIFY_SHOP || "";
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-01";
const CRON_SECRET = process.env.CRON_SECRET || "";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const INTERVAL_MIN = parseInt(process.env.RECONCILE_INTERVAL_MINUTES || "", 10);
const APPLY = process.env.APPLY_CHANGES === "true";
const PORT = process.env.PORT || 3000;

const LOCATIONS = {
  belgium: [
    "gid://shopify/Location/99030794589",  // Kampenhout
    "gid://shopify/Location/111552692573", // ShopWeDo
  ],
  spain: ["gid://shopify/Location/109744292189"], // Spanje (dropship)
};
const PROFILES = {
  algemeen: "gid://shopify/DeliveryProfile/118956327261",   // gratis vanaf €100
  ballendozen: "gid://shopify/DeliveryProfile/149705458013", // doostoeslag
};
// Europa-markt = alle landen buiten BE/NL. Aparte prijslijst + publicatie (etalage).
const EUROPA = {
  publication: "gid://shopify/Publication/308914913629", // beschikbaarheid (etalage)
  pricelist: "gid://shopify/PriceList/32979026269",      // aparte prijs voor Europa (EUR)
};
const MANAGED_TAG = "auto-stock-price";
const NS = "stockprice";
const MF = {
  enabled: "enabled", priceA: "price_a", priceB: "price_b",
  marketSurcharge: "market_surcharge", // opslag op Prijs B voor Europa (normaal, Spanje-voorraad)
  euBePrice: "eu_be_price",             // Europa-prijs als ENKEL BE-voorraad; leeg = uitverkocht buiten BE/NL
  competitor: "competitor",             // laagste concurrentprijs (kale productprijs, info voor advies)
  competitorShip: "competitor_ship",    // verzendkost van de concurrent naar BE (voor all-in-vergelijking)
  cost: "cost",                         // inkoopprijs EX btw (voor winstberekening; wijzigt de prijs niet)
  tiendaPrice: "tienda_price",          // dagelijks opgehaalde webshopprijs van Tienda Padelpoint (incl btw, uitgelogd)
  tiendaAt: "tienda_at",                // tijdstip laatste geslaagde Tienda-ophaling (ISO)
  locked: "locked", state: "state", euState: "eu_state", log: "log",
};
const DOOSTOESLAG = 9.95; // richtwaarde doostoeslag voor de all-in-berekening bij dropship

// ---------- Tienda Padelpoint: dagelijkse webshopprijs ophalen ----------
// De app haalt zelf (uitgelogd, dus de prijs die een gewone bezoeker ziet) elke dag de
// verkoopprijs op de Tienda-productpagina op en bewaart die per product als metafield.
// Enkel merken die Tienda voert; Tecnifibre/Lok/Nox staan er niet -> geen Tienda-prijs.
const TIENDA_BASE = "https://www.tiendapadelpoint.com";
const TIENDA_URLS = {
  "gid://shopify/Product/9736319009117": "/cajon-de-pelotas-de-padel-bullpadel-premium-pro",         // Bullpadel Premium Pro
  "gid://shopify/Product/9736319172957": "/cajon-72-pelotas--24-botes-de-3-uds--bullpadel-fip-next",  // Bullpadel Next
  "gid://shopify/Product/9736320057693": "/cajon-72-pelotas--24-botes-de-3-uds--bullpadel-fip-next-pro", // Bullpadel Next Pro
  "gid://shopify/Product/9736328610141": "/cajon-72-pelotas-padel-24-botes-de-3-uds-adidas-speed-rx", // Adidas Speed RX
  "gid://shopify/Product/9736348762461": "/cajon-72-pelotas-24-botes-de-3-uds-siux-neo-1",            // Siux Neo
  "gid://shopify/Product/9736348959069": "/cajon-72-pelotas-24-botes-de-3-uds-siux-neo-1",            // Siux Neo Speed (zelfde doos)
  "gid://shopify/Product/9973706260829": "/cajon-72-pelotas-24-botes-de-3-uds-head-padel-pro-1",      // Head Pro+
  "gid://shopify/Product/9974481027421": "/cajon-72-pelotas-24-botes-de-3-uds-head-padel-pro-s-1",    // Head Pro S+
  "gid://shopify/Product/14747479245149": "/cajon-72-pelotas--24-botes-de-3-uds-babolat-court-padel", // Babolat Court
  "gid://shopify/Product/14923553866077": "/cajon-72-pelotas-24-botes-de-3-uds-wilson-padel-premier-speed-1", // Wilson Premier Speed
  "gid://shopify/Product/14923650335069": "/cajon-72-pelotas-24-botes-de-3-uds-wilson-padel-premier-1",       // Wilson Padel Premier
  "gid://shopify/Product/15670635856221": "/cajones-de-pelotas-dunlop-pro-padel-es",                  // Dunlop Pro
  "gid://shopify/Product/15671873274205": "/cajon-72-pelotas-24-botes-de-3-uds-black-crown-one",       // Black Crown One
  "gid://shopify/Product/15672224907613": "/cajon-72-pelotas---24-botes-de-3-uds---vibora-elite-team", // Vibor-A Elite Team
  "gid://shopify/Product/16032595640669": "/cajon-72-pelotas-24-botes-de-3-uds-alacran-nitro-1",       // Alacran Nitro
  "gid://shopify/Product/16032610091357": "/cajon-72-pelotas-24-botes-de-3-uds-alacran-nitro-pro-1",   // Alacran Nitro Pro
};
function parseTiendaPrice(html) {
  let m = html.match(/property="product:price:amount"[^>]*content="([\d.]+)"/i)
       || html.match(/content="([\d.]+)"[^>]*property="product:price:amount"/i);
  if (m) return parseFloat(m[1]);
  const j = html.indexOf('"@type":"Product"');            // JSON-LD Product-blok
  if (j >= 0) { const p = html.slice(j, j + 2500).match(/"price"\s*:\s*"?([\d.]+)"?/i); if (p) return parseFloat(p[1]); }
  m = html.match(/itemprop="price"[^>]*content="([\d.]+)"/i);
  if (m) return parseFloat(m[1]);
  return null;
}
async function fetchTiendaPrice(path) {
  const res = await fetch(TIENDA_BASE + path, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return parseTiendaPrice(await res.text());
}
async function reconcileTienda() {
  const out = { total: 0, updated: 0, failed: 0, errors: [] };
  for (const [id, path] of Object.entries(TIENDA_URLS)) {
    out.total++;
    try {
      const price = await fetchTiendaPrice(path);
      if (price == null) { out.failed++; out.errors.push(path + ": geen prijs gevonden"); continue; }
      if (APPLY) await setMeta(id, { [MF.tiendaPrice]: price.toFixed(2), [MF.tiendaAt]: new Date().toISOString() });
      out.updated++;
    } catch (err) { out.failed++; out.errors.push(path + ": " + err.message); }
  }
  return out;
}

// ---------- Shopify Admin API ----------
async function gql(query, variables = {}) {
  if (!SHOP || !TOKEN) throw new Error("SHOPIFY_SHOP en SHOPIFY_ADMIN_TOKEN ontbreken (env).");
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error("Shopify: " + JSON.stringify(json.errors));
  return json.data;
}

async function fetchManaged() {
  const query = `query M($q:String!,$after:String){products(first:50,query:$q,after:$after){
    pageInfo{hasNextPage endCursor}
    edges{node{ id title status tags
      metafields(first:20,namespace:"${NS}"){edges{node{key value}}}
      variants(first:1){edges{node{ id price
        inventoryItem{inventoryLevels(first:20){edges{node{location{id} quantities(names:["available"]){name quantity}}}}}
      }}}
    }}}}`;
  const out = [];
  let after = null;
  do {
    const d = await gql(query, { q: `tag:'${MANAGED_TAG}'`, after });
    for (const e of d.products.edges) out.push(e.node);
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function setPrice(productId, variantId, price) {
  const d = await gql(
    `mutation($p:ID!,$v:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$p,variants:$v){userErrors{message}}}`,
    { p: productId, v: [{ id: variantId, price }] }
  );
  const e = d.productVariantsBulkUpdate.userErrors;
  if (e.length) throw new Error("prijs: " + JSON.stringify(e));
}

async function setProfile(profileId, variantId) {
  const d = await gql(
    `mutation($id:ID!,$pr:DeliveryProfileInput!){deliveryProfileUpdate(id:$id,profile:$pr){userErrors{message}}}`,
    { id: profileId, pr: { variantsToAssociate: [variantId] } }
  );
  const e = d.deliveryProfileUpdate.userErrors;
  if (e.length) throw new Error("profiel: " + JSON.stringify(e));
}

// Europa: vaste prijs zetten in de Europa-prijslijst
async function setEuropaPrice(variantId, amount) {
  const d = await gql(
    `mutation($id:ID!,$prices:[PriceListPriceInput!]!){priceListFixedPricesAdd(priceListId:$id,prices:$prices){userErrors{message}}}`,
    { id: EUROPA.pricelist, prices: [{ variantId, price: { amount: String(amount), currencyCode: "EUR" } }] }
  );
  const e = d.priceListFixedPricesAdd.userErrors;
  if (e.length) throw new Error("europa-prijs: " + JSON.stringify(e));
}

// Europa: product in of uit de etalage (publicatie) zetten
async function setEuropaPublish(productId, publish) {
  const input = publish ? { publishablesToAdd: [productId] } : { publishablesToRemove: [productId] };
  const d = await gql(
    `mutation($id:ID!,$in:PublicationUpdateInput!){publicationUpdate(id:$id,input:$in){userErrors{message}}}`,
    { id: EUROPA.publication, in: input }
  );
  const e = d.publicationUpdate.userErrors;
  if (e.length) throw new Error("europa-etalage: " + JSON.stringify(e));
}

async function setMeta(productId, fields) {
  const metafields = Object.entries(fields).map(([key, value]) => ({
    ownerId: productId, namespace: NS, key, type: "single_line_text_field", value: String(value),
  }));
  const d = await gql(
    `mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){userErrors{message}}}`,
    { m: metafields }
  );
  const e = d.metafieldsSet.userErrors;
  if (e.length) throw new Error("metafields: " + JSON.stringify(e));
}

// ---------- Kernlogica ----------
function mfMap(node) {
  const o = {};
  for (const e of (node.metafields?.edges || [])) o[e.node.key] = e.node.value;
  return o;
}
function availableAt(variant, locIds) {
  let t = 0;
  for (const e of (variant?.inventoryItem?.inventoryLevels?.edges || [])) {
    if (locIds.includes(e.node.location.id)) {
      const q = (e.node.quantities || []).find((x) => x.name === "available");
      t += q?.quantity ?? 0;
    }
  }
  return t;
}
function decideState(be, es) {
  if (be > 0) return "stock-be";
  if (es > 0) return "stock-es";
  return "stock-leeg";
}
function num(v) { const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? null : n; }

// Bepaal wat er buiten BE/NL (Europa) moet gebeuren.
// - Spanje voorraad  -> koopbaar aan Prijs B (+ opslag)
// - enkel BE-voorraad -> uitverkocht, TENZIJ eu_be_price is ingevuld (dan koopbaar aan die hogere prijs)
// - niets            -> uitverkocht
function decideEuropa(be, es, priceB, surcharge, euBePrice) {
  if (es > 0) {
    const p = (num(priceB) ?? 0) + (num(surcharge) ?? 0);
    return { on: true, price: p.toFixed(2) };
  }
  if (be > 0 && num(euBePrice) != null) {
    return { on: true, price: num(euBePrice).toFixed(2) };
  }
  return { on: false, price: null };
}

async function reconcileAll() {
  const products = await fetchManaged();
  const results = [];
  for (const p of products) {
    const cfg = mfMap(p);
    const variant = p.variants?.edges?.[0]?.node;
    if (!variant) continue;
    const enabled = (cfg[MF.enabled] ?? "true") !== "false";
    const locked = cfg[MF.locked] === "true";
    const priceA = cfg[MF.priceA];
    const priceB = cfg[MF.priceB];
    const prev = cfg[MF.state] || "";
    const prevEu = cfg[MF.euState] || "";
    const be = availableAt(variant, LOCATIONS.belgium);
    const es = availableAt(variant, LOCATIONS.spain);
    const target = decideState(be, es);
    const eu = decideEuropa(be, es, priceB, cfg[MF.marketSurcharge], cfg[MF.euBePrice]);
    const euDesired = eu.on ? `on:${eu.price}` : "off";
    const base = { title: p.title, be, es, from: prev || "(onbekend)", to: target, eu: euDesired, action: "", applied: false };

    if (!enabled) { results.push({ ...base, action: "overgeslagen (uit)" }); continue; }
    if (locked) { results.push({ ...base, action: "overgeslagen (vergrendeld)" }); continue; }

    // Display-tag (ballen_gratis / ballen_toeslag) volgt de voorraad — elke ronde gehandhaafd.
    // Deze tag stuurt de "gratis vs doostoeslag"-boodschap op product-/winkelwagenpagina.
    // stock-be -> ballen_gratis, alleen-Spanje -> ballen_toeslag, leeg -> ongemoeid.
    if (APPLY && (target === "stock-be" || target === "stock-es")) {
      const wantGratis = target === "stock-be";
      const tags = p.tags || [];
      try {
        if (wantGratis) {
          if (tags.includes("ballen_toeslag")) await tagRemove(p.id, "ballen_toeslag");
          if (!tags.includes("ballen_gratis")) await tagAdd(p.id, "ballen_gratis");
        } else {
          if (tags.includes("ballen_gratis")) await tagRemove(p.id, "ballen_gratis");
          if (!tags.includes("ballen_toeslag")) await tagAdd(p.id, "ballen_toeslag");
        }
      } catch (e) { /* tag-sync mag de prijslogica niet blokkeren */ }
    }

    if (target === "stock-be" && !priceA) { results.push({ ...base, action: "overgeslagen (Prijs A ontbreekt)" }); continue; }
    if (target === "stock-es" && !priceB) { results.push({ ...base, action: "overgeslagen (Prijs B ontbreekt)" }); continue; }

    const beNlChanged = target !== prev;
    const euChanged = euDesired !== prevEu;

    // BE/NL doelprijs + verzendprofiel voor de huidige voorraadtoestand
    let price = null, profile = null;
    if (target === "stock-be") { price = priceA; profile = PROFILES.algemeen; }
    else if (target === "stock-es") { price = priceB; profile = PROFILES.ballendozen; }

    // HANDHAVING: als een andere app of handmatige actie de prijs heeft gewijzigd
    // terwijl de voorraadtoestand gelijk bleef, zet de app hem elke ronde terug.
    const curPrice = num(variant.price);
    const wantPrice = num(price);
    const priceDrift = wantPrice != null && curPrice != null && Math.abs(wantPrice - curPrice) >= 0.005;
    const beNlAction = beNlChanged || priceDrift; // toepassen bij wissel OF afwijking

    if (!beNlAction && !euChanged) { results.push({ ...base, action: "geen wissel" }); continue; }

    const parts = [];
    if (beNlChanged) parts.push(target === "stock-leeg"
      ? "BE/NL -> uitverkocht (prijs ongewijzigd)"
      : `BE/NL prijs -> ${price}, profiel -> ${target === "stock-be" ? "Algemeen" : "Ballendozen"}`);
    else if (priceDrift) parts.push(`BE/NL prijs hersteld ${variant.price} -> ${price} (was gewijzigd door iets anders)`);
    if (euChanged) parts.push(eu.on
      ? `Europa -> koopbaar aan ${eu.price}`
      : "Europa -> uitverkocht (verborgen)");
    const action = parts.join(" | ");

    if (!APPLY) { results.push({ ...base, action: "[DRY-RUN] " + action }); continue; }
    try {
      if (beNlAction && price) await setPrice(p.id, variant.id, price);
      if (beNlAction && profile) await setProfile(profile, variant.id);
      if (euChanged) {
        if (eu.on) { await setEuropaPrice(variant.id, eu.price); await setEuropaPublish(p.id, true); }
        else { await setEuropaPublish(p.id, false); }
      }
      await setMeta(p.id, {
        [MF.state]: target, [MF.euState]: euDesired,
        [MF.log]: `${new Date().toISOString()} ${prev || "?"}->${target} eu:${euDesired} BE=${be} ES=${es}`,
      });
      results.push({ ...base, action, applied: true });
    } catch (err) { results.push({ ...base, action: "FOUT: " + err.message }); }
  }
  return results;
}

// ---------- Express-motor (Spanje-voorraad -> DHL Express aan/uit via tag) ----------
// Regel (door Mathias bevestigd): express beschikbaar zodra het product in Spanje op voorraad is,
// ongeacht BE-voorraad. Lever: tag "hide_express_be_nl" AANWEZIG = express verborgen in BE/NL.
// Dus: Spanje-voorraad > 0 -> tag weg (express aan); Spanje = 0 -> tag erbij (express uit).
const EXPRESS_TAG = "hide_express_be_nl";
const EXPRESS_SCOPE_TAG = "stock_spain"; // enkel producten die uit Spanje (kunnen) komen
const SPAIN_LOC = LOCATIONS.spain[0];

async function tagAdd(productId, tag) {
  const d = await gql(`mutation($id:ID!,$t:[String!]!){tagsAdd(id:$id,tags:$t){userErrors{message}}}`, { id: productId, t: [tag] });
  const e = d.tagsAdd.userErrors; if (e.length) throw new Error("tagsAdd: " + JSON.stringify(e));
}
async function tagRemove(productId, tag) {
  const d = await gql(`mutation($id:ID!,$t:[String!]!){tagsRemove(id:$id,tags:$t){userErrors{message}}}`, { id: productId, t: [tag] });
  const e = d.tagsRemove.userErrors; if (e.length) throw new Error("tagsRemove: " + JSON.stringify(e));
}
function spainQty(node) {
  let t = 0;
  for (const v of (node.variants?.edges || [])) {
    for (const e of (v.node.inventoryItem?.inventoryLevels?.edges || [])) {
      if (e.node.location.id === SPAIN_LOC) {
        const q = (e.node.quantities || []).find((x) => x.name === "available");
        t += q?.quantity ?? 0;
      }
    }
  }
  return t;
}
async function reconcileExpress() {
  const query = `query M($q:String!,$after:String){products(first:50,query:$q,after:$after){
    pageInfo{hasNextPage endCursor}
    edges{node{ id title tags
      variants(first:25){edges{node{ inventoryItem{inventoryLevels(first:20){edges{node{location{id} quantities(names:["available"]){name quantity}}}}} }}}
    }}}}`;
  const out = { total: 0, changed: 0, added: 0, removed: 0, errors: [] };
  let after = null;
  do {
    const d = await gql(query, { q: `tag:'${EXPRESS_SCOPE_TAG}'`, after });
    for (const e of d.products.edges) {
      const n = e.node; out.total++;
      const wantHide = spainQty(n) <= 0;          // geen Spanje-voorraad -> express verbergen
      const hasTag = n.tags.includes(EXPRESS_TAG);
      if (wantHide === hasTag) continue;           // al correct, niets doen
      if (!APPLY) { out.changed++; continue; }
      try {
        if (wantHide) { await tagAdd(n.id, EXPRESS_TAG); out.added++; }
        else { await tagRemove(n.id, EXPRESS_TAG); out.removed++; }
        out.changed++;
      } catch (err) { out.errors.push(n.title + ": " + err.message); }
    }
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// ---------- HTTP ----------
function send(res, code, data, type = "application/json") {
  res.writeHead(code, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}
function checkPw(url) { return !DASHBOARD_PASSWORD || url.searchParams.get("pw") === DASHBOARD_PASSWORD; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");

    if (url.pathname === "/api/products" && req.method === "GET") {
      if (!checkPw(url)) return send(res, 401, { ok: false, error: "unauthorized" });
      const products = await fetchManaged();
      const rows = products.map((p) => {
        const c = mfMap(p); const v = p.variants?.edges?.[0]?.node;
        return { id: p.id, title: p.title, currentPrice: v?.price ?? "",
          enabled: (c[MF.enabled] ?? "true") !== "false", locked: c[MF.locked] === "true",
          priceA: c[MF.priceA] ?? "", priceB: c[MF.priceB] ?? "",
          marketSurcharge: c[MF.marketSurcharge] ?? "", euBePrice: c[MF.euBePrice] ?? "",
          competitor: c[MF.competitor] ?? "", competitorShip: c[MF.competitorShip] ?? "",
          cost: c[MF.cost] ?? "",
          tiendaPrice: c[MF.tiendaPrice] ?? "", tiendaAt: c[MF.tiendaAt] ?? "",
          hasTienda: Object.prototype.hasOwnProperty.call(TIENDA_URLS, p.id),
          state: c[MF.state] ?? "", euState: c[MF.euState] ?? "" };
      });
      return send(res, 200, { ok: true, rows });
    }

    if (url.pathname === "/api/products" && req.method === "POST") {
      if (!checkPw(url)) return send(res, 401, { ok: false, error: "unauthorized" });
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const b = JSON.parse(body || "{}");
          if (!b.id) throw new Error("id ontbreekt");
          await setMeta(b.id, { [MF.priceA]: b.priceA ?? "", [MF.priceB]: b.priceB ?? "",
            [MF.marketSurcharge]: b.marketSurcharge ?? "", [MF.euBePrice]: b.euBePrice ?? "",
            [MF.competitor]: b.competitor ?? "", [MF.competitorShip]: b.competitorShip ?? "",
            [MF.cost]: b.cost ?? "",
            [MF.enabled]: b.enabled ? "true" : "false", [MF.locked]: b.locked ? "true" : "false" });
          send(res, 200, { ok: true });
        } catch (e) { send(res, 500, { ok: false, error: e.message }); }
      });
      return;
    }

    if (url.pathname === "/api/reconcile") {
      const provided = url.searchParams.get("secret") || req.headers["x-cron-secret"];
      if (CRON_SECRET && provided !== CRON_SECRET) return send(res, 401, { ok: false, error: "unauthorized" });
      const results = await reconcileAll();
      return send(res, 200, { ok: true, apply: APPLY, total: results.length,
        applied: results.filter((r) => r.applied).length, results });
    }

    if (url.pathname === "/api/express") {
      const provided = url.searchParams.get("secret") || req.headers["x-cron-secret"];
      if (CRON_SECRET && provided !== CRON_SECRET) return send(res, 401, { ok: false, error: "unauthorized" });
      const r = await reconcileExpress();
      return send(res, 200, { ok: true, apply: APPLY, ...r });
    }

    if (url.pathname === "/api/tienda") {
      const provided = url.searchParams.get("secret") || req.headers["x-cron-secret"];
      if (CRON_SECRET && provided !== CRON_SECRET) return send(res, 401, { ok: false, error: "unauthorized" });
      const r = await reconcileTienda();
      return send(res, 200, { ok: true, apply: APPLY, ...r });
    }

    send(res, 404, { ok: false, error: "not found" });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

server.listen(PORT, () => {
  console.log(`[stockprice] draait op poort ${PORT} — ${APPLY ? "LIVE" : "DRY-RUN"}`);
  if (INTERVAL_MIN && INTERVAL_MIN >= 1) {
    const run = async () => {
      try {
        const r = await reconcileAll();
        console.log(`[stockprice] check: ${r.length} producten, ${r.filter((x) => x.applied).length} toegepast${APPLY ? "" : " (DRY-RUN)"}`);
      } catch (e) { console.error("[stockprice] fout:", e.message); }
    };
    setTimeout(run, 15000);
    setInterval(run, INTERVAL_MIN * 60000);
    console.log(`[stockprice] scheduler: elke ${INTERVAL_MIN} min`);
    // Express-motor draait op een tragere cadans (hele catalogus met stock_spain), min. 60 min.
    const expressEvery = Math.max(INTERVAL_MIN, 60);
    const runExpress = async () => {
      try {
        const r = await reconcileExpress();
        console.log(`[express] ${r.total} producten, ${r.changed} gewijzigd (+${r.added}/-${r.removed})${APPLY ? "" : " (DRY-RUN)"}`);
      } catch (e) { console.error("[express] fout:", e.message); }
    };
    setTimeout(runExpress, 45000);
    setInterval(runExpress, expressEvery * 60000);
    console.log(`[express] scheduler: elke ${expressEvery} min`);
    // Tienda-prijzen: 1x per dag ophalen (uitgelogde webshopprijs van de leverancier).
    const runTienda = async () => {
      try {
        const r = await reconcileTienda();
        console.log(`[tienda] ${r.total} dozen, ${r.updated} bijgewerkt, ${r.failed} mislukt${APPLY ? "" : " (DRY-RUN: niets opgeslagen)"}`);
      } catch (e) { console.error("[tienda] fout:", e.message); }
    };
    setTimeout(runTienda, 90000);
    setInterval(runTienda, 24 * 60 * 60000);
    console.log("[tienda] scheduler: elke 24 uur");
  } else {
    console.log("[stockprice] scheduler uit (RECONCILE_INTERVAL_MINUTES niet gezet)");
  }
});

// ---------- Dashboard (HTML) ----------
const PAGE = `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PadeLMQ Voorraadprijzen</title>
<style>
:root{--groen:#0f766e;--groen2:#0b6e4f;--rand:#e5e7eb;--grijs:#6b7280;--bg:#f6f7f9}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:#111827;margin:0}
.wrap{max-width:1600px;margin:0 auto;padding:20px 16px 60px}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:22px;margin:0;font-weight:700}
.sub{color:var(--grijs);font-size:13px;margin:2px 0 16px}
button{padding:8px 14px;border:none;border-radius:8px;background:var(--groen);color:#fff;cursor:pointer;font-size:14px}
button.ghost{background:#fff;color:#111827;border:1px solid var(--rand)}
button.dark{background:#111827}
.msg{color:var(--grijs);font-size:13px}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--rand);margin:8px 0 0}
.tab{padding:10px 16px;border:none;background:none;color:var(--grijs);font-size:14px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;border-radius:0}
.tab.on{color:var(--groen);border-bottom:2px solid var(--groen)}
.panel{background:#fff;border:1px solid var(--rand);border-top:none;border-radius:0 0 12px 12px;overflow-x:auto}
.note{background:#f0fdfa;border:1px solid #99f6e4;color:#115e59;font-size:13px;padding:10px 14px;border-radius:10px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:7px 8px;text-align:left;white-space:nowrap}
thead tr{background:#f9fafb;color:#374151}th{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
tbody tr{border-top:1px solid #f1f1f1}tbody tr:hover{background:#fafafa}
td.prod{white-space:normal;max-width:190px;font-weight:600;font-size:13px}
input{padding:5px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:13px}input.num{width:70px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#f3f4f6;color:#374151}
.pill.be{background:#dcfce7;color:#166534}.pill.es{background:#fef9c3;color:#854d0e}.pill.leeg{background:#fee2e2;color:#991b1b}
.pill.euon{background:#dbeafe;color:#1e40af}.pill.euoff{background:#f3f4f6;color:#6b7280}
.hint{color:var(--grijs);font-size:12px}
.advies{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;margin:0 0 14px}
.advies-t{font-weight:700;color:#92400e;font-size:14px;margin-bottom:4px}
.advies p{margin:6px 0;font-size:13px;line-height:1.5;color:#3f3f46}
.ok{color:#166534;font-weight:600}.warn{color:#b45309;font-weight:600}
td.advc div{margin:1px 0}
/* ---- Kaart-weergave ballendozen ---- */
.cards{padding:14px 14px 6px}
.card{background:#fff;border:1px solid var(--rand);border-radius:14px;margin-bottom:10px;overflow:hidden;transition:box-shadow .15s}
.card.open{box-shadow:0 6px 20px rgba(0,0,0,.07);border-color:#cbd5e1}
.chead{display:grid;grid-template-columns:1fr auto auto 26px;gap:16px;align-items:center;padding:14px 16px;cursor:pointer}
.chead:hover{background:#fafafa}
.pname{font-weight:700;font-size:15px;margin-bottom:5px}
.situ{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--grijs);white-space:normal}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.dot.be{background:#22c55e}.dot.es{background:#eab308}.dot.leeg{background:#ef4444}
.kcol{text-align:right}
.kcol .lab{font-size:11px;color:var(--grijs);text-transform:uppercase;letter-spacing:.03em;margin-bottom:2px}
.kcol .val{font-size:18px;font-weight:700}
.kcol .val.pos{color:#15803d}.kcol .val.neg{color:#b45309}.kcol .val.mut{color:#9ca3af;font-weight:600}
.chev{color:#9ca3af;font-size:20px;transition:transform .18s;justify-self:center}
.card.open .chev{transform:rotate(90deg)}
.detail{display:none;padding:2px 16px 18px;border-top:1px solid #f1f1f1}
.card.open .detail{display:block}
.doing{background:#f8fafc;border:1px solid #eef2f6;border-radius:10px;padding:11px 14px;font-size:13px;line-height:1.5;margin:14px 0;color:#334155}
.tienda{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 14px;font-size:13px;margin:14px 0}
.tienda .lab{color:#3730a3;font-weight:600}
.tienda .v{font-size:17px;font-weight:700;color:#312e81}
.tienda .v.mut{color:#9ca3af;font-size:13px;font-weight:600}
.tienda .d{font-size:11px;color:#6366f1;font-weight:500;margin-left:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:14px 0}
.box{border:1px solid var(--rand);border-radius:10px;padding:12px}
.box h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--grijs);font-weight:700}
.box.active{border-color:#5eead4;background:#f0fdfa}
.fieldrow{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}
.fieldrow label{font-size:13px;color:#374151;min-width:92px}
.win{font-size:13px;margin-top:8px}
.win .pos{color:#15803d;font-weight:700}.win .neg{color:#b45309;font-weight:700}.win .muted{color:#9ca3af}
.activeflag{display:inline-block;font-size:11px;font-weight:700;color:#0f766e;background:#ccfbf1;border-radius:999px;padding:1px 8px;margin-left:6px}
.foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px}
.toggles{display:flex;gap:16px;font-size:13px;color:#374151;flex-wrap:wrap}
.toggles label{display:flex;align-items:center;gap:6px;cursor:pointer}
.login{max-width:360px;margin:14vh auto;background:#fff;border:1px solid var(--rand);border-radius:12px;padding:22px}
</style></head>
<body><div class="wrap" id="app"></div>
<script>
let PW="", TAB="ballen";
const DOOSTOESLAG_JS=9.95;
const PALLET_JS=4.41;     // pallet/handling eigen voorraad (ex btw)
const SHOPWEDO_JS=6.14;   // verzendkost eigen voorraad BE/NL (ShopWeDo, ex btw) - jij draagt deze
const DROP_JS=1.78;       // netto verzendtekort dropship (doostoeslag dekt de rest)
const app=document.getElementById("app");
const eur=v=>v?("\\u20ac "+v):"—";

function login(){app.innerHTML='<div class="login"><h1>PadeLMQ — Voorraadprijzen</h1><p class="sub">Voer je cijfercode in</p><input id="pw" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="12" placeholder="cijfercode" style="width:100%;font-size:20px;letter-spacing:4px;text-align:center"><br><br><button onclick="doLogin()" style="width:100%">Openen</button><p id="err" style="color:#b91c1c"></p></div>';var el=document.getElementById("pw");el.focus();el.addEventListener("input",function(){this.value=this.value.replace(/[^0-9]/g,"");});el.addEventListener("keydown",e=>{if(e.key==="Enter")doLogin()});}
async function doLogin(){PW=document.getElementById("pw").value;const r=await fetch("/api/products?pw="+encodeURIComponent(PW));const j=await r.json();if(!j.ok){document.getElementById("err").textContent="Fout: "+(j.error||"");return;}render(j.rows);}
async function reload(){const r=await fetch("/api/products?pw="+encodeURIComponent(PW));const j=await r.json();if(j.ok)render(j.rows);}
async function save(i){const r=window._rows[i];const res=await fetch("/api/products?pw="+encodeURIComponent(PW),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(r)});const j=await res.json();msg(j.ok?("Opgeslagen: "+r.title):("Fout: "+j.error));}
async function runCheck(){msg("Bezig met controleren\\u2026");const res=await fetch("/api/reconcile?secret="+encodeURIComponent(PW));const j=await res.json();if(!j.ok){msg("Fout: "+j.error);return;}msg("Check klaar \\u2014 "+j.total+" producten, "+j.applied+" toegepast"+(j.apply?"":" (TESTMODUS: niets echt gewijzigd)"));}
function msg(t){var m=document.getElementById("msg");if(m)m.textContent=t;}
function upd(i,k,v){window._rows[i][k]=v;}
function setTab(t){TAB=t;render(window._rows);}
function statePill(s){var m={"stock-be":["be","Eigen BE-voorraad"],"stock-es":["es","Spanje (dropship)"],"stock-leeg":["leeg","Uitverkocht"]};var x=m[s];return x?'<span class="pill '+x[0]+'">'+x[1]+'</span>':'<span class="pill">—</span>';}
function euPill(e){if(!e||e==="off")return '<span class="pill euoff">Uitverkocht</span>';return '<span class="pill euon">Koopbaar '+e.replace("on:","\\u20ac ")+'</span>';}

function render(rows){window._rows=rows;
 var head='<div class="top"><h1>PadeLMQ — Voorraadprijzen</h1><button onclick="runCheck()">Nu controleren</button><span class="msg" id="msg"></span></div>'
 +'<div class="tabs"><button class="tab '+(TAB==="ballen"?"on":"")+'" onclick="setTab(\\'ballen\\')">Ballendozen</button>'
 +'<button class="tab '+(TAB==="markt"?"on":"")+'" onclick="setTab(\\'markt\\')">Per markt (collectie)</button></div>';
 var body = TAB==="ballen" ? renderBallen(rows) : renderMarkt(rows);
 app.innerHTML=head+'<div class="panel">'+body+'</div>';
}

function num2(v){var n=parseFloat(String(v).replace(",","."));return isNaN(n)?null:n;}
function advies(r){
 var C=num2(r.competitor), S=num2(r.competitorShip)||0, A=num2(r.priceA), B=num2(r.priceB);
 if(C==null) return '<span class="hint">vul concurrent in \\u2192 advies</span>';
 var comp=C+S; // all-in bij de concurrent = productprijs + hun verzendkost
 var out=['<div class="hint">concurrent all-in \\u20ac'+comp.toFixed(2)+(S>0?' (\\u20ac'+C.toFixed(2)+' + \\u20ac'+S.toFixed(2)+' verz.)':' \\u2014 vul verz. in')+'</div>'];
 if(A!=null){var okA=A<=comp+0.005;out.push('<div><b>BE/NL</b> \\u20ac'+A.toFixed(2)+' <span class="hint">(gratis verz.)</span> '+(okA?'<span class="ok">\\u2264 concurrent \\u2713</span>':'<span class="warn">+\\u20ac'+(A-comp).toFixed(2)+'</span>')+'</div>');}
 if(B!=null){var allin=B+DOOSTOESLAG_JS;var okB=allin<=comp+0.005;out.push('<div><b>dropship</b> all-in \\u20ac'+allin.toFixed(2)+' <span class="hint">(\\u20ac'+B.toFixed(2)+'+\\u20ac'+DOOSTOESLAG_JS.toFixed(2)+')</span> '+(okB?'<span class="ok">\\u2713</span>':'<span class="warn">+\\u20ac'+(allin-comp).toFixed(2)+'</span>')+'</div>');}
 return out.join('');
}
var SITU={"stock-be":["be","Eigen BE-voorraad \\u00b7 gratis verzending \\u00b7 <b>Prijs A</b> actief"],
          "stock-es":["es","Dropship uit Spanje \\u00b7 +\\u20ac9,95 doostoeslag \\u00b7 <b>Prijs B</b> actief"],
          "stock-leeg":["leeg","Geen voorraad \\u00b7 staat op <b>uitverkocht</b>"]};
function money(v){var n=num2(v);return n==null?"\\u2014":("\\u20ac "+n.toFixed(2));}
function winEigen(r){var c=num2(r.cost),A=num2(r.priceA);if(c==null||A==null)return null;return A/1.21-c-PALLET_JS-SHOPWEDO_JS;}
function winDrop(r){var c=num2(r.cost),B=num2(r.priceB);if(c==null||B==null)return null;return B/1.21-c-DROP_JS;}
function winNow(r){if(r.state==="stock-be")return winEigen(r);if(r.state==="stock-es")return winDrop(r);return null;}
function winLine(w,base){if(w==null)return '<span class="muted">\\u2014 vul inkoop in</span>';var b=num2(base);var pct=b?(' ('+(w/(b/1.21)*100).toFixed(0)+'%)'):'';var cls=w>=0?"pos":"neg";return '<b>Winst</b> <span class="'+cls+'">\\u20ac'+w.toFixed(2)+'</span> <span class="hint">'+pct+'</span>';}
function fmtDate(iso){if(!iso)return '';var d=new Date(iso);if(isNaN(d.getTime()))return '';return d.toLocaleDateString('nl-BE',{day:'2-digit',month:'2-digit'});}
function toggle(i){var c=document.getElementById('card'+i);if(c)c.classList.toggle('open');}
function tiendaHTML(r){
 if(!r.hasTienda) return '<span class="v mut">niet bij Tienda</span>';
 if(!r.tiendaPrice) return '<span class="v mut">nog niet opgehaald</span>';
 return '<span class="v">\\u20ac '+num2(r.tiendaPrice).toFixed(2)+'</span>'+(r.tiendaAt?'<span class="d">bijgewerkt '+fmtDate(r.tiendaAt)+'</span>':'');
}
function renderBallen(rows){
 var h='<div class="cards">';
 if(!rows.length) h+='<div class="hint" style="padding:16px">Nog geen producten met tag <code>auto-stock-price</code>.</div>';
 rows.forEach(function(r,i){
  var s=SITU[r.state]||["","Nog niet bepaald \\u2014 wacht op eerste controle"];
  var wn=winNow(r); var wnCls=wn==null?"mut":(wn>=0?"pos":"neg"); var wnTxt=wn==null?"\\u2014":("\\u20ac"+wn.toFixed(2));
  var beA=r.state==="stock-be", esA=r.state==="stock-es";
  var doing=r.state==="stock-be"?"Verkoopt nu uit je eigen BE-voorraad aan Prijs A (gratis verzending). Zodra BE leeg is, schakelt de app automatisch naar dropship (Prijs B)."
   :r.state==="stock-es"?"Verkoopt nu via dropship uit Spanje aan Prijs B (de klant betaalt +\\u20ac9,95 doostoeslag). Zodra er BE-voorraad is, gaat hij automatisch terug naar Prijs A."
   :"Geen voorraad \\u2014 staat op uitverkocht. Zodra er ergens voorraad binnenkomt, wordt de doos vanzelf weer koopbaar.";
  h+='<div class="card" id="card'+i+'">'
   +'<div class="chead" onclick="toggle('+i+')">'
    +'<div><div class="pname">'+r.title+'</div><div class="situ"><span class="dot '+s[0]+'"></span><span>'+s[1]+'</span></div></div>'
    +'<div class="kcol"><div class="lab">Prijs nu</div><div class="val">'+money(r.currentPrice)+'</div></div>'
    +'<div class="kcol"><div class="lab">Winst nu</div><div class="val '+wnCls+'" id="wnow'+i+'">'+wnTxt+'</div></div>'
    +'<div class="chev">\\u203a</div>'
   +'</div>'
   +'<div class="detail">'
    +'<div class="doing">'+doing+'</div>'
    +'<div class="tienda"><span class="lab">Tienda (Padelpoint) \\u2014 online verkoopprijs</span><span>'+tiendaHTML(r)+'</span></div>'
    +'<div class="grid2">'
     +'<div class="box'+(beA?' active':'')+'"><h4>Eigen BE-voorraad'+(beA?' <span class="activeflag">nu actief</span>':'')+'</h4>'
      +'<div class="fieldrow"><label>Prijs A</label><input class="num" value="'+r.priceA+'" oninput="upd('+i+',\\'priceA\\',this.value);readvies('+i+')"><span class="hint">gratis verz.</span></div>'
      +'<div class="win" id="wa'+i+'">'+winLine(winEigen(r),r.priceA)+'</div></div>'
     +'<div class="box'+(esA?' active':'')+'"><h4>Dropship (Spanje)'+(esA?' <span class="activeflag">nu actief</span>':'')+'</h4>'
      +'<div class="fieldrow"><label>Prijs B</label><input class="num" value="'+r.priceB+'" oninput="upd('+i+',\\'priceB\\',this.value);readvies('+i+')"><span class="hint">+\\u20ac9,95 doos</span></div>'
      +'<div class="win" id="wb'+i+'">'+winLine(winDrop(r),r.priceB)+'</div></div>'
    +'</div>'
    +'<div class="grid2">'
     +'<div class="box"><h4>Inkoop</h4><div class="fieldrow"><label>Inkoop (ex btw)</label><input class="num" placeholder="\\u2014" value="'+r.cost+'" oninput="upd('+i+',\\'cost\\',this.value);readvies('+i+')"></div><div class="hint">Bepaalt je winst hierboven.</div></div>'
     +'<div class="box"><h4>Concurrent (voor advies)</h4><div class="fieldrow"><label>Hun prijs</label><input class="num" placeholder="prijs" value="'+r.competitor+'" oninput="upd('+i+',\\'competitor\\',this.value);readvies('+i+')"></div><div class="fieldrow"><label>+ verzending</label><input class="num" placeholder="+ verz." value="'+r.competitorShip+'" oninput="upd('+i+',\\'competitorShip\\',this.value);readvies('+i+')"></div></div>'
    +'</div>'
    +'<div class="advies" id="adv'+i+'">'+advies(r)+'</div>'
    +'<div class="foot"><div class="toggles">'
     +'<label><input type="checkbox" '+(r.enabled?"checked":"")+' onchange="upd('+i+',\\'enabled\\',this.checked)"> App beheert deze doos</label>'
     +'<label><input type="checkbox" '+(r.locked?"checked":"")+' onchange="upd('+i+',\\'locked\\',this.checked)"> Vergrendeld (met rust laten)</label>'
    +'</div><button class="dark" onclick="save('+i+')">Opslaan</button></div>'
   +'</div>'
  +'</div>';
 });
 return h+'</div>';
}
function readvies(i){var r=window._rows[i];
 var a=document.getElementById("adv"+i);if(a)a.innerHTML=advies(r);
 var wa=document.getElementById("wa"+i);if(wa)wa.innerHTML=winLine(winEigen(r),r.priceA);
 var wb=document.getElementById("wb"+i);if(wb)wb.innerHTML=winLine(winDrop(r),r.priceB);
 var wn=document.getElementById("wnow"+i);if(wn){var v=winNow(r);wn.className="val "+(v==null?"mut":(v>=0?"pos":"neg"));wn.textContent=(v==null?"\\u2014":("\\u20ac"+v.toFixed(2)));}
}
function winst(r){
 var cost=num2(r.cost); if(cost==null) return '<span class="hint">vul inkoop in</span>';
 var A=num2(r.priceA), B=num2(r.priceB); var out=[];
 if(A!=null){var ex=A/1.21;var w=ex-cost-PALLET_JS-SHOPWEDO_JS;var cls=w>=0?"ok":"warn";out.push('<div><b>eigen</b> <span class="'+cls+'">\\u20ac'+w.toFixed(2)+'</span> <span class="hint">('+(w/ex*100).toFixed(0)+'%)</span></div>');}
 if(B!=null){var ex2=B/1.21;var w2=ex2-cost-DROP_JS;var cls2=w2>=0?"ok":"warn";out.push('<div><b>dropship</b> <span class="'+cls2+'">\\u20ac'+w2.toFixed(2)+'</span> <span class="hint">('+(w2/ex2*100).toFixed(0)+'%)</span></div>');}
 return out.join('');
}

function renderMarkt(rows){
 var h='<div style="padding:14px 16px 0"><div class="note"><b>Per markt (hele collectie).</b> Voor producten die je buiten BE/NL <b>niet uitverkocht</b> wil zetten maar aan een <b>andere prijs</b> wil verkopen zolang je BE-voorraad hebt. Vul \\u201cBuiten-BE/NL-prijs\\u201d in \\u2192 dan blijft het buiten BE/NL koopbaar aan die prijs als Spanje leeg is, en zakt automatisch terug naar Prijs B zodra Spanje weer voorraad heeft. Laat je het leeg \\u2192 uitverkocht (zoals bij de ballen). <i>Nog niet in gebruik; staat klaar voor later.</i></div></div>';
 h+='<table><thead><tr><th>Product</th>'
  +'<th>BE/NL &middot; eigen voorraad<br><span class="hint">= Prijs A</span></th>'
  +'<th>BE/NL &middot; dropship<br><span class="hint">= Prijs B</span></th>'
  +'<th>Buiten BE/NL &middot; Spanje-voorraad<br><span class="hint">= Prijs B + opslag</span></th>'
  +'<th>Buiten BE/NL &middot; enkel BE-voorraad<br><span class="hint">leeg = uitverkocht</span></th>'
  +'<th>Aan</th><th>Vergr.</th><th></th></tr></thead><tbody>';
 if(!rows.length)h+='<tr><td colspan="8" class="hint" style="padding:16px">Nog geen producten met tag <code>auto-stock-price</code>.</td></tr>';
 rows.forEach(function(r,i){var eb=(parseFloat(String(r.priceB).replace(",","."))||0)+(parseFloat(String(r.marketSurcharge).replace(",","."))||0);
  h+='<tr><td class="prod">'+r.title+'</td>'
  +'<td><input class="num" value="'+r.priceA+'" oninput="upd('+i+',\\'priceA\\',this.value)"></td>'
  +'<td><input class="num" value="'+r.priceB+'" oninput="upd('+i+',\\'priceB\\',this.value)"></td>'
  +'<td><span class="hint">\\u20ac '+(eb?eb.toFixed(2):"—")+'</span></td>'
  +'<td><input class="num" placeholder="uitverkocht" value="'+r.euBePrice+'" oninput="upd('+i+',\\'euBePrice\\',this.value)"></td>'
  +'<td><input type="checkbox" '+(r.enabled?"checked":"")+' onchange="upd('+i+',\\'enabled\\',this.checked)"></td>'
  +'<td><input type="checkbox" '+(r.locked?"checked":"")+' onchange="upd('+i+',\\'locked\\',this.checked)"></td>'
  +'<td><button class="dark" onclick="save('+i+')">Opslaan</button></td></tr>';});
 return h+'</tbody></table>';
}
login();
</script></body></html>`;
