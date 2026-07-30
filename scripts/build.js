#!/usr/bin/env node
/**
 * Pré-calcul des données servies par le CDN GitHub.
 * Exécuté par GitHub Actions, jamais par le navigateur du visiteur.
 *
 * Objectif : chaque serveur d'origine est interrogé UNE fois par cycle au lieu
 * d'une fois par visiteur. Les fichiers produits sont allégés (tableaux
 * positionnels, coordonnées à trois décimales) puis servis depuis le CDN.
 *
 * CE FICHIER EST LA SEULE SOURCE DE VÉRITÉ.
 * Auparavant, la même logique existait en trois exemplaires : ce fichier, une
 * copie à la racine (build-data.js, jamais exécutée et dont le chemin de sortie
 * pointait hors du dépôt), et un document en ligne recopié dans le workflow qui
 * écrasait celui-ci à chaque exécution. Les trois avaient divergé. Le workflow
 * se contente désormais d'appeler ce script.
 *
 *   node scripts/build.js fast   séismes, événements NASA, alertes ONU, vigilances
 *   node scripts/build.js slow   périmètres brûlés Copernicus (lent et instable)
 *
 * Un flux indisponible ne fait jamais échouer le travail et n'efface jamais les
 * données déjà en place.
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data");
fs.mkdirSync(OUT, { recursive: true });

const now = Date.now();
const p3 = v => Math.round(v * 1e3) / 1e3;
const UA = "planete-en-direct (+https://github.com/persoproject777/MTO)";

async function get(url, ms, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 45000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: Object.assign({ "User-Agent": UA }, headers || {})
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- Écriture ----------
   Chaque fichier porte un horodatage `t`, ce qui le rendait différent à chaque
   exécution : le dépôt recevait donc un commit toutes les dix minutes même
   quand aucune donnée n'avait bougé. On compare maintenant la charge utile
   SANS l'horodatage ; si elle est identique, le fichier est laissé tel quel.
   Un flux calme ne produit plus aucun commit. */
/* Plusieurs de ces API ne garantissent pas l'ordre de leurs entrées : deux
   réponses identiques peuvent arriver dans un ordre différent. Sans tri, la
   comparaison ci-dessous verrait un changement à chaque cycle et le robot
   commiterait quand même pour rien. On ordonne donc tout de façon stable. */
const byKey = k => (a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : 0; };

const WROTE = [];
const PRESENT = [];
function write(name, obj, label) {
  const file = path.join(OUT, name);
  PRESENT.push(name.replace(".json", ""));
  const fresh = JSON.stringify(obj);
  const payload = JSON.stringify(Object.assign({}, obj, { t: 0 }));
  if (fs.existsSync(file)) {
    try {
      const old = JSON.parse(fs.readFileSync(file, "utf8"));
      if (JSON.stringify(Object.assign({}, old, { t: 0 })) === payload) {
        console.log("  =  " + name.padEnd(14) + " inchangé — " + label);
        return false;
      }
    } catch (e) { /* fichier illisible : on le réécrit */ }
  }
  fs.writeFileSync(file, fresh);
  WROTE.push(name);
  console.log("  +  " + name.padEnd(14) + String(Math.round(fresh.length / 1024)).padStart(5) + " ko   " + label);
  return true;
}

/* ---------- Séismes (USGS) ---------- */
async function quakes() {
  const d = await get("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson", 40000);
  const q = (d.features || []).map(f => {
    const p = f.properties, c = f.geometry.coordinates;
    return [p.mag, p.place || "", p.time, Math.round(c[2]), p3(c[1]), p3(c[0]), p.url || ""];
  }).filter(x => x[0] != null).sort((a, b) => b[2] - a[2]);
  write("quakes.json", { t: now, q }, q.length + " séismes");
}

/* ---------- Événements naturels (NASA EONET) ----------
   La grande majorité des événements « ouverts » ont plus de 90 jours et
   n'apportent rien. On ne garde que les 90 derniers jours, et la trajectoire
   seulement pour les cyclones, qui en ont réellement besoin. */
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
  }).filter(Boolean).sort(byKey(e => e.t + "|" + e.c));
  write("eonet.json", { t: now, events }, events.length + " événements (90 j)");
}

/* ---------- Alertes officielles ONU / Commission européenne (GDACS) ----------
   L'API JSON de GDACS est hors service : `geteventlist/MAP` n'a jamais répondu
   en cent secondes lors des essais, et `geteventlist/SEARCH` renvoie 503. Cela
   expliquait le « délai dépassé » constaté aussi bien dans le navigateur des
   visiteurs que dans ce robot — donc l'absence totale d'alertes officielles.

   Le flux RSS officiel, lui, répond en une seconde environ pour un mégaoctet.
   On l'utilise désormais. Il est plus riche que l'API : il porte l'emprise
   (bbox) et le lien vers l'alerte CAP normalisée.

   Analyse par expression régulière et non par vrai analyseur XML : ce flux est
   produit par une machine, sa forme est stable, et le script ne doit dépendre
   d'aucun paquet externe. */
function xmlUnescape(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&").trim();
}
function xmlTag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">"));
  return m ? xmlUnescape(m[1]) : "";
}

async function gdacs() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
  let xml;
  try {
    const r = await fetch("https://www.gdacs.org/xml/rss.xml",
      { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    xml = await r.text();
  } finally { clearTimeout(t); }

  const items = xml.split("<item>").slice(1).map(s => s.split("</item>")[0]);
  const f = items.map(it => {
    const lat = parseFloat(xmlTag(it, "geo:lat"));
    const lon = parseFloat(xmlTag(it, "geo:long"));
    if (!isFinite(lat) || !isFinite(lon)) return null;
    /* bbox GDACS : « lonMin lonMax latMin latMax ». On la republie dans l'ordre
       attendu côté carte (ouest, sud, est, nord) pour délimiter l'emprise. */
    const bb = xmlTag(it, "gdacs:bbox").split(/\s+/).map(Number);
    const box = bb.length === 4 && bb.every(isFinite)
      ? [p3(bb[0]), p3(bb[2]), p3(bb[1]), p3(bb[3])] : null;
    return {
      t: xmlTag(it, "gdacs:eventtype"),
      a: xmlTag(it, "gdacs:alertlevel"),
      co: xmlTag(it, "gdacs:country"),
      /* Attention au piège : `gdacs:title` vaut « Event in rss format » et
         `gdacs:description` « Joint Research Center of the European Commission ».
         Ce sont des remplissages. L'information réelle est dans les balises RSS
         standard `title` (type, magnitude, lieu, heure) et `description`
         (phrase descriptive complète). */
      n: xmlTag(it, "title"),
      s: xmlTag(it, "description"),
      d: xmlTag(it, "gdacs:fromdate"),
      u: xmlTag(it, "link"),
      cap: xmlTag(it, "gdacs:cap") || "",
      id: xmlTag(it, "gdacs:eventid"),
      cur: xmlTag(it, "gdacs:iscurrent") === "true",
      sc: parseFloat(xmlTag(it, "gdacs:alertscore")) || 0,
      bb: box,
      c: [p3(lat), p3(lon)]
    };
  }).filter(Boolean)
    /* Les plus graves d'abord : la carte n'aura jamais à trier elle-même pour
       décider quoi dessiner en dernier, donc au-dessus. */
    .sort(byKey(x => ({ Red: 0, Orange: 1, Green: 2 }[x.a] ?? 3) + "|" + x.t + "|" + x.id));

  const rouge = f.filter(x => x.a === "Red").length;
  const orange = f.filter(x => x.a === "Orange").length;
  write("gdacs.json", { t: now, f },
    f.length + " alertes (" + rouge + " rouges, " + orange + " orange, " + (f.length - rouge - orange) + " vertes)");
}

/* ---------- Vigilances des météorologues d'État (NWS, États-Unis) ---------- */
async function nws() {
  const d = await get("https://api.weather.gov/alerts/active?status=actual&severity=Extreme,Severe",
    45000, { Accept: "application/geo+json" });
  /* On tronque D'ABORD dans l'ordre de la source — elle place les vigilances les
     plus pertinentes en tête, et trier avant de couper retiendrait 120 alertes
     arbitraires. Le tri ne sert qu'à stabiliser la comparaison, il vient donc
     après la troncature. */
  const f = (d.features || []).filter(x => x.geometry).slice(0, 120)
    .sort(byKey(x => String((x.properties && x.properties.id) || x.id || "")));
  write("nws.json", { t: now, type: "FeatureCollection", features: f }, f.length + " vigilances");
}

/* ---------- Périmètres brûlés (Copernicus EFFIS) ----------
   Source la plus lente et la plus instable de toutes. Un contour de zone brûlée
   n'évolue pas d'une minute à l'autre : une fois par jour suffit.
   Les contours bruts comptent jusqu'à 126 000 sommets ; on les réduit à
   48 points par anneau sans supprimer aucune zone. Mémoire divisée par trois
   côté navigateur, précision visuellement identique à l'échelle de la carte. */
function simp(ring, k) {
  if (ring.length <= k) return ring;
  const step = ring.length / k, out = [];
  for (let i = 0; i < k; i++) out.push(ring[Math.floor(i * step)]);
  out.push(ring[ring.length - 1]);
  return out;
}
const simpGeo = c => Array.isArray(c[0]) && Array.isArray(c[0][0]) ? c.map(simpGeo) : simp(c, 48);

async function effis() {
  const zones = [["eu", "-11,35,32,60"], ["med", "-8,29,42,46"]];
  const out = { t: now, type: "FeatureCollection", features: [] };
  let ok = 0;
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
        if (f.geometry && f.geometry.coordinates)
          f.geometry.coordinates = simpGeo(round(f.geometry.coordinates));
        out.features.push(f);
      });
      ok++;
      console.log("     zone " + name + " : " + (d.features || []).length + " périmètres");
    } catch (e) {
      console.log("     zone " + name + " : échec (" + e.message + ") — on garde l'existant");
    }
  }
  if (ok && out.features.length) {
    out.features.sort(byKey(f => {
      const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
      let first = "";
      let cur = c;
      while (Array.isArray(cur) && Array.isArray(cur[0])) cur = cur[0];
      if (Array.isArray(cur)) first = cur.join(",");
      return (p.COUNTRY || "") + "|" + (p.PROVINCE || "") + "|" + (p.COMMUNE || "") + "|" + (p.FIREDATE || "") + "|" + first;
    }));
    write("effis.json", out, out.features.length + " périmètres");
    return true;
  }
  console.log("  !  effis.json inchangé (aucune zone n'a répondu)");
  if (fs.existsSync(path.join(OUT, "effis.json"))) PRESENT.push("effis");
  return false;
}

/* ---------- Orchestration ---------- */
(async () => {
  const only = process.argv[2] || "fast";
  console.log("Pré-calcul (" + only + ") — " + new Date(now).toISOString());

  /* État précédent : sert à savoir quels fichiers existent déjà et quand la
     source lente a été tentée pour la dernière fois. */
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT, "meta.json"), "utf8")); } catch (e) {}

  const tasks = only === "slow"
    ? [["effis", effis]]
    : [["quakes", quakes], ["eonet", eonet], ["gdacs", gdacs], ["nws", nws]];

  let failed = 0;
  for (const [name, fn] of tasks) {
    try { await fn(); }
    catch (e) { failed++; console.log("  x  " + name.padEnd(14) + " échec : " + e.message); }
  }

  /* Rattrapage de la source lente.
     Le déclencheur quotidien dédié n'a jamais été honoré par GitHub : data/effis.json
     n'a donc jamais existé, et la couche « Périmètres » interrogeait en direct le
     serveur le plus lent du lot chez chaque visiteur. Le cycle rapide rattrape
     désormais lui-même : si le fichier manque ou dépasse vingt heures, il le
     reconstruit. Une tentative infructueuse n'est pas relancée avant trois heures,
     pour ne pas matraquer un serveur en panne à chaque cycle. */
  let effisTried = prev.effisTried || 0;
  if (only === "fast") {
    const f = path.join(OUT, "effis.json");
    let age = Infinity;
    if (fs.existsSync(f)) {
      try { age = now - (JSON.parse(fs.readFileSync(f, "utf8")).t || 0); } catch (e) {}
    }
    const stale = age > 20 * 3600e3;
    const cooled = now - effisTried > 3 * 3600e3;
    if (stale && cooled) {
      console.log("  …  effis.json " + (age === Infinity ? "absent" : "vieux de " + Math.round(age / 3600e3) + " h") + " — rattrapage");
      effisTried = now;
      try { await effis(); } catch (e) { console.log("  x  effis échec : " + e.message); }
    } else if (fs.existsSync(f)) {
      PRESENT.push("effis");
    }
  }

  /* Liste exacte des fichiers réellement disponibles : la carte ne demandera
     jamais un fichier absent, donc plus aucune erreur 404 dans son journal. */
  const files = [];
  fs.readdirSync(OUT).forEach(f => {
    if (f.endsWith(".json") && f !== "meta.json") files.push(f.replace(".json", ""));
  });
  PRESENT.forEach(n => { if (files.indexOf(n) < 0) files.push(n); });
  files.sort();

  /* meta.json n'est réécrit que s'il change vraiment. Comme il portait
     `built: Date.now()`, il différait à chaque exécution et garantissait à lui
     seul un commit par cycle, même quand aucune donnée n'avait bougé. */
  const listChanged = JSON.stringify(prev.files || []) !== JSON.stringify(files);
  const triedChanged = (prev.effisTried || 0) !== effisTried;
  if (WROTE.length || listChanged || triedChanged) {
    fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
      built: now, builtISO: new Date(now).toISOString(), kind: only, files, effisTried
    }));
    console.log("  +  meta.json      " + files.length + " fichiers : " + files.join(", "));
  } else {
    console.log("  =  meta.json      inchangé");
  }

  console.log(WROTE.length
    ? "Terminé — " + WROTE.length + " fichier(s) mis à jour" + (failed ? ", " + failed + " échec(s)" : "") + "."
    : "Terminé — aucune donnée n'a changé" + (failed ? " (" + failed + " échec(s))" : "") + ", aucun commit à faire.");
  process.exit(0);
})();
