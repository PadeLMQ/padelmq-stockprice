// PadeLMQ — Voorraad- & locatie-gestuurde prijzen (één-bestand Node-app, geen build/deps).
// Zet product-prijs + verzendprofiel automatisch o.b.v. voorraad per locatie.
// Regels worden bewaard als Shopify-metafields op het product zelf (geen database).

const http = require("http");

// ---------- Config ----------
const SHOP = process.env.SHOPIFY_SHOP || "";
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";
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
const MANAGED_TAG = "auto-stock-price";
const NS = "stockprice";
const MF = {
  enabled: "enabled", priceA: "price_a", priceB: "price_b",
  marketSurcharge: "market_surcharge", locked: "locked", state: "state", log: "log",
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
    const be = availableAt(variant, LOCATIONS.belgium);
    const es = availableAt(variant, LOCATIONS.spain);
    const target = decideState(be, es);
    const base = { title: p.title, be, es, from: prev || "(onbekend)", to: target, action: "", applied: false };

    if (!enabled) { results.push({ ...base, action: "overgeslagen (uit)" }); continue; }
    if (locked) { results.push({ ...base, action: "overgeslagen (vergrendeld)" }); continue; }
    if (target === "stock-be" && !priceA) { results.push({ ...base, action: "overgeslagen (Prijs A ontbreekt)" }); continue; }
    if (target === "stock-es" && !priceB) { results.push({ ...base, action: "overgeslagen (Prijs B ontbreekt)" }); continue; }
    if (target === prev) { results.push({ ...base, action: "geen wissel" }); continue; }

    let price = null, profile = null;
    if (target === "stock-be") { price = priceA; profile = PROFILES.algemeen; }
    else if (target === "stock-es") { price = priceB; profile = PROFILES.ballendozen; }

    const action = target === "stock-leeg"
      ? "toestand -> leeg (uitverkocht), prijs ongewijzigd"
      : `prijs -> ${price}, profiel -> ${target === "stock-be" ? "Algemeen" : "Ballendozen"}`;

    if (!APPLY) { results.push({ ...base, action: "[DRY-RUN] " + action }); continue; }
    try {
      if (price) await setPrice(p.id, variant.id, price);
      if (profile) await setProfile(profile, variant.id);
      await setMeta(p.id, { [MF.state]: target, [MF.log]: `${new Date().toISOString()} ${prev || "?"}->${target} BE=${be} ES=${es}` });
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
          marketSurcharge: c[MF.marketSurcharge] ?? "", state: c[MF.state] ?? "" };
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
            [MF.marketSurcharge]: b.marketSurcharge ?? "", [MF.enabled]: b.enabled ? "true" : "false",
            [MF.locked]: b.locked ? "true" : "false" });
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
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#1a1a1a;margin:0}
.wrap{max-width:1080px;margin:24px auto;padding:0 16px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px}
input{padding:6px 8px;border:1px solid #d1d5db;border-radius:6px}input.num{width:90px}
button{padding:8px 14px;border:none;border-radius:8px;background:#0f766e;color:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px;text-align:left}
thead tr{background:#f3f4f6}tbody tr{border-top:1px solid #eee}.muted{color:#6b7280}</style></head>
<body><div class="wrap" id="app"></div>
<script>
let PW="";
const app=document.getElementById("app");
function login(){app.innerHTML='<div class="card" style="max-width:360px;margin:12vh auto"><h2>PadeLMQ — Voorraadprijzen</h2><p class="muted">Dashboard-wachtwoord</p><input id="pw" type="password" style="width:100%"><br><br><button onclick="doLogin()">Openen</button><p id="err" style="color:#b91c1c"></p></div>';document.getElementById("pw").addEventListener("keydown",e=>{if(e.key==="Enter")doLogin()});}
async function doLogin(){PW=document.getElementById("pw").value;const r=await fetch("/api/products?pw="+encodeURIComponent(PW));const j=await r.json();if(!j.ok){document.getElementById("err").textContent="Fout: "+(j.error||"");return;}render(j.rows);}
async function reload(){const r=await fetch("/api/products?pw="+encodeURIComponent(PW));const j=await r.json();if(j.ok)render(j.rows);}
async function save(i){const r=window._rows[i];const res=await fetch("/api/products?pw="+encodeURIComponent(PW),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(r)});const j=await res.json();msg(j.ok?("Opgeslagen: "+r.title):("Fout: "+j.error));}
async function runCheck(){msg("Bezig met controleren…");const res=await fetch("/api/reconcile?secret="+encodeURIComponent(PW));const j=await res.json();if(!j.ok){msg("Fout: "+j.error);return;}msg("Check klaar — "+j.total+" producten, "+j.applied+" toegepast"+(j.apply?"":" (DRY-RUN: niets echt gewijzigd)"));}
function msg(t){document.getElementById("msg").textContent=t;}
function upd(i,k,v){window._rows[i][k]=v;}
function render(rows){window._rows=rows;let h='<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px"><h2 style="margin:0">PadeLMQ — Voorraadprijzen</h2><button onclick="runCheck()">Nu controleren</button><span class="muted" id="msg"></span></div><p class="muted">Producten met tag <code>auto-stock-price</code>. Prijs A = eigen BE-voorraad (gratis verz.). Prijs B = dropship (toeslag). Vergrendeld = app raakt prijs niet aan.</p><div class="card" style="padding:0;overflow:hidden"><table><thead><tr><th>Product</th><th>Shop nu</th><th>Prijs A</th><th>Prijs B</th><th>Opslag buiten BE/NL</th><th>Aan</th><th>Vergrendeld</th><th>Toestand</th><th></th></tr></thead><tbody>';
if(!rows.length)h+='<tr><td colspan="9" class="muted" style="padding:16px">Nog geen producten met de tag <code>auto-stock-price</code>.</td></tr>';
rows.forEach((r,i)=>{h+='<tr><td>'+r.title+'</td><td>€ '+r.currentPrice+'</td><td><input class="num" value="'+r.priceA+'" oninput="upd('+i+',\\'priceA\\',this.value)"></td><td><input class="num" value="'+r.priceB+'" oninput="upd('+i+',\\'priceB\\',this.value)"></td><td><input class="num" value="'+r.marketSurcharge+'" oninput="upd('+i+',\\'marketSurcharge\\',this.value)"></td><td><input type="checkbox" '+(r.enabled?"checked":"")+' onchange="upd('+i+',\\'enabled\\',this.checked)"></td><td><input type="checkbox" '+(r.locked?"checked":"")+' onchange="upd('+i+',\\'locked\\',this.checked)"></td><td class="muted">'+(r.state||"—")+'</td><td><button style="background:#111827" onclick="save('+i+')">Opslaan</button></td></tr>';});
h+='</tbody></table></div>';app.innerHTML=h;}
login();
</script></body></html>`;
