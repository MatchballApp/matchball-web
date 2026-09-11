# Matchball — verejné stránky

Ochrana osobných údajov, podmienky používania a popis služby.

**Súbory tu neupravuj ručne.** Generujú sa zo zdroja aplikácie
(`src/legal/content.ts`) skriptom `scripts/build-legal-page.mjs`
v súkromnom repozitári `MatchballApp/matchball`.

Dôvod: ten istý text musí byť v aplikácii aj na webe. Keby sa udržiavali
zvlášť, po prvej zmene by sa rozišli — a rozpor medzi tým, čo sľubujeme
na webe a čo v aplikácii, je pri kontrole to najhoršie, čo môže nastať.

## Stránky trénerov a skupín (`t/`, `treneri/`, `skupiny/`)

Verejná stránka trénera na `matchballapp.com/t/<slug>`, adresár na
`matchballapp.com/treneri/` a zoznam sparingových skupín na
`matchballapp.com/skupiny/`. **Tieto priečinky neupravuj ručne** — generujú sa
skriptom a najbližší nočný beh každú ručnú zmenu prepíše.

### Čo generátor robí

`scripts/generuj-stranky-trenerov.mjs` (Node 20, bez závislostí):

1. Zavolá RPC `public_coach_pages` v Supabase — vráti trénerov, ktorí majú
   verejnú stránku zapnutú, aj s cenníkom a poslednými hodnoteniami.
2. Stiahne fotky z privátneho bucketu `profile-photos` do `t/<slug>/foto.jpg`
   a `t/<slug>/r1.jpg`… Sťahuje len chýbajúce alebo staršie než `updated_at`
   trénera; kto fotku nemá, dostane logo v krúžku.
3. Zavolá RPC `public_sparring_groups` (migrácia 349) — verejné sparingové
   skupiny. Keď funkcia ešte nie je nasadená alebo zlyhá, beh POKRAČUJE
   a zoznam skupín ostane prázdny; stránky trénerov to neovplyvní.
4. Vygeneruje `t/<slug>/index.html`, `treneri/index.html`,
   `treneri/<mesto>/index.html`, `skupiny/index.html`,
   `skupiny/<mesto>/index.html`, `sitemap.xml`, `.nojekyll` a `.well-known/`,
   a doplní dlaždice miest na hlavnej stránke (bloky medzi značkami
   `<!-- mesta-treneri:start -->` a `<!-- mesta-skupiny:start -->`
   v `index.html`; zvyšok `index.html` sa nedotýka).
5. Zmaže `t/<slug>` trénerov, ktorí už v dátach nie sú (stránku si vypli),
   a mestá bez skupín v `skupiny/`. Mimo `t/`, `treneri/` a `skupiny/`
   nemaže nič.

Ceny sú prepísané 1:1 zo `src/utils/pricing.ts` v repe appky, aby stránka
sľubovala presne tú sumu, akú hráč zaplatí v appke. **Pri každej zmene cenníkovej
logiky v appke treba prepísať aj hlavičku toho skriptu.**

`scripts/sport-katalog.json` je kópia `docs/sport-katalog.json` z repa appky —
jediný zdroj mien, poradia, slova pre miesto (`venue_sk`) a toho, či ide
o šport alebo o službu bez levelu (`kind`), pre všetkých 41 športov a služieb.
**Needituj ho tu ručne** — pri zmene katalógu v appke skopíruj súbor znova.
Generátor z neho stavia `SPORT_ORDER`/`SPORT_NAZOV`/`SPORT_GENITIV`/`SPORT_SLUG`
aj zoznam služieb (`SPORT_DRUH`); cenník služby (fyzioterapia a pod.) číta
z `pricing_by_sport[<kód>].items`, nie z hodinových pásiem.

Maskoti skupín v `avatary/` sú zmenšené kópie `src/assets/avatars/` z repa
appky (224 px, JPEG). Generátor ich nesťahuje — sú v repe natrvalo a odkazuje
sa na ne podľa `avatar_id`. Keď v appke pribudne nový maskot, treba jeho
obrázok doniesť sem, inak karta skupiny ukáže logo.

QR kód sa kreslí pri generovaní (`scripts/qrcode.js`, kópia balíka
`qrcode-generator`, MIT). Zámerne, nie cez cudziu QR službu: kto si otvorí
stránku trénera, nemá byť ohlásený tretej strane.

### Spustenie ručne

```sh
SUPABASE_URL=https://<projekt>.supabase.co \
SUPABASE_SERVICE_KEY=<service role key> \
node scripts/generuj-stranky-trenerov.mjs
```

Bez databázy, len na skúšku vzhľadu:

```sh
node scripts/generuj-stranky-trenerov.mjs --fixture scripts/fixture-treneri.json
```

Skript je idempotentný — druhý beh nad tými istými dátami nezapíše nič, takže
z neho nevznikajú prázdne commity.

### Automaticky

`.github/workflows/stranky-trenerov.yml` beží každú noc o 03:00 UTC (a dá sa
pustiť ručne cez *Run workflow*). Commituje a pushuje len vtedy, keď sa niečo
naozaj zmenilo.

Potrebuje dva secrets v nastaveniach repozitára (*Settings → Secrets and
variables → Actions*):

| Secret | Hodnota |
|---|---|
| `SUPABASE_URL` | `https://<produkčný projekt>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | service role key toho projektu |

### Hlboké odkazy

`.well-known/apple-app-site-association` je hotový. V
`.well-known/assetlinks.json` je zatiaľ **placeholder `"DOPLNIT"`** — odtlačok
podpisového kľúča treba vypísať z EAS:

```sh
eas credentials     # Android → production → Keystore → SHA-256 Fingerprint
```

a nahradiť ho v skripte (konštanta v sekcii „GitHub Pages a hlboké odkazy").
Kým tam placeholder je, Android odkazy na `/t/*` neoverí a otvorí ich
v prehliadači namiesto appky. iOS funguje.
