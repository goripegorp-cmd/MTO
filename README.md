# Planète en direct

Carte mondiale des risques naturels en temps quasi réel, en français : incendies détectés
par satellite, séismes, cyclones, crues, qualité de l'air, vent animé et trafic aérien —
uniquement à partir de sources officielles et publiques.

**→ [persoproject777.github.io/MTO](https://persoproject777.github.io/MTO/)**

Aucune inscription, aucune clé d'API, aucun traqueur. Un seul fichier HTML.

---

## Ce que la carte montre

**Feux** — foyers VIIRS et MODIS dessinés à leur *taille réelle au sol*, regroupement des
foyers en sinistres réels, vitesse de front calculée sur la règle des 30 des pompiers,
panache de fumée courbé par le vent mesuré, projection heure par heure sur le vent prévu,
chronologie rejouable sur 48 h, périmètres brûlés officiels (Copernicus en Europe, NIFC
aux États-Unis).

**Alerte localités** — « le feu approche-t-il d'un village ? ». La direction de progression
observée par satellite est comparée à la position des localités dans un cône de ±38°, avec
un délai estimé et une gradation critique / urgent / à surveiller.

**Ma sécurité** — avec votre autorisation, un verdict gradué sur un rayon de 80 km croisant
incendies, alertes officielles, séismes ressentis, météo, air et fumée, ainsi que les moyens
aériens de secours en vol à proximité (les indicatifs officiels de la lutte anti-incendie
européens et nord-américains sont reconnus).

**Météo, Terre, Ciel** — vent animé par particules ancrées à la Terre, radar de pluie animé,
particules PM2,5 mesurées, crues GloFAS, volcans, glaces, trafic ADS-B avec position estimée
entre deux relevés.

**Confort** — ciblage par zone ou par pays, recherche mondiale de lieux, actualités liées à
un événement, lien de partage qui rouvre exactement la même vue, rapport texte prêt à
envoyer, °C/°F.

## Comment c'est construit

Trois étages, et un principe : **les serveurs d'origine sont interrogés une fois par cycle,
pas une fois par visiteur.**

1. **Le robot** — [`.github/workflows/data.yml`](.github/workflows/data.yml) appelle
   [`scripts/build.js`](scripts/build.js) toutes les 15 minutes. Le script interroge les
   sources, allège fortement les données (tableaux positionnels, coordonnées à trois
   décimales, contours réduits à 48 sommets) et les écrit dans [`data/`](data).
2. **Le CDN GitHub** sert ces fichiers. GDACS met parfois dix-huit secondes à répondre :
   le sortir du chemin du visiteur est le gain le plus visible de tout le dispositif.
3. **Le client** — [`index.html`](index.html), 5 534 lignes, HTML + CSS + JavaScript dans un
   seul fichier, avec Leaflet pour seule dépendance. Il lit `data/` en priorité, avec un
   **âge maximum par source** (1 h pour les séismes, 3 h pour les événements NASA). Au-delà,
   ou si le dossier est absent, il bascule tout seul sur les API d'origine : la carte reste
   autonome, y compris ouverte en `file://`.

Quelques partis pris notables :

- **Un catalogue unique de couches.** Les 22 couches, leur groupe, leur icône, leur couleur
  et leur emprise géographique sont décrits en un seul endroit ; la barre d'onglets, le
  tiroir de tuiles et la colonne de gauche en dérivent tous.
- **77 icônes dessinées** dans un sprite SVG unique, zéro emoji : le rendu ne dépend donc
  pas de la police installée sur l'appareil.
- **Disjoncteur réseau par hôte** — trois échecs et un serveur est mis en pause ; les
  sources notoirement lentes le sont dès le deuxième.
- **Un diagnostic intégré** enregistre erreurs, requêtes échouées et serveurs saturés, et
  copie tout le rapport en un clic.
- **Trois profils de performance** selon l'appareil détecté (mémoire, cœurs, type de réseau).
- **Fonctionnement au long cours** : purge des caches expirés, détection de changement de
  jour, reprise après coupure réseau, rien ne tourne dans un onglet caché.

## Développer en local

Aucune dépendance à installer, aucune étape de compilation.

```bash
python -m http.server 8099
```

Puis ouvrez `http://localhost:8099`. Servir en HTTP est nécessaire : ouvert en `file://`,
le navigateur bloque l'accès aux données et la carte le signale.

Pour reconstruire les données à la main :

```bash
node scripts/build.js fast   # séismes, NASA EONET, GDACS, NWS
node scripts/build.js slow   # périmètres brûlés Copernicus (lent)
```

Le script n'écrit un fichier que si la donnée a réellement changé : un cycle calme ne
produit aucun commit.

## Sources et attributions

Toutes les sources sont publiques et interrogées sans clé.

| Donnée | Source |
|---|---|
| Foyers thermiques VIIRS et MODIS | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov) via ArcGIS Living Atlas |
| Événements naturels | [NASA EONET](https://eonet.gsfc.nasa.gov) |
| Séismes | [USGS](https://earthquake.usgs.gov) |
| Alertes graduées | [GDACS](https://www.gdacs.org) — ONU et Commission européenne |
| Vigilances (États-Unis) | [NOAA / NWS](https://www.weather.gov) |
| Périmètres brûlés (Europe) | [Copernicus EFFIS](https://forest-fire.emergency.copernicus.eu) |
| Périmètres brûlés (États-Unis) | [NIFC / WFIGS](https://data-nifc.opendata.arcgis.com) |
| Météo, air, crues | [Open-Meteo](https://open-meteo.com) · Copernicus CAMS · GloFAS |
| Radar de pluie | [RainViewer](https://www.rainviewer.com) |
| Lieux | [Photon](https://photon.komoot.io) sur données OpenStreetMap |
| Actualités | [GDELT](https://www.gdeltproject.org) |
| Trafic ADS-B | [airplanes.live](https://airplanes.live) |
| Fonds de carte | © OpenStreetMap, © CARTO · imagerie © Esri, Maxar, Earthstar Geographics |

## Ce que la carte ne fait pas, et pourquoi

Le projet assume ses limites plutôt que de les masquer — chaque fiche indique si une valeur
est **mesurée**, **calculée** ou **estimée**.

- **Les routes fermées ne sont pas affichées.** Aucun flux public gratuit ne les diffuse en
  temps réel : Bison Futé ne publie rien d'exploitable, les données Waze exigent un
  partenariat institutionnel, et OpenStreetMap ne décrit que des restrictions permanentes.
- **Les arrêtés préfectoraux ne sont pas repris.** Aucune source publique ne les diffuse.
  La carte ouvre à la place la vigilance officielle du pays concerné.
- **Les zones de propagation et les cônes de trajectoire sont des estimations.** Ni le
  relief, ni la végétation, ni surtout l'action des pompiers ne sont modélisés. La grande
  majorité des feux sont arrêtés bien avant les distances affichées.
- **Le retard des satellites est réel** : de une à trois heures en moyenne pour les foyers,
  jusqu'à huit heures sur une zone donnée, car les satellites sont en orbite polaire.
- **Les drones de loisir sont invisibles** : ils n'émettent pas d'ADS-B, et aucun flux
  public ne les diffuse.

> **Carte informative.** Elle ne remplace jamais une alerte officielle. En cas de danger,
> contactez les autorités locales — en Europe, le **112**.
