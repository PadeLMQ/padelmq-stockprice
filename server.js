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
  locked: "locked", state: "state", euState: "eu_state", log: "log",
};

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
    edges{node{ id title status
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
    if (target === "stock-be" && !priceA) { results.push({ ...base, action: "overgeslagen (Prijs A ontbreekt)" }); continue; }
    if (target === "stock-es" && !priceB) { results.push({ ...base, action: "overgeslagen (Prijs B ontbreekt)" }); continue; }

    const beNlChanged = target !== prev;
    const euChanged = euDesired !== prevEu;
    if (!beNlChanged && !euChanged) { results.push({ ...base, action: "geen wissel" }); continue; }

    // BE/NL prijs + verzendprofiel
    let price = null, profile = null;
    if (target === "stock-be") { price = priceA; profile = PROFILES.algemeen; }
    else if (target === "stock-es") { price = priceB; profile = PROFILES.ballendozen; }

    const parts = [];
    if (beNlChanged) parts.push(target === "stock-leeg"
      ? "BE/NL -> uitverkocht (prijs ongewijzigd)"
      : `BE/NL prijs -> ${price}, profiel -> ${target === "stock-be" ? "Algemeen" : "Ballendozen"}`);
    if (euChanged) parts.push(eu.on
      ? `Europa -> koopbaar aan ${eu.price}`
      : "Europa -> uitverkocht (verborgen)");
    const action = parts.join(" | ");

    if (!APPLY) { results.push({ ...base, action: "[DRY-RUN] " + action }); continue; }
    try {
      if (beNlChanged && price) await setPrice(p.id, variant.id, price);
      if (beNlChanged && profile) await setProfile(profile, variant.id);
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
.wrap{max-width:1240px;margin:0 auto;padding:20px 16px 60px}
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
.panel{background:#fff;border:1px solid var(--rand);border-top:none;border-radius:0 0 12px 12px;overflow:hidden}
.note{background:#f0fdfa;border:1px solid #99f6e4;color:#115e59;font-size:13px;padding:10px 14px;border-radius:10px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:10px 12px;text-align:left;white-space:nowrap}
thead tr{background:#f9fafb;color:#374151}th{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
tbody tr{border-top:1px solid #f1f1f1}tbody tr:hover{background:#fafafa}
td.prod{white-space:normal;max-width:280px;font-weight:600}
input{padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px}input.num{width:88px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#f3f4f6;color:#374151}
.pill.be{background:#dcfce7;color:#166534}.pill.es{background:#fef9c3;color:#854d0e}.pill.leeg{background:#fee2e2;color:#991b1b}
.pill.euon{background:#dbeafe;color:#1e40af}.pill.euoff{background:#f3f4f6;color:#6b7280}
.hint{color:var(--grijs);font-size:12px}
.advies{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 16px;margin:0 0 14px}
.advies-t{font-weight:700;color:#92400e;font-size:14px;margin-bottom:4px}
.advies p{margin:6px 0;font-size:13px;line-height:1.5;color:#3f3f46}
.login{max-width:360px;margin:14vh auto;background:#fff;border:1px solid var(--rand);border-radius:12px;padding:22px}
</style></head>
<body><div class="wrap" id="app"></div>
<script>
let PW="", TAB="ballen";
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

function renderBallen(rows){
 var h='<div style="padding:14px 16px 0"><div class="note"><b>Ballendozen.</b> Prijs A = eigen BE-voorraad (profiel Algemeen, geen doostoeslag). Prijs B = dropship uit Spanje (profiel Ballendozen). Buiten BE/NL: als Spanje leeg is \\u2192 uitverkocht. Vergrendeld = de app laat het product met rust.</div>'
 +'<div class="advies"><div class="advies-t">\\ud83d\\udca1 Advies verkoopprijs (BE/NL)</div>'
 +'<p><b>Verkoop eerst je eigen BE-voorraad</b> (Prijs A). Betere marge, gratis verzending boven \\u20ac100, snelle levering en <b>geen doostoeslag</b> \\u2014 dat is je sterkste aanbod. Pas als Kampenhout + ShopWeDo leeg zijn schakelt de app automatisch naar <b>dropship</b> (Prijs B, met doostoeslag, tragere levering uit Spanje).</p>'
 +'<p><b>Richtprijs t.o.v. concurrentie.</b> De scherpste BE/NL-concurrent voor een doos van 24 kokers zit rond <b>\\u20ac99</b> (Decathlon-niveau). Houd je verkoopprijs bij voorkeur onder \\u2248\\u20ac115 all-in; onder \\u20ac105 ben je duidelijk competitief. Prijs A mag hoger omdat je gratis + snel + zonder doostoeslag levert \\u2014 dat rechtvaardigt het verschil. Bij dropship (Prijs B) telt de klant de doostoeslag erbij: hou die all-in-prijs scherp.</p>'
 +'<p class="hint">Concurrentprijzen wisselen \\u2014 check per doos even Decathlon/Padelmarkt v\\u00f3\\u00f3r je een nieuwe Prijs A/B vastzet. Prijzen in dit plan mikken op \\u224819% marge.</p></div></div>';
 h+='<table><thead><tr><th>Product</th><th>Shop nu</th><th>Prijs A<br><span class="hint">eigen BE</span></th><th>Prijs B<br><span class="hint">dropship</span></th><th>Opslag Europa<br><span class="hint">op Prijs B</span></th><th>Aan</th><th>Vergr.</th><th>Toestand</th><th>Buiten BE/NL</th><th></th></tr></thead><tbody>';
 if(!rows.length)h+='<tr><td colspan="10" class="hint" style="padding:16px">Nog geen producten met tag <code>auto-stock-price</code>.</td></tr>';
 rows.forEach(function(r,i){h+='<tr><td class="prod">'+r.title+'</td><td>'+eur(r.currentPrice)+'</td>'
  +'<td><input class="num" value="'+r.priceA+'" oninput="upd('+i+',\\'priceA\\',this.value)"></td>'
  +'<td><input class="num" value="'+r.priceB+'" oninput="upd('+i+',\\'priceB\\',this.value)"></td>'
  +'<td><input class="num" value="'+r.marketSurcharge+'" oninput="upd('+i+',\\'marketSurcharge\\',this.value)"></td>'
  +'<td><input type="checkbox" '+(r.enabled?"checked":"")+' onchange="upd('+i+',\\'enabled\\',this.checked)"></td>'
  +'<td><input type="checkbox" '+(r.locked?"checked":"")+' onchange="upd('+i+',\\'locked\\',this.checked)"></td>'
  +'<td>'+statePill(r.state)+'</td><td>'+euPill(r.euState)+'</td>'
  +'<td><button class="dark" onclick="save('+i+')">Opslaan</button></td></tr>';});
 return h+'</tbody></table>';
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
