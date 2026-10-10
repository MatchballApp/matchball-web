# Matchball — verejné stránky

Ochrana osobných údajov, podmienky používania a popis služby.

**Súbory tu neupravuj ručne.** Generujú sa zo zdroja aplikácie
(`src/legal/content.ts`) skriptom `scripts/build-legal-page.mjs`
v súkromnom repozitári `MatchballApp/matchball`.

## Kde je zdroj vzhľadu

Hlavná stránka (`index.html`) sa píše v repe appky, v `web/index.html`, a sem
sa kopíruje hotová — aj s `logo.webp`, `logo.png`, `og.jpg`, `favicon.ico`,
`icon-*.png` a `img/*.webp`. **Tá kópia je zdroj pravdy o dizajne**: paleta
(zelená `#1E9E52` / `#15803D`, limetka `#51E041`, tmavozelená `#071A13`, modrá
`#1378ED`), písmo Outfit, plávajúca tmavá sklenená hlavička, guľaté tlačidlá
a tmavá pätička. Podstránky (generátor nižšie, `legal/`, `g/`, `i/`, `auth/`)
majú vlastné inline CSS, ale rovnaké tokeny a rovnakú hlavičku s pätičkou —
pri zmene vzhľadu hlavnej stránky ich treba prepísať s ňou.

`avatar-zastupny.webp` je zástupná fotka trénera a partie: tmavozelený štvorec
so srdcom, ktorý `object-fit:cover` oreže na čistý kruh. Samotné `logo.webp` je
priehľadné srdce — v okrúhlom rámčeku by z neho ostali odseknuté krídla.

Dôvod: ten istý text musí byť v aplikácii aj na webe. Keby sa udržiavali
zvlášť, po prvej zmene by sa rozišli — a rozpor medzi tým, čo sľubujeme
na webe a čo v aplikácii, je pri kontrole to najhoršie, čo môže nastať.

## Systém vzhľadu (revízia 9. 10. 2026)

Jedna myšlienka: **spájanie**. Nesie ju prechod z loga (modrá `#1378ED` →
tyrkysová → zelená), v CSS ako `--grad` (na svetlom) a `--grad-on-dark` (na
tmavom). Je to **akcent, nie farba akcie**: druhá veta sloganu, čiarka pred
nadpisom sekcie, čísla pilierov, „ball" v mene značky a žiara tmavých panelov.
Akcie ostávajú zelené ako v appke (`#15803D`, na tmavom limetka `#51E041`).

- **Hlavná stránka**: úvod (slogan + video) → tri piliere (spoluhráč, partia,
  tréner; mestá dopĺňa generátor) → odmeny → 42 športov → pre trénerov →
  zdravie a služby → férové podmienky (štyri fakty + platby) → výzva.
  Tmavé plochy sú zaoblené panely (`.panel.on-dark`), úvod je zaoblený dole.
- **Podstránky z generátora** majú tie isté tokeny v `CSS_ZAKLAD`, tú istú
  hlavičku (aj s menu na telefóne) a pätičku. Pri zmene tokenov na hlavnej
  stránke ich treba prepísať aj tam.
- **Malé stránky** (`stiahnut/`, `video/`, `i/`, `g/`) majú na konci `<style>`
  rovnaký blok „Spoločná koža malých stránok" — pri zmene ho prepíš vo
  všetkých štyroch. Logiku týchto stránok (rozpoznanie zariadenia, kódy
  pozvánok, presmerovanie) revízia nemenila.
- **Právne stránky** (`legal/`) generuje skript v repe appky a tento systém
  zatiaľ nemajú („ball" v prechode, menu na telefóne) — treba ich doplniť tam.

### Video

`video/matchball-hero-9x14.mp4` (720×1120, úvod) a `video/matchball-9x14.mp4`
(1080×1680, `/video/`) sú orezané zo zvislého 9:16: preč je horných 240 px
z 1920, prázdny pás pre Instagram. Spodok sa orezať nedá — telefóny vo videu
siahajú po okraj. Staré 9:16 súbory (`matchball.mp4`, `matchball-hero.mp4`,
`poster.jpg`) ostávajú pre staré odkazy. Výroba z hotového mp4:

```sh
ffmpeg -i matchball-1080.mp4 -vf "crop=1080:1680:0:240,scale=720:1120" \
  -c:v libx264 -b:v 610k -c:a aac -b:a 96k -movflags +faststart matchball-hero-9x14.mp4
```

Zapnutý zvuk si stránka pamätá v `sessionStorage` (`mbZvuk`) do zavretia karty
— platí na hlavnej stránke aj na `/video/`. Nie je to meranie a nikam sa
neposiela.

### Filter na zoznamoch

Tréneri: riadky **Šport** a **Mesto** sú odkazy na hotové podstránky
(`/treneri/<šport>/`, `/treneri/<mesto>/`, `/treneri/<šport>/<mesto>/`) a
ukážu sa, len keď je z čoho vyberať; šport je napísaný na každej karte.
Ponúkajú sa len športy a mestá, kde je aspoň jeden zverejnený tréner.
Partie: filter športu beží v prehliadači (partia podstránku športu nemá).

Kto je „zverejnený tréner", určuje RPC `public_coach_pages`: schválený
(`approved_at`), aktívny, so zapnutou verejnou stránkou, s cenou a **s fotkou
alebo textom o sebe**. Schválený tréner bez fotky aj bez textu na webe nie je.

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
o šport alebo o službu bez levelu (`kind`), pre všetkých 42 športov a služieb.
**Needituj ho tu ručne** — pri zmene katalógu v appke skopíruj súbor znova.
Generátor z neho stavia `SPORT_ORDER`/`SPORT_NAZOV`/`SPORT_GENITIV`/`SPORT_SLUG`
aj zoznam služieb (`SPORT_DRUH`); cenník služby (fyzioterapia a pod.) číta
z `pricing_by_sport[<kód>].items`, nie z hodinových pásiem.

Maskoti skupín v `avatary/` sú zmenšené kópie (320 px) `src/assets/avatars/` z repa
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
node scripts/generuj-stranky-trenerov.mjs \
  --fixture scripts/fixture-treneri.json \
  --fixture-skupiny scripts/fixture-skupiny.json
```

`--fixture-skupiny` je nepovinné; bez neho vyjde stránka partií prázdna, lebo
skupiny majú vlastné RPC. **Po skúške vráť vygenerované súbory späť**
(`git checkout -- t treneri skupiny sitemap.xml index.html && git clean -fd t treneri skupiny`),
nech sa do repa nedostanú vymyslení tréneri; nočný beh ich síce prepíše, ale až
o 03:00 UTC.

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
