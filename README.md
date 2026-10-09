# Pleut pas ?

Est-ce que je peux prendre mon vélo maintenant, et sinon à quelle heure ? Gros verdict
OUI / NON selon la pluie sur la durée du trajet, prévision fine sur les 2 prochaines
heures, carte animée (pluie observée puis prévue) et vue de la suite de la journée.
Lieu configurable (recherche de ville, géolocalisation ou URL), ville de Québec par défaut,
zone couverte : Québec.

Site 100 % statique, en ligne sur https://samhazvez.github.io/pleutpasqc/

## Données

Trois familles de sources :

1. Radar et extrapolation MSC GeoMet d'Environnement et Changement climatique Canada.
2. Open-Meteo avec le modèle GEM pour les prévisions ponctuelles et les échéances
   au-delà du radar.
3. Photon pour la recherche de lieux au Québec, avec des données OpenStreetMap.

Les données radar extrapolées représentent le déplacement des échos existants et ne
constituent pas une prévision complète. La couverture radar et l'horizon d'extrapolation
sont limités.

Le site est une PWA installable (bandeau "Ajoute Pleut pas ? à ton écran d'accueil" à la
première visite) et propose un rappel quotidien sous forme de fichier .ics à ajouter à son
agenda, sans serveur ni notification push.

## Architecture

- Front : Vue 3, TypeScript, Vite, Tailwind CSS 4, Leaflet, PWA via vite-plugin-pwa.
  Aucune clé ni secret côté front.
- Pipelines de données : les workflows GitHub Actions téléchargent les données radar
  MSC GeoMet, produisent les frames et un manifeste, puis les publient sur une branche
  de données servie au front par raw.githubusercontent.com. Les prévisions Open-Meteo
  sont appelées directement depuis le front.

## Développement

```bash
npm install
npm run dev
```

`npm run build` inclut le typecheck (vue-tsc).

## Versions

Le site est déployé sur GitHub Pages à chaque tag `vX.Y.Z` (workflow
[deploy.yml](.github/workflows/deploy.yml)). L'historique est tenu dans
[CHANGELOG.md](CHANGELOG.md), la version courante est affichée dans le pied de page.

## Attributions

Prévisions [Open-Meteo](https://open-meteo.com/) (CC-BY 4.0), radar
[MSC GeoMet](https://eccc-msc.github.io/open-data/) d'Environnement et Changement climatique
Canada, lieux [Photon](https://photon.komoot.io/) (données OpenStreetMap, ODbL),
fonds de carte [OpenStreetMap](https://www.openstreetmap.org/) et
[CyclOSM](https://www.cyclosm.org/).
