# Videá s ukážkami

Tri krátke videá pre sekcie na hlavnej stránke (`#trenerom`, `#hracom`,
`#partie`). Kým súbor chýba, `index.html` namiesto neho zobrazuje mock kartu
danej sekcie so štítkom „Ukážka čoskoro“ – `<video>` je v HTML zakomentované
a čaká tu na súbor.

## Súbory

| Súbor            | Sekcia       | Čo ukázať |
|-------------------|--------------|-----------|
| `treneri.mp4`      | Pre trénerov | ako tréner potvrdí žiadosť, nastaví cenník alebo dostane platbu QR kódom |
| `hraci.mp4`        | Pre hráčov   | ako hráč nájde trénera/partiu, pošle žiadosť a dostane loptičku po tréningu |
| `skupiny.mp4`      | Pre skupiny  | ako organizátor partie vidí, kto príde a kto zaplatil |

Voliteľne k nim patrí statický náhľad (prehráva sa až po kliknutí):
`treneri.jpg`, `hraci.jpg`, `skupiny.jpg` (atribút `poster` na `<video>`).

## Formát

- **Zvislé video, pomer strán 9:16** (nahrané na telefón na výšku) – rovnaký
  tvar má aj mock karta, ktorú video nahrádza.
- Odporúčané rozlíšenie 1080×1920, H.264/MP4, bez zvuku alebo s tichým
  podkladom (appka aj web sa prezerajú aj s vypnutým zvukom).
- Dĺžka do cca 20 sekúnd – je to ukážka, nie návod.
- **Max. veľkosť súboru 8 MB** na video, nech sa stránka načíta rýchlo aj na
  mobile (`preload="none"`, takže sa sťahuje až po kliknutí na play).

## Zapojenie

Keď je súbor na svojom mieste, v `index.html` (a v kópii `web/index.html` v
repe appky) odkomentuj príslušný `<video>` blok v danej sekcii a mock kartu
so štítkom „Ukážka čoskoro“ pokojne zmaž.
