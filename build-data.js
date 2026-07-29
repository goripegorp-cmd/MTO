#!/usr/bin/env node
/**
 * Pré-calcul des données lentes ou volumineuses.
 * Exécuté par GitHub Actions, jamais par le navigateur du visiteur.
 *
 * Objectif : les serveurs d'origine sont interrogés UNE FOIS par cycle, au lieu
 * d'une fois par visiteur. Les fichiers produits sont servis par le CDN de
 * GitHub, donc quasi instantanés et sans quota.
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data");
fs.mkdirSync(OUT, { recursive: true });

const p3 = v => Math.round(v * 1e3) / 1e3;
const now = Date.now();

async function get(url, ms, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 45000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: headers || {} });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function write(name, obj, label) {
  const s = JSON.stringify(obj);
  fs.writeFileSync(path.join(OUT, name), s);
  console.log(`  ✓ ${name.padEnd(16)} ${String(Math.round(s.length / 1024)).padStart(5)} ko   ${label}`);
}

/* ---------- Séismes (USGS) ---------- */
async function quakes() {
  const d = await get("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson", 40000);
  const q = (d.features || []).map(f => {
    const p = f.properties, c = f.geometry.coordinates;
    return [p.mag, p.place || "", p.time, Math.round(c[2]), p3(c[1]), p3(c[0]), p.url || ""];
  }).filter(x => x[0] != null).sort((a, b) => b[2] - a[2]);
  write("quakes.json", { t: now, q }, `${q.length} séismes`);
}

/* ---------- Événements naturels (NASA EONET) ----------
   94 % des événements « ouverts » ont plus de 90 jours et ne servent à rien.
   On ne conserve que les 90 derniers jours, et la trajectoire seulement
   pour les cyclones, qui en ont réellement besoin. */
async function eonet() {
  const d = await get("https://eonet.gsfc.nasa.gov/api/v3/events?status=open", 60000);
  const MAX = 90 * 864e5;
  const events = (d.events || []).map(ev => {
    const g = (ev.geometry || []).filter(x => x.type === "Point" && Array.isArray(x.coordinates));
    if (!g.length) return null;
    if (now - Date.parse(g[g.length - 1].date) > MAX) return null;
    const cat = (ev.categories && ev.categories[0] && ev.categories[0].id) || "";
    const keep = cat === "severeStorms"
      ? (g.length > 20 ? g.slice(-20) : g)
      : [g[0], g[g.length - 1]];
    const seen = new Set(), uniq = [];
    keep.forEach(x => { if (!seen.has(x.date)) { seen.add(x.date); uniq.push(x); } });
    return {
      t: ev.title, c: cat,
      s: (ev.sources && ev.sources[0] && ev.sources[0].url) || "",
      g: uniq.map(x => [p3(x.coordinates[1]), p3(x.coordinates[0]), Math.round(Date.parse(x.date) / 60000)])
    };
  }).filter(Boolean);
  write("eonet.json", { t: now, events }, `${events.length} événements (90 j)`);
}

/* ---------- Alertes ONU / Commission européenne ----------
   Ce serveur met parfois 18 secondes à répondre : le sortir du chemin du
   visiteur est le gain le plus visible. */
async function gdacs() {
  const d = await get("https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP", 90000);
  const f = (d.features || []).filter(x => x.geometry && x.geometry.type === "Point").map(x => {
    const p = x.properties || {};
    return {
      t: p.eventtype, a: p.alertlevel, co: p.country || "",
      n: p.name || p.eventname || p.description || "",
      s: (p.severitydata && p.severitydata.severitytext) || "",
      d: p.fromdate || "",
      u: (p.url && (p.url.report || p.url.details)) || "",
      c: [p3(x.geometry.coordinates[1]), p3(x.geometry.coordinates[0])]
    };
  });
  write("gdacs.json", { t: now, f }, `${f.length} alertes`);
}

/* ---------- Vigilances des météorologues d'État (USA) ---------- */
async function nws() {
  const d = await get("https://api.weather.gov/alerts/active?status=actual&severity=Extreme,Severe",
    45000, { Accept: "application/geo+json", "User-Agent": "planete-en-direct (github pages)" });
  const f = (d.features || []).filter(x => x.geometry).slice(0, 120);
  write("nws.json", { t: now, type: "FeatureCollection", features: f }, `${f.length} vigilances`);
}

/* ---------- Périmètres brûlés (Copernicus EFFIS) ----------
   Source la plus lente et la plus instable de toutes. Une fois par jour suffit :
   un contour de zone brûlée n'évolue pas d'une minute à l'autre. */
async function effis() {
  const zones = [
    ["eu", "-11,35,32,60"],
    ["med", "-8,29,42,46"]
  ];
  const out = { t: now, type: "FeatureCollection", features: [] };
  for (const [name, bbox] of zones) {
    try {
      const u = "https://maps.wild-fire.eu/effis?service=WFS&version=1.0.0&request=GetFeature"
        + "&typeName=ms:modis.ba.poly.season&outputFormat=geojson&maxFeatures=600"
        + "&srsName=EPSG:4326&bbox=" + bbox;
      const d = await get(u, 120000);
      (d.features || []).forEach(f => {
        const p = f.properties || {};
        f.properties = {
          COMMUNE: p.COMMUNE, PROVINCE: p.PROVINCE, COUNTRY: p.COUNTRY,
          AREA_HA: p.AREA_HA, FIREDATE: p.FIREDATE, LASTUPDATE: p.LASTUPDATE
        };
        const round = c => Array.isArray(c[0]) ? c.map(round) : [p3(c[0]), p3(c[1])];
        if (f.geometry && f.geometry.coordinates) f.geometry.coordinates = round(f.geometry.coordinates);
        out.features.push(f);
      });
      console.log(`     zone ${name} : ${(d.features || []).length} périmètres`);
    } catch (e) {
      console.log(`     zone ${name} : échec (${e.message}) — on garde l'existant`);
    }
  }
  if (out.features.length) write("effis.json", out, `${out.features.length} périmètres`);
  else console.log("  ⚠ effis.json inchangé (aucune donnée récupérée)");
}

/* ---------- Orchestration ---------- */
(async () => {
  const only = process.argv[2] || "fast";
  console.log(`Pré-calcul (${only}) — ${new Date().toISOString()}`);
  const tasks = only === "slow"
    ? [["effis", effis]]
    : [["quakes", quakes], ["eonet", eonet], ["gdacs", gdacs], ["nws", nws]];

  let failed = 0;
  for (const [name, fn] of tasks) {
    try { await fn(); }
    catch (e) { failed++; console.log(`  ✗ ${name.padEnd(16)} échec : ${e.message}`); }
  }

  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    built: now,
    builtISO: new Date(now).toISOString(),
    kind: only
  }));
  console.log(failed ? `Terminé avec ${failed} échec(s) — les fichiers existants sont conservés.` : "Terminé.");
  /* On ne fait jamais échouer le travail : un flux indisponible ne doit pas
     effacer les données déjà en place. */
  process.exit(0);
})();
