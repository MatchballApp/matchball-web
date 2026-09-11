#!/usr/bin/env node
//
// Generátor verejných stránok trénerov (matchballapp.com/t/<slug>) a zoznamu
// sparingových skupín (matchballapp.com/skupiny/).
//
// Beží v GitHub Action raz denne: vytiahne trénerov zo Supabase, stiahne fotky
// z privátneho bucketu a vygeneruje statické HTML, ktoré GitHub Pages servíruje.
//
// Skupiny (migrácia 349) sú druhý, nezávislý zdroj: keď ich RPC nie je
// nasadené alebo zlyhá, stránky trénerov sa vygenerujú tak či tak a zoznam
// skupín zostane prázdny — pozri `nacitajSkupiny`.
//
// Spustenie ručne:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/generuj-stranky-trenerov.mjs
//   node scripts/generuj-stranky-trenerov.mjs --fixture scripts/fixture-treneri.json
//
// Bez závislostí (Node 20: fetch, fs, path). `qrcode.js` je kópia balíka
// qrcode-generator (MIT) z appky — QR sa kreslí TU, pri generovaní, aby
// stránka nemusela volať cudziu službu. Návštevník verejnej stránky trénera
// nemá byť ohlásený tretej strane len preto, že si pozrel cenník.
//
// Skript je zámerne idempotentný a deterministický: rovnaký vstup dá bajt na
// bajt rovnaký výstup, inak by Action robil prázdne commity každú noc.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const qrcode = require('./qrcode.js');
// Slug je síce ASCII, ale mesto ani meno v QR nikdy nebudú — UTF-8 kodér je
// súčasťou toho istého súboru, stačí ho zapnúť.
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, '..');

const WEB_ORIGIN = 'https://matchballapp.com';
const APP_STORE = 'https://apps.apple.com/sk/app/matchball/id6804171137';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=sk.matchball.app';
const APPLE_APP_ID = 'GMG42P2BPM.sk.matchball.app';
const ANDROID_PACKAGE = 'sk.matchball.app';
const BUCKET = 'profile-photos';

// ═══════════════════════════════════════════════════════════════════════════
//  CENY — prevzaté 1:1 zo `src/utils/pricing.ts` v repe appky.
//
//  Od migrácie 340 (Matchball je zadarmo) je `hourly_rate`/`pricing` cena
//  TRÉNERA — Matchball si z nej nič neberie. Presne tú web aj ukazuje, bez
//  akéhokoľvek prepočtu: appka od 9. 9. 2026 popoludní (rozhodnutie majiteľa)
//  robí to isté, aby hráč videl jedno pekné celé číslo a doplatok za kartu až
//  pri platbe. Keby web pripočítaval poplatok, hráč by si po otvorení appky
//  myslel, že zlacnelo.
//
//  Poplatok za platbu kartou (5 % + 0,30 €/7,50 Kč) preto na cenníku nestojí
//  ako suma, len ako jedna veta pod ním. Nie je podmienená spôsobmi platby
//  trénera: `public_coach_pages()` (335/336) `payment_methods` nevracia.
//
//  Pri každej zmene v `pricing.ts` treba prepísať aj toto. Zdroj:
//  Matchball/src/utils/pricing.ts (GROUP_TIERS … minTierRate).
// ═══════════════════════════════════════════════════════════════════════════

const GROUP_TIERS = [1, 2, 3, 4];
const OPEN_TIER = 4;
const MAX_GROUP_PLAYERS = 12;
const TIME_BAND_KEYS = ['morning', 'afternoon', 'evening', 'custom'];
const MAX_TIME_BANDS = 4;
const TIME_BAND_STEP_MIN = 30;
const TIME_BAND_MAX_PCT = 50;
const DAY_MINUTES = 24 * 60;

// `Math.round(n*100)/100` sa pri polovičnom cente rozchádza s Postgresom;
// `toPrecision(12)` tú stopu po plávajúcej čiarke zmaže. (pricing.ts:round2)
function round2(n) {
  const scaled = Number((Math.abs(n) * 100).toPrecision(12));
  return Math.sign(n) * Math.round(scaled) / 100;
}

function numAt(map, key) {
  const v = map[key];
  return typeof v === 'number' && v > 0 ? v : 0;
}

// ── Poplatok za platbu kartou (pricing.ts: PLATFORM_PCT, PLATFORM_FIXED) ──
//
// Matchball si z ceny trénera neberie nič; toto je náklad platobnej brány plus
// záruka vrátenia a storno pravidlá, ktoré appka vymáha len pri karte.
const PLATFORM_PCT = 0.05;
const PLATFORM_FIXED = { EUR: 0.30, CZK: 7.50 };
// Ostávajú len ako čísla do vety pod cenníkom. Prepočty (`customerTotal`,
// `groupCustomerTotal`, `customerPerPerson`) tu boli, kým web ukazoval kartové
// ceny; sú preč zámerne — kópia vzorca, ktorú nič nevolá, sa od `pricing.ts`
// ticho rozíde a raz sa niekomu zdá, že jej môže veriť.
function fixedFor(currency) {
  return PLATFORM_FIXED[currency] ?? PLATFORM_FIXED.EUR;
}

function perPersonRate(pricing, players) {
  const map = pricing ?? {};
  const tier = Math.min(Math.max(Math.trunc(players), 2), OPEN_TIER);
  const pp = map.per_person;
  if (pp && typeof pp === 'object') {
    const v = pp[String(tier)];
    if (typeof v === 'number' && v > 0) return v;
  }
  const total = numAt(map, String(tier));
  return total > 0 ? round2(total / tier) : 0;
}

// Do štvorky sa berie ULOŽENÝ celok, nie súčin ceny za osobu — delenie a spätné
// násobenie sa o cent rozíde. Nad štvorkou sa násobí, tam žiadny celok nie je.
function groupRateFor(pricing, hourlyRate, players) {
  const map = pricing ?? {};
  const n = Math.trunc(players);
  if (n <= 1) {
    const one = numAt(map, '1');
    return one > 0 ? one : Math.max(hourlyRate, 0);
  }
  if (n > MAX_GROUP_PLAYERS) return 0;
  if (n <= OPEN_TIER) return numAt(map, String(n));
  const per = perPersonRate(map, OPEN_TIER);
  return per > 0 ? round2(per * n) : 0;
}

// Ponúkané pásma tak, ako ich má vidieť hráč — `price` je cena TRÉNERA za celú
// skupinu danej veľkosti. (pricing.ts:getTiers)
function getTiers(pricing, hourlyRate) {
  const map = pricing ?? {};
  const tiers = [];
  for (const p of GROUP_TIERS) {
    if (p === 1) {
      const price = numAt(map, '1') || hourlyRate;
      if (price > 0) tiers.push({ players: 1, price });
    } else {
      const price = groupRateFor(map, hourlyRate, p);
      if (price > 0) tiers.push({ players: p, price });
    }
  }
  return tiers;
}

function isStepMinute(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DAY_MINUTES
    && v % TIME_BAND_STEP_MIN === 0;
}

// Prísne zámerne: pásma musia na seba nadväzovať bez dier a prekrytí. Server má
// tú istú kontrolu v `time_bands_problem()` (migrácia 334).
function validTimeBands(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value;
  if (typeof raw.enabled !== 'boolean') return null;
  if (raw.weekend !== 'same' && raw.weekend !== 'base') return null;
  if (!Array.isArray(raw.bands)) return null;
  if (raw.bands.length < 1 || raw.bands.length > MAX_TIME_BANDS) return null;

  const bands = [];
  let prevEnd = -1;
  for (const item of raw.bands) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const b = item;
    if (!TIME_BAND_KEYS.includes(b.key)) return null;
    if (!isStepMinute(b.start_min) || !isStepMinute(b.end_min)) return null;
    if (b.end_min <= b.start_min) return null;
    const pct = b.pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
    if (Math.abs(pct) > TIME_BAND_MAX_PCT) return null;
    if (round2(pct) !== pct) return null;
    if (prevEnd >= 0 && b.start_min !== prevEnd) return null;
    prevEnd = b.end_min;
    bands.push({ key: b.key, start_min: b.start_min, end_min: b.end_min, pct });
  }
  return { enabled: raw.enabled, weekend: raw.weekend, bands };
}

function timeBandsOf(pricing) {
  const tb = validTimeBands((pricing ?? {}).time_bands);
  return tb && tb.enabled ? tb : null;
}

// Pri nulovom percente sa NENÁSOBÍ — server preskakuje výpočet rovnako, takže
// sa tie dve cesty nemôžu rozísť ani o zaokrúhlenie.
function applyBandPct(rate, pct) {
  if (!pct) return rate;
  return round2(rate * (1 + pct / 100));
}

// ── Cenník služby — položky namiesto hodinových pásiem (pricing.ts:serviceItems) ──
//
// Fyzioterapia nie je tenis: predáva sa ÚKON („Vstupné vyšetrenie 60 min 45 €"),
// nie hodina delená medzi hráčov. Cenník služby má vlastný tvar — pole `items`
// v tom istom objekte cenníka.
const SERVICE_DURATIONS = [30, 45, 60, 90, 120];
const MAX_SERVICE_ITEMS = 5;

function serviceItems(pricing) {
  const raw = (pricing ?? {}).items;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    const { minutes, price } = it;
    if (!name) continue;
    if (!SERVICE_DURATIONS.includes(minutes)) continue;
    if (typeof price !== 'number' || !(price > 0)) continue;
    out.push({ name, minutes, price: round2(price) });
    if (out.length >= MAX_SERVICE_ITEMS) break;
  }
  return out;
}

/** Cenník trénera pre KONKRÉTNY šport — `pricing_by_sport[kód]`, inak legacy `pricing`. */
function pricingZaSport(coach, sportKod) {
  const poSporte = coach.pricing_by_sport && typeof coach.pricing_by_sport === 'object'
    ? coach.pricing_by_sport[sportKod]
    : null;
  return (poSporte && typeof poSporte === 'object') ? poSporte : (coach.pricing ?? {});
}

// Najnižšia sadzba individuálneho tréningu naprieč pásmami — pre „od X €".
function minTierRate(pricing, hourlyRate) {
  const base = groupRateFor(pricing, hourlyRate, 1);
  const bands = timeBandsOf(pricing);
  if (!bands || !(base > 0)) return base;
  const pcts = bands.bands.map((b) => b.pct);
  if (bands.weekend === 'base') pcts.push(0);
  return applyBandPct(base, Math.min(...pcts));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Texty a formátovanie
// ═══════════════════════════════════════════════════════════════════════════

// Zameranie sa v appke od UX kola 9/2026 nezbiera a `sk.json` k nemu preto
// nemá kľúče (`search.filters.specializations` je prázdny objekt). Názvy sú tu
// napísané tak, ako ich appka používala predtým; keď sa kľúče do sk.json
// vrátia, treba ich zosúladiť.
const ZAMERANIE = {
  beginners: 'Začiatočníci',
  children: 'Deti',
  kids: 'Deti',
  juniors: 'Juniori',
  adults: 'Dospelí',
  competitive: 'Závodní hráči',
  seniors: 'Seniori',
  fitness: 'Kondícia',
};

// `profile.lang_*` v sk.json pokrýva len sk/cs/en; zvyšok je dopísaný v tom
// istom tvare (názov jazyka po slovensky, prvé písmeno veľké).
const JAZYKY = {
  sk: 'Slovenčina',
  cs: 'Čeština',
  en: 'Angličtina',
  de: 'Nemčina',
  hu: 'Maďarčina',
  uk: 'Ukrajinčina',
  ru: 'Ruština',
  pl: 'Poľština',
};

// sk.json: coach_pricing.court_included / court.on_site_note / court.in_app_note
const KURT = {
  included: (slovo) => `${slovo} je v cene`,
  on_site: (slovo) => `${slovo} sa platí na mieste`,
  in_app: (slovo, suma) => `${slovo} ${suma} navyše, platí sa v appke`,
};

// ═══════════════════════════════════════════════════════════════════════════
//  Športy a služby — jediný zdroj pravdy je `scripts/sport-katalog.json`,
//  kópia `docs/sport-katalog.json` z repa appky (41 športov/služieb v 5
//  kategóriách, rozšírenie 10. 9. 2026). Pri zmene katalógu v appke treba
//  kópiu tu prepísať a tento súbor si z nej sám dovytiahne mená, slovo pre
//  miesto (`venue_sk`) aj to, či ide o šport (level, sparing) alebo o
//  službu bez levelu (`kind: 'service'`).
//
//  Starí tréneri bez `sports` v RPC dostávajú `['tennis']` (pozri
//  `sportyOf`), takže zvyšok generátora sa na pole `sports` môže spoľahnúť
//  vždy.
// ═══════════════════════════════════════════════════════════════════════════

const SPORT_KATALOG = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'sport-katalog.json'), 'utf8'));

const SPORT_ORDER = SPORT_KATALOG.sports.slice().sort((a, b) => a.sort - b.sort).map((s) => s.code);

const SPORT_NAZOV = Object.fromEntries(SPORT_KATALOG.sports.map((s) => [s.code, s.sk]));

// Genitív pre „Tréning …" na profile, „Tréner(i) …" a nadpisy adresára.
const SPORT_GENITIV = Object.fromEntries(SPORT_KATALOG.sports.map((s) => [s.code, s.sk_gen]));

// Slovo pre miesto, kde sa šport/služba odohráva — „kurt", „ihrisko", „ordinácia"…
const SPORT_MIESTO = Object.fromEntries(SPORT_KATALOG.sports.map((s) => [s.code, s.venue_sk]));

// Kto to poskytuje, bez rodu — „tréner", „fyzioterapeut", „masér"…
const SPORT_POSKYTOVATEL = Object.fromEntries(SPORT_KATALOG.sports.map((s) => [s.code, s.provider_sk]));

// „sport" (level, sparing, skupiny) vs. „service" (cenník s položkami, bez levelu).
const SPORT_DRUH = Object.fromEntries(SPORT_KATALOG.sports.map((s) => [s.code, s.kind]));

const SPORT_SLUG = Object.fromEntries(SPORT_KATALOG.sports.map((s) => [s.code, slugify(s.sk)]));

// Slovo pre miesto, kde sa trénuje/poskytuje — podľa športu/služby trénera;
// pri kombinácii viacerých kódov naraz sa berie ten prvý (deterministické
// poradie `sportyOf`), rovnaké slovo majú aj titulok, aj text pri cenníku.
function miestoSlovoPre(sportyKodmi) {
  const slovo = SPORT_MIESTO[sportyKodmi[0]] || 'kurt';
  return velkePismeno(slovo);
}

/** Je táto sada kódov služba (fyzioterapia a pod.), nie šport? */
function jeSluzba(sportyKodmi) {
  return sportyKodmi.length > 0 && sportyKodmi.every((k) => SPORT_DRUH[k] === 'service');
}

/** Kódy športov trénera v pevnom, deterministickom poradí; bez záznamu = tenis. */
function sportyOf(coach) {
  const raw = Array.isArray(coach.sports) ? coach.sports : [];
  const znamych = SPORT_ORDER.filter((s) => raw.includes(s));
  return znamych.length ? znamych : ['tennis'];
}

/** „a, b, c" → „a, b a c" — slovenské vypočítavanie zoznamu. */
function spojSpojkou(zoznam) {
  if (zoznam.length === 0) return '';
  if (zoznam.length === 1) return zoznam[0];
  return `${zoznam.slice(0, -1).join(', ')} a ${zoznam[zoznam.length - 1]}`;
}

function velkePismeno(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Ikony športov — rovnaký štýl ako IKONA (viewBox 24×24, stroke 1.8), len
// dosť jednoduché na to, aby boli čitateľné aj na 14px štítku.
const SPORT_IKONA = {
  tennis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"></circle><path d="M4.6 7c2.8 2.2 2.8 7.8 0 10M19.4 7c-2.8 2.2-2.8 7.8 0 10"></path></svg>',
  badminton: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.2" r="1.6"></circle><path d="M12 6v3M8.2 20.5L10.6 9M15.8 20.5L13.4 9M5.2 17L10 9M18.8 17L14 9"></path></svg>',
  padel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="2.6" width="13" height="13.4" rx="6.5"></rect><path d="M12 16v5.4"></path><circle cx="9.3" cy="7" r=".5" fill="currentColor" stroke="none"></circle><circle cx="12" cy="6.4" r=".5" fill="currentColor" stroke="none"></circle><circle cx="14.7" cy="7" r=".5" fill="currentColor" stroke="none"></circle><circle cx="9.3" cy="10.6" r=".5" fill="currentColor" stroke="none"></circle><circle cx="12" cy="11.2" r=".5" fill="currentColor" stroke="none"></circle><circle cx="14.7" cy="10.6" r=".5" fill="currentColor" stroke="none"></circle></svg>',
  squash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6c3.5.5 5.7 3.2 5.2 6.8-.5 3.5-3.6 5.7-7.2 5.2-3.5-.5-5.7-3.6-5.2-7.1.4-3 2.9-5.2 5.9-5.1"></path><path d="M8.6 14.3L3.4 21.4"></path></svg>',
  table_tennis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="9.5" r="6.3"></circle><path d="M14.7 13.8L20 19.5"></path></svg>',
  pickleball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="12" rx="4"></rect><path d="M12 15v6"></path></svg>',
};

// Ostatné kategórie nemajú vlastnú ikonu pre každý šport zvlášť (bolo by ich
// 31) — jedna ikona kategórie stačí, na štítku 14px sa detail stratí.
const KATEGORIA_IKONA = {
  team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"></circle><path d="M12 3.4v17.2M4 8.6h16M4 15.4h16"></path></svg>',
  fitness: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8v8M18 8v8M3 12h1.5M19.5 12H21M6 12h12"></path></svg>',
  individual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5.4" r="2"></circle><path d="M12 8v5.4M12 13.4l-4 7M12 13.4l4 7M8.4 10l3.6 1.6 3.6-3"></path></svg>',
  health: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7.5-4.6-9.8-9.3C.6 8 2.2 4.6 5.6 4.1c2-.3 3.7.6 4.4 2 .7-1.4 2.4-2.3 4.4-2 3.4.5 5 3.9 3.4 7.6C19.5 16.4 12 21 12 21z"></path></svg>',
};

const SPORT_KATEGORIA = Object.fromEntries(SPORT_KATALOG.sports.map((s) => [s.code, s.category]));

function ikonaPreSport(kod) {
  return SPORT_IKONA[kod] || KATEGORIA_IKONA[SPORT_KATEGORIA[kod]] || '';
}

function sportPillHtml(kod, trieda) {
  return `<span class="${trieda}">${ikonaPreSport(kod)}${esc(SPORT_NAZOV[kod] || kod)}</span>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Sparingové skupiny — texty (migrácia 349, `public_sparring_groups()`)
//
//  Skupina nie je inzerát trénera: von ide len to, čo vydá RPC — názov, šport,
//  mesto, miesto, kedy sa hráva, koľko je miest, úroveň, krátka upútavka a
//  organizátor krstným menom. O peniazoch skupín web nehovorí vôbec (349).
// ═══════════════════════════════════════════════════════════════════════════

// sk.json: sparring.level_short (množné číslo, malými — do vety sa prvé písmeno
// zväčší). Rovnaké slová ako v appke, aby sa úroveň nikde nevolala inak.
const UROVNE = {
  beginner: 'začiatočníci',
  intermediate: 'mierne pokročilí',
  advanced: 'pokročilí',
  competitive: 'turnajoví',
};

const UROVEN_PORADIE = ['beginner', 'intermediate', 'advanced', 'competitive'];

// ISO deň (1 = pondelok … 7 = nedeľa), rovnako ako `recurrence.weekday` (342).
const DNI = ['', 'Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok', 'Sobota', 'Nedeľa'];

/**
 * Úroveň skupiny jednou vetou: „Všetky úrovne", „Pokročilí" alebo
 * „Mierne pokročilí – pokročilí".
 *
 * Keď je vyplnená len jedna hranica, druhá je koniec stupnice — skupina
 * „od pokročilých" je otvorená aj turnajovým, nie len pokročilým.
 */
function urovenText(min, max) {
  const od = UROVEN_PORADIE.indexOf(String(min ?? ''));
  const doo = UROVEN_PORADIE.indexOf(String(max ?? ''));
  if (od < 0 && doo < 0) return 'Všetky úrovne';
  const a = od < 0 ? 0 : od;
  const b = doo < 0 ? UROVEN_PORADIE.length - 1 : doo;
  const zdola = Math.min(a, b);
  const zhora = Math.max(a, b);
  if (zdola === 0 && zhora === UROVEN_PORADIE.length - 1) return 'Všetky úrovne';
  if (zdola === zhora) return velkePismeno(UROVNE[UROVEN_PORADIE[zdola]]);
  return `${velkePismeno(UROVNE[UROVEN_PORADIE[zdola]])} – ${UROVNE[UROVEN_PORADIE[zhora]]}`;
}

/**
 * Kedy sa hráva: „Nedeľa 18:00–20:00".
 *
 * Minúty v `recurrence` sú nástenný čas na kurte (Europe/Bratislava), preto sa
 * tu nič neprepočítava cez `Date` — rovnaká úvaha ako v appke
 * (`src/utils/sparringRecurrence.ts`). Jednorazový termín (`type:"once"`)
 * a neznámy tvar vrátia prázdny reťazec a riadok sa jednoducho nevykreslí:
 * dátum jedného stretnutia by na stránke, ktorá sa prepisuje raz za noc,
 * zostal visieť aj po ňom.
 */
function kedyText(recurrence) {
  const r = recurrence && typeof recurrence === 'object' ? recurrence : null;
  if (!r || r.type !== 'weekly') return '';
  const den = DNI[Number(r.weekday)] || '';
  const od = Number(r.start_min);
  const doo = Number(r.end_min);
  if (!den || !Number.isFinite(od) || !Number.isFinite(doo)) return '';
  return `${den} ${cas(od)}–${cas(doo)}`;
}

/** Slovenské skloňovanie počtu skupín. */
function pocetSkupin(n) {
  return `${n} ${pocet(n, 'skupina', 'skupiny', 'skupín')}`;
}

/**
 * Maskot skupiny. `avatar_id` je názov obrázka zo zbierky maskotov appky
 * (`src/assets/avatars/` v repe appky, zmenšená kópia leží v `avatary/`);
 * keď skupina svojho nemá, berie sa maskot organizátora — rovnako ako v appke
 * (migrácia 346). Neznámy názov nekreslí nič a karta dostane značku Matchballu:
 * cudzí reťazec z databázy sa nesmie dostať do cesty k súboru.
 */
function avatarSubor(id) {
  const s = String(id ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{0,15}$/.test(s)) return null;
  return fs.existsSync(path.join(ROOT, 'avatary', `${s}.jpg`)) ? `/avatary/${s}.jpg` : null;
}

const MESIACE = [
  'január', 'február', 'marec', 'apríl', 'máj', 'jún',
  'júl', 'august', 'september', 'október', 'november', 'december',
];

// sk.json: booking.band_morning / _afternoon / _evening
const PASMA = { morning: 'Doobeda', afternoon: 'Poobede', evening: 'Večer', custom: 'Vlastný čas' };

/** Slovenské číslo: desatinná čiarka, celé sumy bez „,00". */
function cislo(n) {
  const v = round2(n);
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return s.replace('.', ',');
}

/** Hodnotenie sa píše na jedno desatinné miesto — „4,7“, nie „4,70“. */
function hodnotenie(n) {
  return (Math.round(Number(n) * 10) / 10).toFixed(1).replace('.', ',');
}

function suma(n, currency) {
  // Nezalomiteľná medzera pred menou — „20 €" sa nesmie rozpadnúť na dva riadky.
  return currency === 'CZK' ? `${cislo(n)}\u00a0Kč` : `${cislo(n)}\u00a0€`;
}

function cas(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function mesiacRok(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MESIACE[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Meno hodnotiaceho hráča tak, ako smie stáť na verejnej, Googlom indexovanej
 * stránke: krstné meno a z priezviska len začiatočné písmeno („Peter N.").
 *
 * Hráč súhlasil s tým, že jeho hodnotenie uvidí iný hráč v appke — nie s tým,
 * že sa jeho celé meno dá vygoogliť. RPC dnes vracia u niektorých hráčov celé
 * meno, takže sa skracuje tu; keď ho začne skracovať server, je to nečinná
 * operácia (meno bez priezviska prejde nezmenené).
 */
function menoRecenzenta(raw) {
  const casti = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  if (casti.length === 0) return 'Hráč';
  if (casti.length === 1) return casti[0];
  return `${casti[0]} ${[...casti[1]][0].toUpperCase()}.`;
}

/** Slovenské skloňovanie počtu hodnotení / trénerov. */
function pocet(n, one, few, other) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return other;
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTML pomôcky
// ═══════════════════════════════════════════════════════════════════════════

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Text do JSON-LD aj do JS reťazca — `</script>` musí zostať neškodný. */
function json(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Diakritika preč, medzery na pomlčky — z `city_key` na kus adresy. */
function slugify(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  QR kód → inline SVG
// ═══════════════════════════════════════════════════════════════════════════

/**
 * QR ako SVG bez externého obrázka. Jeden `<path>` zo všetkých tmavých modulov:
 * `<rect>` na modul by pri 29×29 znamenal stovky uzlov navyše.
 */
function qrSvg(text, { size, label }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const parts = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) { c++; continue; }
      let end = c;
      while (end < n && qr.isDark(r, end)) end++;
      parts.push(`M${c} ${r}h${end - c}v1h-${end - c}z`);
      c = end;
    }
  }
  return `<svg viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}">`
    + `<rect width="${n}" height="${n}" fill="#fff"></rect>`
    + `<path fill="#0B100D" d="${parts.join('')}"></path></svg>`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Ikony (inline SVG, rovnaké ako v návrhu)
// ═══════════════════════════════════════════════════════════════════════════

const IKONA = {
  hviezda: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.4 6.2 20.45l1.1-6.5-4.7-4.6 6.5-.95z"/></svg>',
  fajka: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l4.5 4.5 10.5-10.5"></path></svg>',
  kalendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3.5"></rect><path d="M8 2.8v4M16 2.8v4M3.5 10h17"></path></svg>',
  sprava: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.8a8.3 8.3 0 0 1-11.9 7.5L4 21l1.8-4.9A8.3 8.3 0 1 1 21 11.8z"></path></svg>',
  zdielat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5V3.5"></path><path d="M8 7.2L12 3.2l4 4"></path><path d="M5 13.5v6a1.6 1.6 0 0 0 1.6 1.6h10.8a1.6 1.6 0 0 0 1.6-1.6v-6"></path></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21.5s7-5.9 7-11.4a7 7 0 1 0-14 0c0 5.5 7 11.4 7 11.4z"></path><circle cx="12" cy="10" r="2.6"></circle></svg>',
  slnko: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6"></path></svg>',
  mesiac: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 14.3A8.6 8.6 0 0 1 9.7 3.6a8.6 8.6 0 1 0 10.7 10.7z"></path></svg>',
  hodiny: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"></circle><path d="M12 7.2V12l3.2 2"></path></svg>',
  sipka: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12h15M13.5 6l6 6-6 6"></path></svg>',
  zavriet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.4 12.8c0-2.2 1.8-3.3 1.9-3.35-1-1.5-2.6-1.7-3.2-1.72-1.4-.14-2.7.8-3.4.8-.7 0-1.8-.78-2.9-.76-1.5.02-2.9.87-3.7 2.2-1.6 2.7-.4 6.8 1.1 9.02.8 1.1 1.7 2.3 2.8 2.26 1.1-.04 1.5-.7 2.9-.7 1.3 0 1.7.7 2.9.68 1.2-.02 2-1.1 2.7-2.2.85-1.26 1.2-2.5 1.22-2.56-.03-.01-2.34-.9-2.36-3.57z"/><path d="M14.2 6.3c.6-.75 1-1.78.9-2.8-.87.03-1.93.58-2.56 1.32-.56.65-1.05 1.7-.92 2.7.97.07 1.96-.5 2.58-1.22z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.6 2.4v19.2c0 .62.68 1 1.2.68l14.5-9.6a.8.8 0 0 0 0-1.36L5.8 1.72a.8.8 0 0 0-1.2.68z"/></svg>',
};

function hviezdy(rating, triedaOff = 'off') {
  const plne = Math.round(rating);
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += i <= plne
      ? IKONA.hviezda
      : IKONA.hviezda.replace('<svg ', `<svg class="${triedaOff}" `);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Spoločné časti stránky (hlavička, pätička, hlava dokumentu)
// ═══════════════════════════════════════════════════════════════════════════

// Ikony sú tie isté ako v `index.html`, len absolútnou cestou — stránky trénerov
// sedia o dva priečinky hlbšie a relatívne cesty by hľadali `t/katka/favicon.ico`.
const FAVICONY = `<link rel="icon" href="/favicon.ico?v=2" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png?v=2">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=2">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png?v=2">
<meta name="theme-color" content="#0B100D">`;

const PISMO = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;

function hlavicka(aktivna) {
  const odkaz = (href, text, on) =>
    `<a${on ? ' class="on" aria-current="page"' : ''} href="${href}">${text}</a>`;
  return `<div class="nav-shell">
  <nav class="nav">
    <a class="brand" href="/">
      <img class="mark" src="/logo.webp" alt="" width="128" height="128">
      <span>Matchball</span>
    </a>
    <!-- Presne tie isté odkazy v tom istom poradí ako na domovskej stránke —
         menu sa pri prechode na Trénerov či Skupiny nesmie meniť (Martin, 11. 9.). -->
    <div class="nav-links">
      ${odkaz('/#trenerom', 'Pre trénerov')}
      ${odkaz('/#hracom', 'Pre hráčov')}
      ${odkaz('/#partie', 'Pre skupiny')}
      ${odkaz('/treneri/', 'Tréneri', aktivna === 'treneri')}
      ${odkaz('/skupiny/', 'Skupiny', aktivna === 'skupiny')}
      ${odkaz('/#ceny', 'Platby')}
    </div>
    <a class="btn btn-dark btn-sm nav-cta" href="/#stiahnut">Stiahnuť</a>
  </nav>
</div>`;
}

const PATICKA = `<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="/" style="font-size:1.25rem">
          <img class="mark" src="/logo.webp" alt="" width="128" height="128">
          <span>Matchball</span>
        </a>
        <p class="foot-about">Nájdi si trénera, parťáka na sparing alebo partiu vo svojom meste. 41 športov a služieb, účet zadarmo.</p>
      </div>
      <div>
        <h4>Stránka</h4>
        <div class="foot-links">
          <a href="/#trenerom">Pre trénerov</a>
          <a href="/#hracom">Pre hráčov</a>
          <a href="/#partie">Pre skupiny</a>
          <a href="/treneri/">Tréneri</a>
          <a href="/skupiny/">Skupiny</a>
          <a href="/#ceny">Platby</a>
        </div>
      </div>
      <div>
        <h4>Dokumenty a kontakt</h4>
        <div class="foot-links">
          <a href="/legal/privacy.html">Ochrana osobných údajov</a>
          <a href="/legal/terms.html">Podmienky používania</a>
          <a href="mailto:matchball.app@gmail.com">matchball.app@gmail.com</a>
        </div>
      </div>
    </div>
    <div class="foot-bottom">
      <span>Matchball — Martin Mucha · Košice, Slovensko · IČO 57 799 032</span>
      <span>© 2026 Matchball</span>
    </div>
  </div>
</footer>`;

/**
 * Tokeny, typografia, tlačidlá, hlavička a pätička — spoločné pre obe stránky.
 *
 * Mobil je základ, desktop je nadstavba v `@media (min-width:900px)`: návrhy
 * boli dva (Main.dc.html 1440 px, Mobil.dc.html 390 px), stránka je jedna.
 */
const CSS_ZAKLAD = `:root{
  --ink:#0B100D;--ink-soft:#141C17;--paper:#EFF2ED;--card:#FFFFFF;
  --green:#1A7A4A;--green-dark:#125E38;--green-soft:#E8F3EC;
  --lime:#C9F24E;--lime-dim:#A7D63B;--fg:#141F1A;--muted:#5E7367;--line:#E0E6DF;
  --gold:#E8B23A;
  --radius-xl:32px;--radius-lg:24px;--radius-md:16px;
  --shadow-soft:0 1px 2px rgba(20,31,26,.04),0 12px 32px -12px rgba(20,31,26,.14);
  --shadow-lift:0 2px 4px rgba(20,31,26,.06),0 24px 48px -16px rgba(20,31,26,.22);
  --ease:cubic-bezier(.22,1,.36,1);--max:1180px;
}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--fg);
  font-family:"Outfit",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-size:17px;line-height:1.65;font-weight:400;-webkit-font-smoothing:antialiased;
  overflow-x:hidden;display:flex;flex-direction:column;min-height:100vh}
img,svg{display:block;max-width:100%}
a{color:inherit;text-decoration:none}
button{font:inherit;color:inherit}
[hidden]{display:none!important}
.wrap{max-width:var(--max);margin:0 auto;padding:0 20px;width:100%}
h1,h2,h3{margin:0;font-weight:700;letter-spacing:-.03em;word-spacing:.06em;line-height:1.04}
h1{font-size:clamp(2.4rem,8vw,4.45rem);font-weight:800}
h2{font-size:clamp(1.75rem,4.4vw,2.6rem)}
h3{font-size:1.16rem;line-height:1.25;letter-spacing:-.02em}
p{margin:0}
.lead{font-size:1.02rem;color:var(--muted);line-height:1.6}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:.72rem;font-weight:600;
  letter-spacing:.14em;text-transform:uppercase;color:var(--green);margin-bottom:12px}
.eyebrow::before{content:"";width:20px;height:2px;border-radius:2px;background:var(--green);opacity:.5}
.skip{position:absolute;left:-9999px;top:0;padding:12px 18px;background:var(--ink);color:#fff;
  border-radius:0 0 12px 0;z-index:200}
.skip:focus{left:0}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;
  padding:15px 28px;border-radius:999px;border:0;cursor:pointer;line-height:1.2;
  font-weight:600;font-size:1rem;white-space:nowrap;text-decoration:none;
  transition:transform .35s var(--ease),box-shadow .35s var(--ease),background .25s}
.btn-dark{background:var(--ink);color:#fff;box-shadow:0 10px 24px -10px rgba(11,16,13,.7)}
.btn-dark:hover{transform:translateY(-2px);box-shadow:0 18px 34px -12px rgba(11,16,13,.8)}
.btn-green{background:var(--green);color:#fff;box-shadow:0 10px 24px -10px rgba(26,122,74,.8)}
.btn-green:hover{transform:translateY(-2px);background:var(--green-dark)}
.btn-light{background:#fff;color:var(--fg);box-shadow:var(--shadow-soft);border:1px solid var(--line)}
.btn-light:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift)}
.btn-ghost{background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.22)}
.btn-ghost:hover{background:rgba(255,255,255,.16)}
.btn-lime{background:var(--lime);color:#0B100D;box-shadow:0 12px 30px -12px rgba(201,242,78,.8)}
.btn-lime:hover{transform:translateY(-2px);box-shadow:0 20px 40px -14px rgba(201,242,78,.9)}
.btn-sm{padding:11px 20px;font-size:.94rem}
.btn svg{width:19px;height:19px;flex:0 0 19px}

.nav-shell{padding:14px 16px 18px}
.nav{max-width:940px;margin:0 auto;display:flex;align-items:center;gap:12px;
  padding:8px 8px 8px 16px;border-radius:999px;background:rgba(255,255,255,.72);
  backdrop-filter:blur(22px) saturate(180%);-webkit-backdrop-filter:blur(22px) saturate(180%);
  border:1px solid rgba(255,255,255,.45);
  box-shadow:0 2px 4px rgba(20,31,26,.05),0 16px 32px -18px rgba(20,31,26,.18)}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:1.06rem;letter-spacing:-.02em}
.brand .mark{width:28px;height:28px;flex:0 0 28px;border-radius:8px}
.nav-links{display:none;gap:4px;margin-left:auto}
.nav-links a{padding:9px 16px;border-radius:999px;color:#2A3831;font-size:.95rem;font-weight:500;
  transition:background .25s,color .25s}
.nav-links a:hover,.nav-links a.on{background:rgba(26,122,74,.09);color:var(--green)}
.nav-cta{margin-left:auto}

footer{margin-top:auto;padding:44px 0 30px}
footer .brand{font-size:1.14rem}
.foot-grid{display:grid;gap:28px;padding-bottom:28px;border-bottom:1px solid var(--line)}
.foot-grid h4{margin:0 0 14px;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);font-weight:600}
.foot-links{display:grid;gap:9px}
.foot-links a{font-size:.96rem;transition:color .25s}
.foot-links a:hover{color:var(--green)}
.foot-about{color:var(--muted);font-size:.94rem;margin-top:12px;max-width:26rem}
.foot-bottom{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;padding-top:22px;
  color:var(--muted);font-size:.88rem}

@media (min-width:900px){
  .nav-shell{padding:22px 20px 0}
  .nav{padding:10px 10px 10px 22px;gap:20px}
  .brand{gap:11px;font-size:1.12rem}
  .brand .mark{width:30px;height:30px;flex:0 0 30px}
  .nav-links{display:flex}
  .nav-cta{margin-left:4px}
  .lead{font-size:1.15rem}
  .eyebrow{font-size:.8rem;margin-bottom:18px}
  h3{font-size:1.3rem}
  footer{padding:72px 0 44px}
  .foot-grid{grid-template-columns:1.4fr 1fr 1fr;gap:40px;padding-bottom:40px}
  .foot-about{font-size:.98rem;margin-top:14px}
  .foot-links a{font-size:.98rem}
  .foot-bottom{padding-top:26px;font-size:.9rem}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}
}`;

// ═══════════════════════════════════════════════════════════════════════════
//  Stránka trénera — CSS
// ═══════════════════════════════════════════════════════════════════════════

const CSS_TRENER = `main{padding-bottom:96px}
.crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:var(--muted);font-size:.84rem;
  margin:6px 0 18px}
.crumbs a:hover{color:var(--green)}
.crumbs .sep{opacity:.45}
.crumbs .now{color:var(--fg);font-weight:600}

/* Hero. Na mobile je fotka s prekrytým titulkom (Mobil.dc.html), na desktope
   dvojstĺpec (Main.dc.html). Jedna značka pre oboje: pri 900 px sa obal fotky
   zmení na „display:contents“ a jeho deti sa stanú priamymi bunkami mriežky —
   nadpis tak prejde z vnútra fotky do vedľajšieho stĺpca bez toho, aby bol
   v dokumente dvakrát. */
.hero{display:grid;gap:0}
.hero-photo{position:relative}
.hero-shot{position:relative;border-radius:24px;overflow:hidden;height:min(360px,86vw);
  box-shadow:0 3px 6px rgba(20,31,26,.06),0 26px 48px -22px rgba(20,31,26,.34)}
.hero-shot .foto{width:100%;height:100%;object-fit:cover;object-position:center 22%}
.hero-shot .foto.placeholder{object-fit:contain;padding:22%;background:var(--green-soft)}
.hero-veil{position:absolute;inset:0;
  background:linear-gradient(180deg,rgba(6,10,7,0) 34%,rgba(6,10,7,.44) 62%,rgba(6,10,7,.88) 100%)}
.hero-cap{position:absolute;left:22px;right:22px;bottom:20px;color:#fff}
.hero-cap .eyebrow{color:var(--lime)}
.hero-cap .eyebrow::before{background:var(--lime)}
.hero-cap h1{color:#fff;text-shadow:0 2px 18px rgba(6,10,7,.5)}
.meta{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin-top:9px;
  color:rgba(255,255,255,.86);font-size:.92rem}
.meta .rate{display:inline-flex;align-items:center;gap:6px;color:#fff;font-weight:700}
.meta .rate svg{width:16px;height:16px;color:var(--lime)}
.meta .dot{width:3px;height:3px;border-radius:50%;background:rgba(255,255,255,.5)}
.club-line{display:flex;align-items:center;gap:7px;margin-top:16px;color:var(--muted);font-size:.94rem}
.club-line svg{width:16px;height:16px;flex:0 0 16px;color:var(--green)}
.verified{display:inline-flex;align-items:center;gap:8px;padding:8px 15px 8px 11px;border-radius:999px;
  background:var(--green-soft);border:1px solid rgba(26,122,74,.18);color:var(--green-dark);
  font-size:.86rem;font-weight:600;margin-top:16px}
.verified svg{width:16px;height:16px;flex:0 0 16px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);
  border-radius:20px;overflow:hidden;border:1px solid var(--line);margin-top:16px}
.stat{background:var(--card);padding:16px 12px}
.stat .num{font-size:1.42rem;font-weight:700;letter-spacing:-.03em;color:var(--green);line-height:1.2}
.stat .lbl{margin-top:2px;color:var(--muted);font-size:.76rem;line-height:1.35}
.actions{display:none;align-items:center;gap:12px;margin-top:26px}
.icon-btn{width:52px;height:52px;border-radius:50%;border:1px solid var(--line);background:#fff;
  display:grid;place-items:center;cursor:pointer;box-shadow:var(--shadow-soft);
  transition:transform .35s var(--ease),box-shadow .35s var(--ease),color .25s}
.icon-btn svg{width:20px;height:20px}
.icon-btn:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift);color:var(--green)}
.note{margin-top:14px;color:var(--muted);font-size:.88rem;line-height:1.55}

.sec{margin-top:38px}
.bio{font-size:1rem;line-height:1.72;margin-top:14px;white-space:pre-line}
.sub{font-size:.74rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);
  margin:26px 0 12px}
.pills{display:flex;flex-wrap:wrap;gap:8px}
.pill{padding:8px 15px;border-radius:999px;background:#fff;border:1px solid var(--line);
  font-size:.9rem;font-weight:500;box-shadow:0 1px 2px rgba(20,31,26,.04)}
.pill-soft{background:var(--green-soft);border-color:rgba(26,122,74,.16);color:var(--green-dark);font-weight:600}
.pill-sport{display:inline-flex;align-items:center;gap:6px}
.pill-sport svg{width:14px;height:14px;flex:0 0 14px}
.place{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
  overflow:hidden;box-shadow:var(--shadow-soft);display:flex;flex-direction:column}
.place-map{height:104px;flex:0 0 104px;position:relative;
  background:
    linear-gradient(90deg,rgba(26,122,74,.12) 1px,transparent 1px) 0 0/26px 26px,
    linear-gradient(180deg,rgba(26,122,74,.12) 1px,transparent 1px) 0 0/26px 26px,
    linear-gradient(140deg,#DDEBE0,#EFF4EC 55%,#E4EFE6)}
.place-map::after{content:"";position:absolute;left:0;right:0;top:62%;height:14px;
  background:rgba(201,242,78,.5);transform:rotate(-6deg)}
.place-map .pinwrap{position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);
  width:36px;height:36px;border-radius:50%;background:var(--green);color:#fff;display:grid;place-items:center;
  box-shadow:0 8px 18px -6px rgba(26,122,74,.7);z-index:1}
.place-map .pinwrap svg{width:18px;height:18px}
.place-body{padding:18px 20px}
.place-body .name{font-weight:700;font-size:1.04rem;letter-spacing:-.02em}
.place-body .addr{color:var(--muted);font-size:.92rem;margin-top:2px}
.place-body .tag{margin-top:10px;display:inline-flex;align-items:center;gap:7px;color:var(--green-dark);
  font-size:.86rem;font-weight:600}
.place-body .tag svg{width:14px;height:14px;flex:0 0 14px}

.price{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
  box-shadow:var(--shadow-lift);padding:22px 20px 20px;margin-top:16px}
.price h3{margin-bottom:2px}
.price .cap{color:var(--muted);font-size:.88rem;margin-bottom:14px}
.prow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0}
.prow+.prow{border-top:1px solid var(--line)}
.prow .lab{font-weight:600;font-size:.98rem;line-height:1.35}
.prow .sub2{color:var(--muted);font-size:.8rem;line-height:1.4}
.prow .val{font-weight:700;font-size:1.06rem;letter-spacing:-.02em;text-align:right;white-space:nowrap;line-height:1.3}
.prow .val small{display:block;font-weight:500;font-size:.76rem;color:var(--muted);letter-spacing:0;line-height:1.35}
.price hr{border:0;border-top:1px solid var(--line);margin:14px 0 4px}
.band{display:flex;align-items:center;gap:11px;padding:10px 0}
.band .ico{width:34px;height:34px;flex:0 0 34px;border-radius:10px;display:grid;place-items:center;
  background:var(--green-soft);color:var(--green-dark)}
.band .ico svg{width:18px;height:18px}
.band .t{font-weight:600;font-size:.95rem;line-height:1.3}
.band .h{color:var(--muted);font-size:.82rem;line-height:1.35}
.band .v{margin-left:auto;font-weight:700;font-size:.98rem;white-space:nowrap}
.price .btn{width:100%;margin-top:16px}
.price .foot{margin-top:10px;text-align:center;color:var(--muted);font-size:.82rem}

.rev-head .stars{display:flex;gap:3px;margin-bottom:10px;color:var(--gold)}
.rev-head .stars svg{width:19px;height:19px}
.rev-head .lead{margin-top:12px;font-size:.96rem}
.revs{display:grid;gap:14px;margin-top:20px}
.rev{background:var(--card);border:1px solid var(--line);border-radius:20px;
  box-shadow:var(--shadow-soft);padding:18px 20px;
  transition:transform .35s var(--ease),box-shadow .35s var(--ease)}
.rev:hover{transform:translateY(-3px);box-shadow:var(--shadow-lift)}
.rev .top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.rev .ava{width:42px;height:42px;flex:0 0 42px;border-radius:50%;object-fit:cover;background:var(--green-soft)}
.rev .ava.placeholder{object-fit:contain;padding:8px}
.rev .who{font-weight:700;letter-spacing:-.02em;font-size:.98rem;line-height:1.3}
.rev .when{color:var(--muted);font-size:.8rem;line-height:1.35}
.rev .stars{display:flex;gap:2px;margin-left:auto;color:var(--gold)}
.rev .stars svg{width:14px;height:14px}
.rev .stars .off{color:var(--line)}
.rev p{font-size:.96rem;line-height:1.6}
.rev-more{margin-top:18px;display:inline-flex;align-items:center;gap:9px;color:var(--green);
  font-weight:600;font-size:.98rem;background:none;border:0;padding:0;cursor:pointer;
  transition:gap .25s var(--ease)}
.rev-more:hover{gap:14px;color:var(--green-dark)}
.rev-more svg{width:16px;height:16px}

.cta{background:var(--ink);color:#fff;border-radius:var(--radius-xl);padding:30px 26px 28px;
  margin-top:38px;text-align:center;box-shadow:0 26px 50px -26px rgba(11,16,13,.6)}
.cta h2{color:#fff}
.cta .lead{color:rgba(255,255,255,.76);margin-top:12px;font-size:1rem}
.cta .row{display:grid;gap:10px;margin-top:22px}
.cta .row .btn{width:100%}
.qr{margin-top:24px}
.qr .box{width:152px;height:152px;margin:0 auto;background:#fff;border-radius:18px;padding:10px}
.qr .box svg{width:100%;height:100%}
.qr .cap{margin-top:10px;color:rgba(255,255,255,.66);font-size:.82rem}

/* Lepiaca lišta. Len na mobile — na desktope tú istú dvojicu nesie hero. */
.dock{position:fixed;left:0;right:0;bottom:0;z-index:70;
  background:rgba(255,255,255,.92);backdrop-filter:blur(18px) saturate(160%);
  -webkit-backdrop-filter:blur(18px) saturate(160%);
  border-top:1px solid var(--line);box-shadow:0 -6px 26px -10px rgba(20,31,26,.28);
  padding:12px 20px calc(12px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:10px}
.dock .btn-green{flex:1;padding:15px 18px}
.dock .msg{width:54px;height:54px;flex:0 0 54px;border-radius:50%;border:1px solid var(--line);
  background:#fff;display:grid;place-items:center;box-shadow:var(--shadow-soft);cursor:pointer;
  font-size:.62rem;font-weight:600;color:var(--muted);gap:1px;line-height:1}
.dock .msg svg{width:19px;height:19px;color:var(--fg)}
body{padding-bottom:92px}

@media (min-width:900px){
  body{padding-bottom:0}
  .dock{display:none}
  main{padding-bottom:0}
  .crumbs{font-size:.86rem;margin:34px 0 26px;gap:9px}
  .hero{grid-template-columns:440px 1fr;gap:0 56px;padding-bottom:84px;align-items:start}
  .hero-photo{display:contents}
  .hero-shot{grid-column:1;grid-row:1 / span 2;height:440px;border-radius:32px;
    box-shadow:0 3px 6px rgba(20,31,26,.06),0 34px 60px -26px rgba(20,31,26,.34)}
  .hero-shot .foto{object-position:center 18%}
  .hero-veil{display:none}
  .hero-cap{position:static;grid-column:2;grid-row:1;color:inherit;padding-top:6px}
  .hero-cap .eyebrow{color:var(--green)}
  .hero-cap .eyebrow::before{background:var(--green)}
  .hero-cap h1{color:var(--fg);text-shadow:none;margin-bottom:14px}
  .hero-body{grid-column:2;grid-row:2}
  .meta{color:var(--muted);font-size:1.02rem;gap:12px}
  .meta .rate{color:var(--fg);font-weight:600}
  .meta .rate svg{width:19px;height:19px;color:var(--gold)}
  .meta .dot{width:4px;height:4px;background:var(--line)}
  .club-line{margin-top:12px;font-size:1rem}
  .verified{padding:8px 16px 8px 12px;font-size:.9rem;margin-top:20px}
  .stats{border-radius:24px;margin-top:26px}
  .stat{padding:24px 22px}
  .stat .num{font-size:2.2rem;line-height:1.15}
  .stat .lbl{margin-top:4px;font-size:.95rem;line-height:1.45}
  .actions{display:flex}
  .note{margin-top:18px;font-size:.92rem}
  .split{display:grid;grid-template-columns:1fr 396px;gap:56px;align-items:start;padding-bottom:96px}
  .sec{margin-top:0}
  .bio{font-size:1.06rem;margin-top:18px;max-width:34rem}
  .sub{font-size:.8rem;margin:36px 0 14px}
  .pill{padding:9px 17px;font-size:.95rem}
  .place{flex-direction:row;max-width:34rem}
  .place-map{width:168px;flex:0 0 168px;height:auto}
  .place-body{padding:22px 24px}
  .price{padding:28px 28px 26px;margin-top:0}
  .price .cap{font-size:.92rem;margin-bottom:20px}
  .prow{padding:13px 12px;margin:0 -12px;border-radius:14px;transition:background .25s}
  .prow:hover{background:var(--green-soft)}
  .prow .lab{font-size:1rem}
  .prow .sub2{font-size:.86rem}
  .prow .val{font-size:1.12rem}
  .prow .val small{font-size:.8rem}
  .band{padding:12px;margin:0 -12px;border-radius:14px;gap:13px;transition:background .25s}
  .band:hover{background:var(--green-soft)}
  .band .ico{width:36px;height:36px;flex:0 0 36px;border-radius:11px}
  .price .btn{margin-top:20px}
  .price .foot{font-size:.86rem}
  .revs{grid-template-columns:repeat(3,1fr);gap:22px;margin-top:34px}
  .rev{border-radius:var(--radius-lg);padding:24px 24px 22px}
  .rev .ava{width:46px;height:46px;flex:0 0 46px}
  .rev .who{font-size:1.02rem}
  .rev .when{font-size:.85rem}
  .rev .stars svg{width:15px;height:15px}
  .rev p{font-size:1rem}
  .rev-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}
  .rev-head .stars svg{width:22px;height:22px}
  .rev-head .lead{max-width:22rem;text-align:right;margin-top:0}
  .cta{margin-top:96px;padding:52px 56px;display:grid;grid-template-columns:1fr auto;
    gap:56px;align-items:center;text-align:left;box-shadow:0 30px 60px -28px rgba(11,16,13,.6)}
  .cta h2{max-width:16ch}
  .cta .lead{margin-top:16px;max-width:38rem}
  .cta .row{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
  .cta .row .btn{width:auto}
  .qr{margin-top:0}
  .qr .box{width:184px;height:184px;border-radius:20px;padding:12px;
    box-shadow:0 20px 40px -18px rgba(0,0,0,.6)}
  .qr .cap{margin-top:12px;font-size:.86rem}
}

/* ── Modál (počítač) a panel obchodu (telefón) ─────────────── */
.ov{position:fixed;inset:0;background:rgba(20,31,26,.5);backdrop-filter:blur(3px);
  display:none;align-items:center;justify-content:center;z-index:100;padding:20px}
.ov.on{display:flex}
.modal{position:relative;width:100%;max-width:520px;background:var(--card);border-radius:var(--radius-lg);
  padding:36px 24px 30px;text-align:center;box-shadow:0 40px 80px -24px rgba(11,16,13,.5);
  max-height:calc(100vh - 40px);overflow:auto}
.modal h3{font-size:1.4rem;margin-bottom:12px}
.modal .lead{font-size:1rem;margin-bottom:22px}
.modal .row{display:grid;gap:10px;justify-content:stretch}
.modal .qrs{margin:24px auto 0;width:152px;height:152px;background:#fff;border:1px solid var(--line);
  border-radius:16px;padding:10px}
.modal .qrs svg{width:100%;height:100%}
.modal .qcap{margin-top:10px;color:var(--muted);font-size:.86rem;word-break:break-all}
.x{position:absolute;top:14px;right:14px;width:38px;height:38px;border-radius:50%;border:1px solid var(--line);
  background:#fff;display:grid;place-items:center;cursor:pointer;transition:background .25s,color .25s}
.x:hover{background:var(--paper);color:var(--green)}
.x svg{width:17px;height:17px}
@media (min-width:640px){
  .modal{padding:40px 44px 36px}
  .modal h3{font-size:1.6rem}
  .modal .row{display:flex;gap:12px;justify-content:center}
}
.toast{position:fixed;left:50%;bottom:104px;transform:translate(-50%,14px);z-index:120;
  background:var(--ink);color:#fff;padding:13px 22px;border-radius:999px;font-size:.92rem;font-weight:500;
  display:flex;align-items:center;gap:10px;box-shadow:0 20px 40px -16px rgba(11,16,13,.7);
  opacity:0;pointer-events:none;transition:opacity .3s var(--ease),transform .3s var(--ease);
  max-width:calc(100vw - 32px)}
.toast.on{opacity:1;transform:translate(-50%,0)}
.toast svg{width:18px;height:18px;flex:0 0 18px;color:var(--lime)}
@media (min-width:900px){.toast{bottom:48px}}`;

// ═══════════════════════════════════════════════════════════════════════════
//  Stránka trénera — HTML
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cenník pre HRÁČA — v cenách TRÉNERA, presne ako ich ukazuje appka v zozname
 * aj na profile. `pricing`/`hourly_rate` je od 340 priamo cena trénera, takže
 * sa neprepočítava nič: toľko mu hráč dá QR prevodom či v hotovosti. Poplatok
 * za platbu kartou sa dopočíta až pri rezervácii v appke a na cenníku stojí
 * len ako veta pod ním.
 *
 * Pásmo 4 je otvorené („štyria a viac"), takže sa jeho celok uvádza ako „od".
 */
function cennik(coach, sportyKodmi = sportyOf(coach)) {
  const cur = coach.currency === 'CZK' ? 'CZK' : 'EUR';
  const pricing = pricingZaSport(coach, sportyKodmi[0]);

  // Služba (fyzioterapia a pod.) predáva úkon, nie hodinu — cenník má vlastný
  // tvar, položky namiesto skupinových pásiem (pricing.ts:serviceItems).
  if (jeSluzba(sportyKodmi)) {
    const items = serviceItems(pricing);
    const riadky = items.map((it) => ({
      lab: it.name,
      sub: `${it.minutes} min`,
      val: suma(it.price, cur),
      small: '',
    }));
    const odCena = items.length ? Math.min(...items.map((it) => it.price)) : Number(coach.hourly_rate) || 0;
    return { cur, riadky, pasma: [], odCena, lacnejsiePasmo: false, vikendZaklad: false, sluzba: true };
  }

  const tiers = getTiers(pricing, coach.hourly_rate);
  const riadky = [];
  for (const t of tiers) {
    if (t.players === 1) {
      riadky.push({
        lab: 'Individuálny tréning',
        sub: 'len ty a tréner',
        val: suma(t.price, cur),
        small: '',
      });
    } else {
      const naOsobu = round2(t.price / t.players);
      const spolu = t.price;
      const otvorene = t.players === OPEN_TIER;
      riadky.push({
        lab: otvorene ? `Skupina ${OPEN_TIER}+` : `${t.players} hráči`,
        sub: 'cena za osobu',
        val: suma(naOsobu, cur),
        small: `${otvorene ? 'od ' : ''}${suma(spolu, cur)} spolu`,
      });
    }
  }

  // Pásma sa počítajú z INDIVIDUÁLNEJ sadzby trénera — presne ako
  // `CoachDetailScreen` v appke (`applyBandPct(soloRate, pct)`), bez poplatku,
  // ktorý sa do zobrazenej ceny nepočíta.
  const soloRate = groupRateFor(pricing, coach.hourly_rate, 1);
  const bands = timeBandsOf(pricing);
  const pasma = [];
  if (bands && soloRate > 0) {
    for (const b of bands.bands) {
      if (!b.pct) continue;   // nulové pásmo je základná cena, netreba ho písať
      pasma.push({
        key: b.key,
        nazov: PASMA[b.key] ?? PASMA.custom,
        cas: `${cas(b.start_min)}–${cas(b.end_min)}`,
        val: suma(applyBandPct(soloRate, b.pct), cur),
        zlava: b.pct < 0,
      });
    }
  }

  // „od X €" na karte aj v štatistike — najlacnejšia hodina pre jedného,
  // v sadzbe trénera. `data-cena` v zozname triedi podľa toho istého čísla,
  // aké je na karte vidieť.
  const min = minTierRate(pricing, coach.hourly_rate);
  const zaklad = groupRateFor(pricing, coach.hourly_rate, 1);
  const lacnejsiePasmo = min > 0 && min < zaklad;
  const odCena = lacnejsiePasmo ? min : zaklad;

  return { cur, riadky, pasma, odCena, lacnejsiePasmo, vikendZaklad: bands ? bands.weekend === 'base' : false, sluzba: false };
}

function kurtText(coach, cur, slovo = 'Kurt') {
  const mode = coach.court_fee_mode;
  if (mode === 'in_app') {
    const amt = Number(coach.court_fee_amount);
    if (amt > 0) return KURT.in_app(slovo, suma(amt, cur));
    return `${slovo} sa platí cez appku`;
  }
  if (mode === 'on_site') return KURT.on_site(slovo);
  return KURT.included(slovo);
}

function strankaTrenera(coach, ctx) {
  const cur = coach.currency === 'CZK' ? 'CZK' : 'EUR';
  const sportyKodmiSkoro = sportyOf(coach);
  const sluzba = jeSluzba(sportyKodmiSkoro);
  const c = cennik(coach, sportyKodmiSkoro);
  // Adresa, ktorú stránka NESIE: `/t/<slug>/` je to, čo GitHub Pages naozaj
  // servíruje, tak patrí do `canonical`, `og:url` aj do sitemapy.
  const url = `${WEB_ORIGIN}/t/${coach.slug}/`;
  // Adresa, ktorú stránka ROZDÁVA — do QR, do „Zdieľať" a pod QR kód. Je to
  // presne ten tvar, aký appka posiela z obrazovky Zdieľať profil
  // (`publicPageLink` v src/services/coachLink.ts), takže naskenovaný kód a
  // odkaz z appky sú ten istý reťazec. Bez lomky je aj QR o kúsok redšie.
  const zdielanyUrl = `${WEB_ORIGIN}/t/${coach.slug}`;
  const mestoSlug = slugify(coach.city_key || coach.city);
  const fotka = coach.fotoSubor ? `/t/${coach.slug}/${coach.fotoSubor}` : '/logo.webp';
  const maFotku = !!coach.fotoSubor;
  const hodnotenia = Array.isArray(coach.reviews) ? coach.reviews : [];
  const pocetHodnoteni = Number(coach.review_count) || 0;
  const rating = Number(coach.avg_rating) || 0;
  const zameranie = (coach.specializations || []).map((s) => ZAMERANIE[s]).filter(Boolean);
  const jazyky = (coach.coaching_languages || []).map((l) => JAZYKY[l]).filter(Boolean);
  const sportyKodmi = sportyKodmiSkoro;
  const sportNazvy = sportyKodmi.map((k) => SPORT_NAZOV[k]);
  // Kto to poskytuje — „tréner“ pri športe, „fyzioterapeut“/„masér“/… pri službe;
  // pri kombinácii sa berie prvý kód (rovnaké poradie ako inde).
  const poskytovatel = SPORT_POSKYTOVATEL[sportyKodmi[0]] || 'tréner';
  const miestoSlovo = miestoSlovoPre(sportyKodmi);
  const kurt = sluzba ? '' : kurtText(coach, cur, miestoSlovo);
  const sportOznacenie = spojSpojkou(sportNazvy.map((n) => n.toLowerCase()));
  // Eyebrow a popisy: pri športe „Tréning tenisu“, pri službe stací názov
  // služby samotný — „Fyzioterapia“, nie „Tréning fyzioterapie“.
  const cinnost = sluzba
    ? spojSpojkou(sportNazvy)
    : `Tréning ${spojSpojkou(sportyKodmi.map((k) => SPORT_GENITIV[k]))}`;

  const title = `${coach.name} – ${sportOznacenie}, ${coach.city} | Matchball`;
  const popisCasti = [
    `${coach.name} — ${cinnost.toLowerCase()} v meste ${coach.city}.`,
    coach.training_location ? `Kde: ${coach.training_location}.` : '',
    `Cena ${c.lacnejsiePasmo ? 'od ' : ''}${suma(c.odCena, cur).replace('\u00a0', ' ')}${sluzba ? '' : ' za hodinu'}.`,
    `${sluzba ? 'Objednanie' : 'Rezervácia'} a platba kartou v appke Matchball.`,
  ].filter(Boolean);
  const popis = popisCasti.join(' ').slice(0, 300);

  // JSON-LD. `AggregateRating` len keď sú hodnotenia — schéma ho bez `ratingCount`
  // odmieta a Google by stránku označil za chybnú.
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: coach.name,
    url,
    jobTitle: sluzba ? velkePismeno(poskytovatel) : `Tréner ${spojSpojkou(sportyKodmi.map((k) => SPORT_GENITIV[k]))}`,
    address: { '@type': 'PostalAddress', addressLocality: coach.city, addressCountry: cur === 'CZK' ? 'CZ' : 'SK' },
    ...(maFotku ? { image: `${WEB_ORIGIN}${fotka}` } : {}),
    ...(coach.bio ? { description: String(coach.bio).slice(0, 600) } : {}),
    ...(coach.training_location ? { workLocation: { '@type': 'Place', name: coach.training_location } } : {}),
    ...(jazyky.length ? { knowsLanguage: jazyky } : {}),
    ...(pocetHodnoteni > 0 && rating > 0 ? {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: rating.toFixed(1),
        reviewCount: pocetHodnoteni,
        bestRating: '5',
        worstRating: '1',
      },
    } : {}),
  };

  const qrVelky = qrSvg(zdielanyUrl, { size: 164, label: `QR kód na profil: ${coach.name}` });
  const qrMaly = qrSvg(zdielanyUrl, { size: 132, label: `QR kód na profil: ${coach.name}` });

  const staty = [];
  if (Number(coach.completed_lessons) > 0) {
    staty.push({ num: String(coach.completed_lessons), lbl: sluzba ? 'odbavených klientov' : 'odtrénovaných tréningov' });
  }
  if (Number(coach.years_experience) > 0) {
    const r = Number(coach.years_experience);
    staty.push({ num: `${r} ${pocet(r, 'rok', 'roky', 'rokov')}`, lbl: 'praxe s klientmi' });
  }
  staty.push({
    num: `${c.lacnejsiePasmo ? 'od ' : ''}${suma(c.odCena, cur)}`,
    lbl: sluzba ? 'za úkon' : 'za hodinu tréningu',
  });

  const metaCasti = [];
  if (pocetHodnoteni > 0 && rating > 0) {
    metaCasti.push(`<span class="rate">${IKONA.hviezda}${hodnotenie(rating)}</span>`);
    metaCasti.push(`<span>${pocetHodnoteni} ${pocet(pocetHodnoteni, 'hodnotenie', 'hodnotenia', 'hodnotení')}</span>`);
  }
  if (Number(coach.completed_lessons) > 0) {
    metaCasti.push(`<span>${coach.completed_lessons} ${pocet(Number(coach.completed_lessons), 'tréning', 'tréningy', 'tréningov')}</span>`);
  }
  const meta = metaCasti.join('<span class="dot"></span>');

  const pracovnyCas = (Number.isFinite(coach.work_start_min) && Number.isFinite(coach.work_end_min)
    && coach.work_end_min > coach.work_start_min)
    ? `${cas(coach.work_start_min)}–${cas(coach.work_end_min)}`
    : '';

  return `<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(popis)}">
<link rel="canonical" href="${url}">
${FAVICONY}
<meta property="og:type" content="profile">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(coach.name)} – ${sportOznacenie}, ${esc(coach.city)}">
<meta property="og:description" content="${esc(popis)}">
<meta property="og:image" content="${WEB_ORIGIN}${fotka}">
<meta property="og:image:alt" content="${esc(coach.name)}">
<meta property="og:locale" content="sk_SK">
<meta name="twitter:card" content="summary_large_image">
${PISMO}
<style>
${CSS_ZAKLAD}
${CSS_TRENER}
</style>
<script type="application/ld+json">${json(ld)}</script>
</head>
<body>
<a class="skip" href="#obsah">Preskočiť na obsah</a>
${hlavicka('treneri')}

<main id="obsah" class="wrap">
  <nav class="crumbs" aria-label="Drobčeková navigácia">
    <a href="/treneri/">Tréneri</a>
    <span class="sep" aria-hidden="true">›</span>
    <a href="/treneri/${mestoSlug}/">${esc(coach.city)}</a>
    <span class="sep" aria-hidden="true">›</span>
    <span class="now">${esc(coach.name)}</span>
  </nav>

  <div class="hero">
    <div class="hero-photo">
      <div class="hero-shot">
        <img class="foto${maFotku ? '' : ' placeholder'}" src="${fotka}" alt="${esc(coach.name)}${maFotku ? `, ${esc(velkePismeno(poskytovatel))} — ${esc(coach.city)}` : ''}" width="600" height="600">
        <div class="hero-veil"></div>
      </div>
      <div class="hero-cap">
        <p class="eyebrow">${esc(cinnost)} · ${esc(coach.city)}</p>
        <h1>${esc(coach.name)}</h1>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
      </div>
    </div>

    <div class="hero-body">
      ${coach.training_location ? `<div class="club-line">${IKONA.pin}${esc(coach.training_location)}, ${esc(coach.city)}</div>` : ''}
      <div class="pills" style="margin-top:14px">${sportyKodmi.map((k) => sportPillHtml(k, 'pill pill-soft pill-sport')).join('')}</div>
      ${coach.verified ? `<div class="verified">${IKONA.fajka}Overený ${esc(poskytovatel)}</div>` : ''}
      <div class="stats">
        ${staty.map((s) => `<div class="stat"><div class="num">${s.num}</div><div class="lbl">${s.lbl}</div></div>`).join('\n        ')}
      </div>
      <div class="actions">
        <button class="btn btn-green" type="button" data-otvor="rezervovat">${IKONA.kalendar}${sluzba ? 'Objednať sa' : 'Rezervovať tréning'}</button>
        <button class="btn btn-light" type="button" data-otvor="sprava">${IKONA.sprava}Napísať správu</button>
        <button class="icon-btn" type="button" id="zdielat" title="Zdieľať profil" aria-label="Zdieľať profil">${IKONA.zdielat}</button>
      </div>
      <p class="note">${sluzba ? 'Objednanie' : 'Rezervácia'} prebieha v appke Matchball. Platíš až po potvrdení ${sluzba ? `poskytovateľom` : 'trénerom'}.</p>
    </div>
  </div>

  <div class="split">
    <div>
      ${coach.bio ? `<div class="sec"><h2>O mne</h2><p class="bio">${esc(coach.bio)}</p></div>` : ''}
      ${zameranie.length ? `<p class="sub">Zameranie</p><div class="pills">${zameranie.map((z) => `<span class="pill pill-soft">${esc(z)}</span>`).join('')}</div>` : ''}
      ${jazyky.length ? `<p class="sub">Jazyky</p><div class="pills">${jazyky.map((j) => `<span class="pill">${esc(j)}</span>`).join('')}</div>` : ''}
      ${pracovnyCas ? `<p class="sub">${sluzba ? 'Kedy ordinujem' : 'Kedy trénujem'}</p><div class="pills"><span class="pill">${pracovnyCas}</span></div>` : ''}
      ${coach.training_location ? `<p class="sub" id="miesto">${sluzba ? 'Kde ma nájdeš' : 'Kde trénujem'}</p>
      <div class="place">
        <div class="place-map"><div class="pinwrap">${IKONA.pin}</div></div>
        <div class="place-body">
          <div class="name">${esc(coach.training_location)}</div>
          <div class="addr">${esc(coach.city)}</div>
          ${kurt ? `<div class="tag">${IKONA.fajka}${esc(kurt)}</div>` : ''}
        </div>
      </div>` : ''}
    </div>

    <div class="sec">
      <div class="price">
        <h3>Cenník</h3>
        <p class="cap">${sluzba ? 'za úkon' : 'za hodinu'}</p>
        ${c.riadky.map((r) => `<div class="prow">
          <div><div class="lab">${esc(r.lab)}</div><div class="sub2">${esc(r.sub)}</div></div>
          <div class="val">${r.val}${r.small ? `<small>${r.small}</small>` : ''}</div>
        </div>`).join('\n        ')}
        <p class="foot" style="text-align:left">Toto sú ceny ${sluzba ? 'poskytovateľa' : 'trénera'} — pri platbe kartou v appke sa k nim pripočíta poplatok za platbu kartou (${PLATFORM_PCT * 100} % + ${suma(fixedFor(cur), cur)}) so zárukou vrátenia a storno pravidlami.</p>
        ${c.pasma.length ? `<hr>
        ${c.pasma.map((p) => `<div class="band">
          <span class="ico">${p.zlava ? IKONA.slnko : IKONA.mesiac}</span>
          <span><span class="t">${esc(p.nazov)}</span><br><span class="h">${p.cas}</span></span>
          <span class="v">od ${p.val}</span>
        </div>`).join('\n        ')}
        ${c.vikendZaklad ? '<p class="foot" style="text-align:left;margin-top:8px">Cez víkend platí základná cena.</p>' : ''}` : ''}
        <button class="btn btn-green" type="button" data-otvor="rezervovat">${sluzba ? 'Objednať sa' : 'Rezervovať tréning'}</button>
        ${kurt ? `<p class="foot">${esc(kurt)}</p>` : ''}
      </div>
    </div>
  </div>

  ${hodnotenia.length ? `<section class="sec" aria-labelledby="hodnotenia-nadpis">
    <div class="rev-head">
      <div>
        <div class="stars" aria-hidden="true">${hviezdy(rating)}</div>
        <h2 id="hodnotenia-nadpis">${hodnotenie(rating)} z 5 · ${pocetHodnoteni} ${pocet(pocetHodnoteni, 'hodnotenie', 'hodnotenia', 'hodnotení')}</h2>
      </div>
      <p class="lead">${sluzba ? 'Hodnotiť môže len klient, ktorý si úkon naozaj vyskúšal.' : 'Hodnotiť môže len hráč, ktorý si tréning naozaj odtrénoval.'}</p>
    </div>
    <div class="revs">
      ${hodnotenia.map((r) => `<article class="rev">
        <div class="top">
          <img class="ava${r.fotoSubor ? '' : ' placeholder'}" src="${r.fotoSubor ? `/t/${coach.slug}/${r.fotoSubor}` : '/logo.webp'}" alt="" width="160" height="160" loading="lazy">
          <div><div class="who">${esc(menoRecenzenta(r.name))}</div><div class="when">${esc(mesiacRok(r.created_at))}</div></div>
          <div class="stars" aria-label="${Number(r.rating) || 0} z 5">${hviezdy(Number(r.rating) || 0)}</div>
        </div>
        ${r.comment ? `<p>„${esc(r.comment)}“</p>` : ''}
      </article>`).join('\n      ')}
      ${pocetHodnoteni > hodnotenia.length ? `<div class="rev" style="background:transparent;border-style:dashed;box-shadow:none">
        <h3 style="margin-bottom:8px">Zvyšných ${pocetHodnoteni - hodnotenia.length} ${pocet(pocetHodnoteni - hodnotenia.length, 'hodnotenie', 'hodnotenia', 'hodnotení')}</h3>
        <p style="color:var(--muted)">Celé vlákna aj s odpoveďami ${sluzba ? 'poskytovateľa' : 'trénera'} nájdeš v appke.</p>
        <button class="rev-more" type="button" data-otvor="hodnotenia">Zobraziť všetkých ${pocetHodnoteni} v appke${IKONA.sipka}</button>
      </div>` : ''}
    </div>
  </section>` : ''}

  <section class="cta">
    <div>
      <h2>${sluzba ? 'Objednaj sa' : 'Rezervuj si tréning'}</h2>
      <p class="lead">Stiahni si Matchball, vyber termín a zaplať kartou až po potvrdení.</p>
      <div class="row">
        <a class="btn btn-lime" href="${ctx.appStore}">${IKONA.apple}Stiahnuť pre iPhone</a>
        <a class="btn btn-ghost" href="${ctx.playStore}">${IKONA.play}Stiahnuť pre Android</a>
      </div>
    </div>
    <div class="qr">
      <div class="box">${qrVelky}</div>
      <p class="cap">Naskenuj telefónom</p>
    </div>
  </section>
</main>

${PATICKA}

<div class="dock">
  <button class="btn btn-green" type="button" data-otvor="rezervovat">${IKONA.kalendar}${sluzba ? 'Objednať sa' : 'Rezervovať tréning'}</button>
  <button class="msg" type="button" data-otvor="sprava" aria-label="Napísať správu">${IKONA.sprava}<span>Napísať</span></button>
</div>

<div class="ov" id="ov" role="dialog" aria-modal="true" aria-labelledby="ov-nadpis" aria-hidden="true">
  <div class="modal">
    <button class="x" type="button" id="ov-zavriet" aria-label="Zavrieť">${IKONA.zavriet}</button>
    <h3 id="ov-nadpis">Otvoriť v appke Matchball</h3>
    <p class="lead" id="ov-text">Naskenuj QR kód telefónom — otvorí sa profil v appke. Ak appku nemáš, dostaneš sa do obchodu.</p>
    <div class="row">
      <a class="btn btn-dark" href="${ctx.appStore}">${IKONA.apple}App Store</a>
      <a class="btn btn-light" href="${ctx.playStore}">${IKONA.play}Google Play</a>
    </div>
    <p class="lead" id="ov-mam" hidden style="margin:18px 0 0"><a class="rev-more" href="#" id="ov-mam-odkaz">Appku už mám — otvoriť${IKONA.sipka}</a></p>
    <div class="qrs" id="ov-qr">${qrMaly}</div>
    <p class="qcap" id="ov-qcap">matchballapp.com/t/${esc(coach.slug)}</p>
  </div>
</div>

<div class="toast" id="toast" role="status" aria-live="polite">${IKONA.fajka}<span id="toast-text"></span></div>

<script>
${skriptTrenera(coach, zdielanyUrl)}
</script>
</body>
</html>
`;
}

/**
 * Správanie tlačidiel. Prevzaté z `i/index.html` (`otvorAppku`, detekcia
 * zariadenia): schéma `mecbal://` otvorí appku len tomu, kto ju má, a keď ju
 * nemá, Safari odpovie chybovým oknom. Preto sa nikdy nepresmerúva naslepo —
 * na telefóne sa skúsi schéma a po 1,5 s bez odchodu zo stránky sa ukáže panel
 * s obchodom, na počítači sa rovno otvorí QR.
 *
 * Písané ako obyčajný reťazec s `+`, nie ako šablóna — v šablóne by sa `${`
 * v skripte stránky pomiešalo so `${` generátora.
 */
function skriptTrenera(coach, zdielanyUrl) {
  const id = String(coach.id);
  const slug = String(coach.slug);
  return `(function(){
  'use strict';
  var ID = ${json(id)};
  var SLUG = ${json(slug)};
  var URL_STRANKY = ${json(zdielanyUrl)};
  var APP_STORE = ${json(APP_STORE)};
  var PLAY = ${json(PLAY_STORE)} + '&referrer=' + encodeURIComponent('coach=' + ID);

  var ua = navigator.userAgent || '';
  var jeAndroid = /Android/i.test(ua);
  // iPadOS 13+ sa hlási ako Macintosh; rozlíši ho len dotyková obrazovka.
  var jeIOS = /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/i.test(ua) && typeof document.ontouchend !== 'undefined');
  var jeTelefon = jeAndroid || jeIOS;

  var ov = document.getElementById('ov');
  var ovText = document.getElementById('ov-text');
  var ovQr = document.getElementById('ov-qr');
  var ovQcap = document.getElementById('ov-qcap');
  var ovMam = document.getElementById('ov-mam');
  var ovMamOdkaz = document.getElementById('ov-mam-odkaz');
  var toast = document.getElementById('toast');
  var toastText = document.getElementById('toast-text');
  var casovacToastu = null;
  var poslednyCiel = null;

  function schema(co){
    var q = 'mecbal://coach?id=' + encodeURIComponent(ID) + '&slug=' + encodeURIComponent(SLUG);
    if (co === 'sprava') q += '&sprava';
    else if (co === 'hodnotenia') q += '&hodnotenia';
    else q += '&rezervovat';
    return q;
  }

  function ukazModal(sQr){
    ovQr.hidden = !sQr;
    ovQcap.hidden = !sQr;
    ovMam.hidden = sQr;
    ov.classList.add('on');
    ov.setAttribute('aria-hidden', 'false');
    document.getElementById('ov-zavriet').focus();
  }
  function zavriModal(){
    ov.classList.remove('on');
    ov.setAttribute('aria-hidden', 'true');
  }

  document.getElementById('ov-zavriet').addEventListener('click', zavriModal);
  ov.addEventListener('click', function(e){ if (e.target === ov) zavriModal(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') zavriModal(); });

  ovMamOdkaz.addEventListener('click', function(e){
    e.preventDefault();
    if (poslednyCiel) window.location.href = poslednyCiel;
  });

  // Odkazy do obchodu podľa zariadenia. Na počítači ostávajú oba.
  if (jeTelefon) {
    var obchod = jeIOS ? APP_STORE : PLAY;
    [].forEach.call(ov.querySelectorAll('.row .btn'), function(a, i){
      a.hidden = jeIOS ? i !== 0 : i !== 1;
      if (!a.hidden) a.href = obchod;
    });
  }

  function otvorAppku(co){
    var ciel = schema(co);
    poslednyCiel = ciel;
    if (!jeTelefon) {
      ovText.textContent = 'Naskenuj QR kód telefónom — otvorí sa profil v appke. Ak appku nemáš, dostaneš sa do obchodu.';
      ukazModal(true);
      return;
    }
    var odisiel = false;
    function odchod(){ if (document.visibilityState === 'hidden') odisiel = true; }
    document.addEventListener('visibilitychange', odchod);
    window.setTimeout(function(){
      document.removeEventListener('visibilitychange', odchod);
      if (odisiel || document.visibilityState === 'hidden') return;
      ovText.textContent = 'Vyzerá to, že appku ešte nemáš. Stiahni si ju — profil sa v nej otvorí hneď po inštalácii.';
      ukazModal(false);
    }, 1500);
    window.location.href = ciel;
  }

  [].forEach.call(document.querySelectorAll('[data-otvor]'), function(b){
    b.addEventListener('click', function(){ otvorAppku(b.getAttribute('data-otvor')); });
  });

  function ukazToast(text){
    toastText.textContent = text;
    toast.classList.add('on');
    if (casovacToastu) window.clearTimeout(casovacToastu);
    casovacToastu = window.setTimeout(function(){ toast.classList.remove('on'); }, 2400);
  }

  var zdielat = document.getElementById('zdielat');
  if (zdielat) {
    zdielat.addEventListener('click', function(){
      if (navigator.share) {
        navigator.share({ title: document.title, url: URL_STRANKY }).catch(function(){});
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(URL_STRANKY).then(function(){
          ukazToast('Odkaz skopírovaný');
        }, function(){ ukazToast(URL_STRANKY); });
        return;
      }
      ukazToast(URL_STRANKY);
    });
  }
})();`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Adresár trénerov — CSS a HTML
// ═══════════════════════════════════════════════════════════════════════════

const CSS_ZOZNAM = `.sec-head{padding:26px 0 26px;max-width:44rem}
.sec-head .lead{margin-top:14px}
.filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:12px;background:var(--card);border:1px solid var(--line);
  border-radius:26px;box-shadow:var(--shadow-soft);margin-bottom:28px}
.fpill{display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;
  background:#fff;border:1px solid var(--line);font-size:.92rem;font-weight:500;color:var(--fg);
  white-space:nowrap;cursor:pointer;transition:background .25s,border-color .25s,color .25s}
.fpill:hover{border-color:rgba(26,122,74,.35)}
.fpill svg{width:15px;height:15px;flex:0 0 15px}
.fpill[aria-pressed="true"]{background:var(--green-soft);border-color:transparent;color:var(--green-dark);font-weight:600}
.switch{width:30px;height:17px;border-radius:999px;background:var(--line);position:relative;flex:0 0 30px;
  transition:background .25s}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;
  background:#fff;transition:transform .25s var(--ease);box-shadow:0 1px 2px rgba(0,0,0,.2)}
.fpill[aria-pressed="true"] .switch{background:var(--green)}
.fpill[aria-pressed="true"] .switch::after{transform:translateX(13px)}
.fpill.static{cursor:default}
.fpill.static:hover{border-color:var(--line)}
.filters .spacer{flex:1 1 auto;display:none}
.sort-wrap{display:inline-flex;align-items:center;gap:8px;padding:6px 8px 6px 16px;border-radius:999px;
  background:#fff;border:1px solid var(--line);font-size:.92rem;font-weight:500}
.sort-wrap select{font:inherit;border:0;background:transparent;padding:5px 6px;border-radius:999px;
  cursor:pointer;color:var(--green-dark);font-weight:600}
.pocet-vysledkov{color:var(--muted);font-size:.94rem;margin-bottom:18px}

.grid-coaches{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:20px;margin-bottom:36px}
.coach-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
  box-shadow:var(--shadow-soft);overflow:hidden;display:flex;flex-direction:column;
  transition:transform .35s var(--ease),box-shadow .35s var(--ease)}
.coach-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lift)}
.coach-photo{position:relative;aspect-ratio:4/3;overflow:hidden;
  background:linear-gradient(150deg,var(--green-soft),#DCEFE3);
  display:flex;align-items:center;justify-content:center}
.coach-photo .portret{width:100%;height:100%;object-fit:cover}
.coach-photo .znak{position:relative;width:96px;height:96px;border-radius:50%;object-fit:contain;
  padding:18px;background:#fff;border:4px solid rgba(255,255,255,.9);
  box-shadow:0 10px 26px -8px rgba(11,16,13,.35)}
.badge-verified{position:absolute;top:14px;left:14px;display:inline-flex;align-items:center;gap:6px;
  padding:6px 12px 6px 9px;border-radius:999px;background:var(--green);color:#fff;
  font-size:.78rem;font-weight:600;box-shadow:0 6px 16px -6px rgba(26,122,74,.6)}
.badge-verified svg{width:13px;height:13px;flex:0 0 13px}
.coach-body{padding:20px 22px 22px;display:flex;flex-direction:column;flex:1}
.coach-meta{margin-top:6px;color:var(--muted);font-size:.92rem}
.coach-meta b{color:var(--fg);font-weight:600}
.coach-tags{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px}
.tag{display:inline-flex;align-items:center;padding:6px 12px;border-radius:999px;
  background:var(--green-soft);color:var(--green-dark);font-size:.8rem;font-weight:500}
.tag-sport{gap:5px}
.tag-sport svg{width:12px;height:12px;flex:0 0 12px}
.coach-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;
  margin-top:auto;padding-top:16px;border-top:1px solid var(--line)}
.coach-foot{margin-top:18px}
.coach-price b{font-size:1.24rem;font-weight:700;color:var(--green);letter-spacing:-.02em;white-space:nowrap}
.coach-price span{display:block;color:var(--muted);font-size:.82rem;margin-top:1px}
.prazdno{padding:34px 0 60px;color:var(--muted)}

.cities-block{margin-bottom:64px}
.cities-block h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);
  font-weight:600;margin-bottom:16px;line-height:1.4}
.cities-pills{display:flex;flex-wrap:wrap;gap:10px}
.city-pill{display:inline-flex;align-items:center;gap:7px;padding:11px 18px;border-radius:999px;
  background:var(--card);border:1px solid var(--line);font-size:.95rem;font-weight:500;
  transition:border-color .25s,color .25s}
.city-pill:hover{border-color:rgba(26,122,74,.35);color:var(--green-dark)}
.city-pill span{color:var(--muted);font-weight:400}

/* Krížový odkaz medzi trénermi a skupinami. Nie je to reklama na inú stránku,
   ale druhá polovica tej istej otázky: kto hľadá partiu, potrebuje aj trénera
   a naopak. Preto stojí na konci zoznamu, nie nad ním. */
.krizom{display:flex;align-items:center;gap:14px;margin-bottom:44px;padding:20px 22px;
  background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
  box-shadow:var(--shadow-soft);transition:transform .35s var(--ease),box-shadow .35s var(--ease)}
.krizom:hover{transform:translateY(-2px);box-shadow:var(--shadow-lift)}
.krizom .txt{flex:1 1 auto}
.krizom .txt b{display:block;font-weight:600;font-size:1.05rem;letter-spacing:-.02em}
.krizom .txt span{color:var(--muted);font-size:.94rem}
.krizom .sip{flex:0 0 40px;width:40px;height:40px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;background:var(--green-soft);color:var(--green-dark)}
.krizom .sip svg{width:18px;height:18px}

.cta-dark{background:var(--ink);color:#fff;border-radius:var(--radius-xl);
  padding:34px 26px;display:flex;flex-direction:column;gap:22px;
  margin-bottom:64px;position:relative;overflow:hidden}
.cta-dark::after{content:"";position:absolute;width:460px;height:460px;right:-190px;top:-200px;
  border-radius:50%;background:radial-gradient(circle,rgba(201,242,78,.2),transparent 65%);pointer-events:none}
.cta-dark-text{max-width:34rem;position:relative}
.cta-dark-text h2{color:#fff;font-size:1.7rem}
.cta-dark-text .lead{color:rgba(255,255,255,.72);margin-top:12px}
.cta-dark-actions{display:grid;gap:10px;flex:0 0 auto;position:relative}

@media (min-width:900px){
  .sec-head{padding:44px 0 40px}
  .sec-head .lead{margin-top:18px}
  .filters{padding:14px;border-radius:999px;margin-bottom:36px}
  .filters .spacer{display:block}
  .fpill{padding:11px 18px;font-size:.94rem}
  .grid-coaches{grid-template-columns:repeat(3,1fr);gap:24px}
  .cta-dark{flex-direction:row;align-items:center;justify-content:space-between;gap:40px;
    padding:64px 72px;margin-bottom:80px}
  .cta-dark-text h2{font-size:2.2rem}
  .cta-dark-actions{display:flex;gap:12px}
  .cities-block{margin-bottom:96px}
}`;

/** Odkaz z jedného zoznamu do druhého — jedna karta, jedna veta, šípka. */
function krizovyOdkaz(href, nadpis, popis) {
  return `<a class="krizom" href="${href}">
    <span class="txt"><b>${esc(nadpis)}</b><span>${esc(popis)}</span></span>
    <span class="sip" aria-hidden="true">${IKONA.sipka}</span>
  </a>`;
}

function kartaTrenera(coach) {
  const cur = coach.currency === 'CZK' ? 'CZK' : 'EUR';
  const sportyKodmi = sportyOf(coach);
  const c = cennik(coach, sportyKodmi);
  const rating = Number(coach.avg_rating) || 0;
  const pocetH = Number(coach.review_count) || 0;
  const url = `/t/${coach.slug}/`;
  const maFotku = !!coach.fotoSubor;
  const tagy = (coach.specializations || []).map((s) => ZAMERANIE[s]).filter(Boolean).slice(0, 3);
  const ukazSporty = sportyKodmi.length > 1 || sportyKodmi[0] !== 'tennis';

  const metaCasti = [];
  if (pocetH > 0 && rating > 0) metaCasti.push(`★ <b>${hodnotenie(rating)}</b> (${pocetH})`);
  metaCasti.push(esc(coach.city));
  if (coach.training_location) metaCasti.push(esc(coach.training_location));

  // Triedenie a filter beží v prehliadači nad týmito atribútmi — bez servera
  // a bez toho, aby sa čokoľvek dopytovalo pri načítaní stránky.
  const data = [
    `data-overeny="${coach.verified ? '1' : '0'}"`,
    `data-hodnotenie="${rating.toFixed(2)}"`,
    `data-pocet="${pocetH}"`,
    `data-cena="${c.odCena.toFixed(2)}"`,
    `data-meno="${esc(coach.name)}"`,
  ].join(' ');

  return `<article class="coach-card" ${data}>
        <div class="coach-photo">
          ${maFotku
    ? `<img class="portret" src="${url}${coach.fotoSubor}" alt="${esc(coach.name)}" width="600" height="600" loading="lazy">`
    : '<img class="znak" src="/logo.webp" alt="" width="128" height="128" loading="lazy">'}
          ${coach.verified ? `<span class="badge-verified">${IKONA.fajka}Overený ${SPORT_POSKYTOVATEL[sportyKodmi[0]] || 'tréner'}</span>` : ''}
        </div>
        <div class="coach-body">
          <h3><a href="${url}">${esc(coach.name)}</a></h3>
          <p class="coach-meta">${metaCasti.join(' · ')}</p>
          ${ukazSporty ? `<div class="coach-tags">${sportyKodmi.map((k) => sportPillHtml(k, 'tag tag-sport')).join('')}</div>` : ''}
          ${tagy.length ? `<div class="coach-tags">${tagy.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="coach-foot">
            <div class="coach-price"><b>${c.lacnejsiePasmo ? 'od ' : ''}${suma(c.odCena, cur)}</b><span>${c.sluzba ? 'za úkon' : 'za hodinu'}</span></div>
            <a class="btn btn-green btn-sm" href="${url}">Zobraziť profil</a>
          </div>
        </div>
      </article>`;
}

/**
 * Adresár — buď celý (`mesto === null`), alebo jedno mesto.
 *
 * `ostatneMesta` sú všetky mestá aj s počtami; na stránke mesta sa z nich to
 * aktuálne vynechá, aby odkaz neviedol sám na seba.
 */
function strankaZoznamu({ mesto, sport, coaches, ostatneMesta, sportyVScope, skupinyMesta }) {
  const jeMesto = !!mesto;
  const n = coaches.length;
  const sportSlug = sport ? SPORT_SLUG[sport] : null;
  const sportNazov = sport ? SPORT_NAZOV[sport] : null;
  const sportGenitiv = sport ? SPORT_GENITIV[sport] : null;
  // Predpona `/treneri/<sport>/…` sa drží aj pri odkazoch na iné mestá a pri
  // odchode z mesta — filter na šport sa tak neresetuje.
  const predpona = sportSlug ? `/treneri/${sportSlug}` : '/treneri';
  const url = jeMesto ? `${WEB_ORIGIN}${predpona}/${mesto.slug}/` : `${WEB_ORIGIN}${predpona}/`;
  const nadpis = sport
    ? (jeMesto ? `Tréneri ${sportGenitiv} — ${mesto.name}` : `Tréneri ${sportGenitiv}`)
    : (jeMesto ? `Tréneri — ${mesto.name}` : 'Tréneri');
  const title = sport
    ? (jeMesto ? `Tréneri ${sportGenitiv} ${mesto.name} | Matchball` : `Tréneri ${sportGenitiv} na Slovensku a v Česku | Matchball`)
    : (jeMesto ? `Tréneri ${mesto.name} | Matchball` : 'Tréneri na Slovensku a v Česku | Matchball');
  const popis = sport
    ? (jeMesto
      ? `${n} ${pocet(n, `tréner ${sportGenitiv}`, `tréneri ${sportGenitiv}`, `trénerov ${sportGenitiv}`)} v meste ${mesto.name}. Vyber si podľa hodnotenia a ceny, rezervuj termín v appke Matchball a plať kartou až po potvrdení.`
      : `Tréneri ${sportGenitiv}, ktorých si vieš rezervovať cez appku Matchball. Vyber si podľa mesta, hodnotenia a ceny — platíš kartou až po potvrdení termínu.`)
    : (jeMesto
      ? `${n} ${pocet(n, 'tréner', 'tréneri', 'trénerov')} v meste ${mesto.name}. Vyber si podľa hodnotenia a ceny, rezervuj termín v appke Matchball a plať kartou až po potvrdení.`
      : 'Tréneri, ktorých si vieš rezervovať cez appku Matchball. Vyber si podľa mesta, hodnotenia a ceny — platíš kartou až po potvrdení termínu.');

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: nadpis,
    url,
    numberOfItems: n,
    itemListElement: coaches.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${WEB_ORIGIN}/t/${c.slug}/`,
      name: c.name,
    })),
  };

  const mestaPills = ostatneMesta
    .filter((m) => !jeMesto || m.slug !== mesto.slug)
    .map((m) => `<a class="city-pill" href="${predpona}/${m.slug}/">${esc(m.name)} <span>${m.count}</span></a>`)
    .join('\n        ');

  // Chipy športov vo filtri — len tie, čo majú v tomto rozsahu (meste alebo
  // celkovo) aspoň jedného trénera. Keď je v rozsahu len jeden šport, nemá
  // zmysel z neho robiť filter — zostane statický štítok ako predtým.
  const sportChipy = sportyVScope.length <= 1
    ? `<span class="fpill static">${esc(SPORT_NAZOV[sportyVScope[0] || 'tennis'])}</span>`
    : [
      `<a class="fpill" href="${jeMesto ? `/treneri/${mesto.slug}/` : '/treneri/'}" aria-pressed="${sport ? 'false' : 'true'}">Všetky športy</a>`,
      ...sportyVScope.map((k) => {
        const href = jeMesto ? `/treneri/${SPORT_SLUG[k]}/${mesto.slug}/` : `/treneri/${SPORT_SLUG[k]}/`;
        return `<a class="fpill" href="${href}" aria-pressed="${sport === k ? 'true' : 'false'}">${ikonaPreSport(k)}${esc(SPORT_NAZOV[k])}</a>`;
      }),
    ].join('\n    ');

  const crumbCasti = ['<a href="/treneri/">Tréneri</a>'];
  if (sport) {
    crumbCasti.push('<span aria-hidden="true" style="opacity:.45">›</span>');
    crumbCasti.push(jeMesto
      ? `<a href="/treneri/${sportSlug}/">${esc(sportNazov)}</a>`
      : `<span style="color:var(--fg);font-weight:600">${esc(sportNazov)}</span>`);
  }
  if (jeMesto) {
    crumbCasti.push('<span aria-hidden="true" style="opacity:.45">›</span>');
    crumbCasti.push(`<span style="color:var(--fg);font-weight:600">${esc(mesto.name)}</span>`);
  }

  return `<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(popis)}">
<link rel="canonical" href="${url}">
${FAVICONY}
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(nadpis)} | Matchball">
<meta property="og:description" content="${esc(popis)}">
<meta property="og:image" content="${WEB_ORIGIN}/hero.webp">
<meta property="og:locale" content="sk_SK">
<meta name="twitter:card" content="summary_large_image">
${PISMO}
<style>
${CSS_ZAKLAD}
${CSS_ZOZNAM}
</style>
<script type="application/ld+json">${json(ld)}</script>
</head>
<body>
<a class="skip" href="#obsah">Preskočiť na obsah</a>
${hlavicka('treneri')}

<main id="obsah" class="wrap">
  ${jeMesto || sport ? `<nav class="crumbs" aria-label="Drobčeková navigácia" style="display:flex;gap:8px;color:var(--muted);font-size:.86rem;margin-top:8px">
    ${crumbCasti.join('\n    ')}
  </nav>` : ''}
  <header class="sec-head">
    <p class="eyebrow">Tréneri</p>
    <h1>${esc(nadpis)}</h1>
    <p class="lead">${esc(popis)}</p>
  </header>

  ${n > 0 ? `<div class="filters">
    ${jeMesto
    ? `<a class="fpill" href="${predpona}/">${IKONA.pin}${esc(mesto.name)}</a>`
    : `<span class="fpill static">${IKONA.pin}Všetky mestá</span>`}
    ${sportChipy}
    <button class="fpill" type="button" id="len-overeni" aria-pressed="false"><span class="switch" aria-hidden="true"></span>Len overení</button>
    <span class="spacer"></span>
    <label class="sort-wrap">Zoradiť
      <select id="zoradenie">
        <option value="odporucane">Odporúčané</option>
        <option value="hodnotenie">Podľa hodnotenia</option>
        <option value="cena">Od najlacnejších</option>
        <option value="meno">Podľa mena</option>
      </select>
    </label>
  </div>

  <p class="pocet-vysledkov" id="pocet-vysledkov">${n} ${pocet(n, 'tréner', 'tréneri', 'trénerov')}</p>

  <div class="grid-coaches" id="mriezka">
      ${coaches.map(kartaTrenera).join('\n      ')}
  </div>
  <p class="prazdno" id="ziadne" hidden>V tomto výbere nikto nie je. Skús vypnúť „Len overení“.</p>`
    : '<p class="prazdno">Tu zatiaľ trénera nemáme. Skús iné mesto — pribúdajú.</p>'}

  ${mestaPills ? `<section class="cities-block">
    <h2>Ďalšie mestá</h2>
    <div class="cities-pills">
        ${mestaPills}
    </div>
  </section>` : ''}

  ${krizovyOdkaz(
    jeMesto && skupinyMesta?.has(mesto.slug) ? `/skupiny/${mesto.slug}/` : '/skupiny/',
    jeMesto ? `Hľadáš partiu? Skupiny v meste ${mesto.name}` : 'Hľadáš partiu, nie trénera?',
    'Sparingové skupiny hrávajú pravidelne a berú nových hráčov.',
  )}

  <section class="cta-dark">
    <div class="cta-dark-text">
      <h2>Trénuješ? Buď medzi nimi.</h2>
      <p class="lead">Založ si profil v appke Matchball, nastav si cenník a termíny. Verejná stránka ti vznikne sama.</p>
    </div>
    <div class="cta-dark-actions">
      <a class="btn btn-lime" href="${APP_STORE}">${IKONA.apple}Stiahnuť pre iPhone</a>
      <a class="btn btn-ghost" href="${PLAY_STORE}">${IKONA.play}Stiahnuť pre Android</a>
    </div>
  </section>
</main>

${PATICKA}
${n > 0 ? `<script>\n${SKRIPT_ZOZNAMU}\n</script>` : ''}
</body>
</html>
`;
}

/**
 * Filter a zoradenie bez servera. Karty sú už v HTML (kvôli indexovaniu),
 * skript len mení ich poradie a viditeľnosť podľa `data-` atribútov.
 *
 * „Odporúčané“ je pôvodné poradie z generátora (overení, hodnotenie, počet,
 * meno) — drží sa v `data-poradie`, aby sa dalo vrátiť po inom zoradení.
 */
const SKRIPT_ZOZNAMU = `(function(){
  'use strict';
  var mriezka = document.getElementById('mriezka');
  if (!mriezka) return;
  var karty = [].slice.call(mriezka.children);
  var prepinac = document.getElementById('len-overeni');
  var vyber = document.getElementById('zoradenie');
  var pocetEl = document.getElementById('pocet-vysledkov');
  var ziadneEl = document.getElementById('ziadne');

  karty.forEach(function(k, i){ k.dataset.poradie = String(i); });

  function num(k, kluc){ return parseFloat(k.dataset[kluc]) || 0; }

  var poradia = {
    odporucane: function(a, b){ return num(a,'poradie') - num(b,'poradie'); },
    hodnotenie: function(a, b){
      return (num(b,'hodnotenie') - num(a,'hodnotenie'))
        || (num(b,'pocet') - num(a,'pocet'))
        || a.dataset.meno.localeCompare(b.dataset.meno, 'sk');
    },
    cena: function(a, b){
      return (num(a,'cena') - num(b,'cena'))
        || a.dataset.meno.localeCompare(b.dataset.meno, 'sk');
    },
    meno: function(a, b){ return a.dataset.meno.localeCompare(b.dataset.meno, 'sk'); }
  };

  function sklonuj(n){
    if (n === 1) return '1 tréner';
    if (n >= 2 && n <= 4) return n + ' tréneri';
    return n + ' trénerov';
  }

  function prekresli(){
    var lenOvereni = prepinac.getAttribute('aria-pressed') === 'true';
    var vidno = 0;
    karty.forEach(function(k){
      var ok = !lenOvereni || k.dataset.overeny === '1';
      k.hidden = !ok;
      if (ok) vidno++;
    });
    var zoradene = karty.slice().sort(poradia[vyber.value] || poradia.odporucane);
    zoradene.forEach(function(k){ mriezka.appendChild(k); });
    pocetEl.textContent = sklonuj(vidno);
    ziadneEl.hidden = vidno > 0;
  }

  prepinac.addEventListener('click', function(){
    prepinac.setAttribute('aria-pressed', prepinac.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    prekresli();
  });
  vyber.addEventListener('change', prekresli);
})();`;

// ═══════════════════════════════════════════════════════════════════════════
//  Skupiny — CSS a HTML
//
//  Zoznam sparingových skupín podľa miest. Skupina NEMÁ vlastnú stránku:
//  RPC (349) o nej vydáva len upútavku a bez fotky, pravidiel a členov by
//  samostatná stránka nemala čím byť. Kto sa chce pridať, potrebuje appku —
//  a tam ho pošle spoločná výzva dole na stránke.
// ═══════════════════════════════════════════════════════════════════════════

const CSS_SKUPINY = `.city-groups{margin-bottom:44px}
.city-groups h2{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;font-size:1.45rem;
  margin-bottom:18px}
.city-groups h2 span{font-size:.92rem;font-weight:500;color:var(--muted);letter-spacing:0}
.grid-groups{display:grid;grid-template-columns:repeat(auto-fill,minmax(272px,1fr));gap:20px}
.grid-groups.solo{margin-bottom:44px}
.group-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
  box-shadow:var(--shadow-soft);padding:20px 22px 22px;display:flex;flex-direction:column;
  transition:transform .35s var(--ease),box-shadow .35s var(--ease)}
.group-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lift)}
.group-head{display:flex;align-items:center;gap:14px}
.group-head h3{overflow-wrap:anywhere}
.group-avatar{width:58px;height:58px;flex:0 0 58px;border-radius:50%;object-fit:cover;
  background:var(--green-soft);border:2px solid #fff;box-shadow:0 8px 20px -10px rgba(11,16,13,.4)}
.group-avatar.znak{object-fit:contain;padding:12px}
.group-when{margin-top:5px;color:var(--muted);font-size:.9rem}
.group-tags{display:flex;gap:7px;flex-wrap:wrap;margin-top:15px}
.group-desc{margin-top:13px;color:var(--muted);font-size:.94rem;line-height:1.5}
.group-org{display:flex;align-items:center;gap:8px;margin-top:15px;color:var(--muted);font-size:.88rem}
.group-org img{width:24px;height:24px;flex:0 0 24px;border-radius:50%;object-fit:cover}
.group-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;
  margin-top:auto;padding-top:16px;border-top:1px solid var(--line)}
.group-foot{margin-top:18px}
.group-spots b{font-size:1.2rem;font-weight:700;color:var(--green);letter-spacing:-.02em;
  white-space:nowrap}
.group-spots span{display:block;color:var(--muted);font-size:.82rem;margin-top:1px}
.cta-dark-note{color:rgba(255,255,255,.72);font-size:.92rem;margin-top:14px;position:relative}

@media (min-width:900px){
  .city-groups{margin-bottom:64px}
  .city-groups h2{font-size:1.7rem;margin-bottom:22px}
  .grid-groups{grid-template-columns:repeat(3,1fr);gap:24px}
  .grid-groups.solo{margin-bottom:64px}
}`;

function kartaSkupiny(g) {
  const maskot = avatarSubor(g.avatar_id) || avatarSubor(g.organizer_avatar);
  const organizator = avatarSubor(g.organizer_avatar);
  const kedy = kedyText(g.recurrence);
  const miesto = [g.venue, kedy].filter(Boolean).map((s) => esc(s)).join(' · ');
  // Počet ČLENOV, nie „1 z 8 miest": do skupiny sa pridá, kto chce, kapacita
  // platí až na jednotlivý termín (Martin, 9. 9.). Kapacita termínu je
  // v podtitulku, aby bolo jasné, koľkí sa na jedno stretnutie zmestia.
  const clenov = Number(g.members_count) || 0;
  const miest = Number(g.capacity) || 0;
  const clenovSlovo = clenov === 1 ? 'člen' : (clenov >= 2 && clenov <= 4 ? 'členovia' : 'členov');

  return `<article class="group-card">
        <div class="group-head">
          ${maskot
    ? `<img class="group-avatar" src="${maskot}" alt="" width="224" height="224" loading="lazy">`
    : '<img class="group-avatar znak" src="/logo.webp" alt="" width="128" height="128" loading="lazy">'}
          <div>
            <h3>${esc(g.name)}</h3>
            ${miesto ? `<p class="group-when">${miesto}</p>` : ''}
          </div>
        </div>
        <div class="group-tags">
          ${sportPillHtml(g.sport, 'tag tag-sport')}
          <span class="tag">${esc(urovenText(g.level_min, g.level_max))}</span>
        </div>
        ${g.description ? `<p class="group-desc">${esc(g.description)}</p>` : ''}
        ${g.organizer_first_name ? `<p class="group-org">${organizator
    ? `<img src="${organizator}" alt="" width="224" height="224" loading="lazy">` : ''}Organizuje ${esc(g.organizer_first_name)}</p>` : ''}
        <div class="group-foot">
          <div class="group-spots"><b>${clenov} ${clenovSlovo}</b><span>${miest > 0 ? `na termín ${miest} miest` : 'pridá sa, kto chce'}</span></div>
          <a class="btn btn-green btn-sm" href="#pridat-sa">Pridať sa v appke</a>
        </div>
      </article>`;
}

/**
 * Zoznam skupín — buď celý (`mesto === null`), alebo jedno mesto.
 *
 * `mestaPodla` je zoznam miest so skupinami (na celej stránke sa z neho
 * skladajú sekcie, na stránke mesta slúži už len na dlaždice „Ďalšie mestá").
 * `maTrenerov` hovorí, či pre toto mesto existuje `treneri/<mesto>/` — bez
 * toho by krížový odkaz viedol na 404.
 */
function strankaSkupin({ mesto, mestaPodla, maTrenerov }) {
  const jeMesto = !!mesto;
  const skupiny = jeMesto
    ? (mestaPodla.find((m) => m.slug === mesto.slug)?.skupiny ?? [])
    : mestaPodla.flatMap((m) => m.skupiny);
  const n = skupiny.length;
  const url = jeMesto ? `${WEB_ORIGIN}/skupiny/${mesto.slug}/` : `${WEB_ORIGIN}/skupiny/`;
  const nadpis = jeMesto ? `Skupiny — ${mesto.name}` : 'Skupiny';
  const title = jeMesto
    ? `Sparingové skupiny ${mesto.name} | Matchball`
    : 'Sparingové skupiny na Slovensku a v Česku | Matchball';
  const popis = n > 0
    ? (jeMesto
      ? `${pocetSkupin(n)} v meste ${mesto.name}, ${n === 1
        ? 'ktorá hráva pravidelne a berie nových hráčov'
        : 'ktoré hrávajú pravidelne a berú nových hráčov'}. Pozri si deň, čas a úroveň — pridáš sa v appke Matchball.`
      : 'Sparingové skupiny podľa miest: partie, ktoré hrávajú pravidelne a hľadajú ďalších hráčov. Pozri si deň, čas a úroveň — pridáš sa v appke Matchball.')
    : (jeMesto
      ? `V meste ${mesto.name} zatiaľ žiadna verejná skupina nie je. Prvé skupiny vznikajú v appke Matchball.`
      : 'Sparingové skupiny sú partie, ktoré hrávajú pravidelne a berú nových hráčov. Prvé skupiny vznikajú v appke Matchball.');

  // Skupina nemá vlastnú adresu, takže položkou zoznamu je samotný termín —
  // `SportsEvent` je jediný typ, ktorý o dni, mieste a kapacite vie povedať
  // pravdu. `url` ukazuje na zoznam mesta, kde skupina naozaj stojí.
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: nadpis,
    url,
    numberOfItems: n,
    itemListElement: skupiny.map((g, i) => {
      const ev = {
        '@type': 'SportsEvent',
        name: g.name,
        url: `${WEB_ORIGIN}/skupiny/${g.mestoSlug}/`,
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        location: {
          '@type': 'Place',
          name: g.venue || g.city,
          address: { '@type': 'PostalAddress', addressLocality: g.city },
        },
      };
      if (g.next_starts_at) ev.startDate = g.next_starts_at;
      if (Number(g.capacity) > 0) ev.maximumAttendeeCapacity = Number(g.capacity);
      if (g.organizer_first_name) ev.organizer = { '@type': 'Person', name: g.organizer_first_name };
      return { '@type': 'ListItem', position: i + 1, item: ev };
    }),
  };

  // Len na stránke mesta. Na celom zozname stoja tie isté mestá o kus vyššie
  // ako nadpisy sekcií a dlaždice pod nimi by boli to isté dvakrát.
  const mestaPills = jeMesto
    ? mestaPodla
      .filter((m) => m.slug !== mesto.slug)
      .map((m) => `<a class="city-pill" href="/skupiny/${m.slug}/">${esc(m.name)} <span>${m.skupiny.length}</span></a>`)
      .join('\n        ')
    : '';

  const sekcie = jeMesto
    ? `<div class="grid-groups solo">
      ${skupiny.map(kartaSkupiny).join('\n      ')}
  </div>`
    : mestaPodla.map((m) => `<section class="city-groups">
    <h2>${esc(m.name)} <span>${pocetSkupin(m.skupiny.length)}</span></h2>
    <div class="grid-groups">
      ${m.skupiny.map(kartaSkupiny).join('\n      ')}
    </div>
  </section>`).join('\n\n  ');

  return `<!doctype html>
<html lang="sk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(popis)}">
<link rel="canonical" href="${url}">
${FAVICONY}
<meta property="og:type" content="website">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(nadpis)} | Matchball">
<meta property="og:description" content="${esc(popis)}">
<meta property="og:image" content="${WEB_ORIGIN}/hero.webp">
<meta property="og:locale" content="sk_SK">
<meta name="twitter:card" content="summary_large_image">
${PISMO}
<style>
${CSS_ZAKLAD}
${CSS_ZOZNAM}
${CSS_SKUPINY}
</style>
<script type="application/ld+json">${json(ld)}</script>
</head>
<body>
<a class="skip" href="#obsah">Preskočiť na obsah</a>
${hlavicka('skupiny')}

<main id="obsah" class="wrap">
  ${jeMesto ? `<nav class="crumbs" aria-label="Drobčeková navigácia" style="display:flex;gap:8px;color:var(--muted);font-size:.86rem;margin-top:8px">
    <a href="/skupiny/">Skupiny</a>
    <span aria-hidden="true" style="opacity:.45">›</span>
    <span style="color:var(--fg);font-weight:600">${esc(mesto.name)}</span>
  </nav>` : ''}
  <header class="sec-head">
    <p class="eyebrow">Skupiny</p>
    <h1>${esc(nadpis)}</h1>
    <p class="lead">${esc(popis)}</p>
  </header>

  ${n > 0 ? sekcie : '<p class="prazdno">Založ svoju v appke — a nechaj ju nájsť ďalších hráčov.</p>'}

  ${mestaPills ? `<section class="cities-block">
    <h2>Ďalšie mestá</h2>
    <div class="cities-pills">
        ${mestaPills}
    </div>
  </section>` : ''}

  ${krizovyOdkaz(
    jeMesto && maTrenerov ? `/treneri/${mesto.slug}/` : '/treneri/',
    jeMesto ? `Chceš sa zlepšiť? Tréneri v meste ${mesto.name}` : 'Chceš sa zlepšiť?',
    'Tréner ti ukáže, čo v hre opraviť. Termín si rezervuješ v appke.',
  )}

  <section class="cta-dark" id="pridat-sa">
    <div class="cta-dark-text">
      <h2>Pridaj sa k partii.</h2>
      <p class="lead">Skupinu nájdeš v appke v Hľadať › Skupiny. Napíšeš organizátorovi a hráš.</p>
      <p class="cta-dark-note">Cez Matchball pri sparingu neprejde ani cent — o peniazoch sa partia dohodne sama.</p>
    </div>
    <div class="cta-dark-actions">
      <a class="btn btn-lime" href="${APP_STORE}">${IKONA.apple}Stiahnuť pre iPhone</a>
      <a class="btn btn-ghost" href="${PLAY_STORE}">${IKONA.play}Stiahnuť pre Android</a>
    </div>
  </section>
</main>

${PATICKA}
</body>
</html>
`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Dáta
// ═══════════════════════════════════════════════════════════════════════════

async function nacitajZoSupabase(url, key) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/public_coach_pages`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    throw new Error(`RPC public_coach_pages zlyhalo: HTTP ${res.status} — ${(await res.text()).slice(0, 400)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('RPC public_coach_pages nevrátilo pole.');
  return data;
}

/**
 * Verejné sparingové skupiny (migrácia 349).
 *
 * Na rozdiel od trénerov sa chyba NEVYHADZUJE: kým 349 nie je na produkcii,
 * RPC neexistuje a PostgREST vráti 404. Stránky trénerov s tým nemajú nič
 * spoločné a nočný beh nesmie padnúť na tom, že jedna funkcia ešte nie je
 * nasadená — vtedy vznikne prázdna stránka skupín a v logu je dôvod.
 */
async function nacitajSkupiny(url, key) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/public_sparring_groups`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      console.warn(`  ! RPC public_sparring_groups: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      console.warn('    Stránka skupín bude prázdna (čaká sa na migráciu 349 na produkcii).');
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.warn('  ! RPC public_sparring_groups nevrátilo pole — stránka skupín bude prázdna.');
      return [];
    }
    return data;
  } catch (e) {
    console.warn(`  ! RPC public_sparring_groups zlyhalo: ${e && e.message ? e.message : e}`);
    console.warn('    Stránka skupín bude prázdna.');
    return [];
  }
}

/**
 * Fotka z privátneho bucketu. Sťahuje sa len vtedy, keď súbor chýba alebo je
 * starší než `updated_at` trénera — nočný beh inak vytiahne desiatky megabajtov
 * za nič.
 */
async function stiahniFotku({ url, key, photoPath, cielovySubor, updatedAt }) {
  if (!photoPath) return false;
  const cas = Date.parse(updatedAt || '');
  if (fs.existsSync(cielovySubor)) {
    const st = fs.statSync(cielovySubor);
    if (!Number.isFinite(cas) || st.mtimeMs >= cas) return true;
  }
  const cesta = String(photoPath).split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`${url.replace(/\/+$/, '')}/storage/v1/object/${BUCKET}/${cesta}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.warn(`  ! fotka ${photoPath}: HTTP ${res.status} — použije sa zástupný znak`);
    return fs.existsSync(cielovySubor);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return fs.existsSync(cielovySubor);
  fs.mkdirSync(path.dirname(cielovySubor), { recursive: true });
  fs.writeFileSync(cielovySubor, buf);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Zápis
// ═══════════════════════════════════════════════════════════════════════════

/** Zapisuje len pri zmene — Action tak nerobí commit z nezmenených súborov. */
function zapis(relativna, obsah) {
  const cielovaCesta = path.join(ROOT, relativna);
  fs.mkdirSync(path.dirname(cielovaCesta), { recursive: true });
  if (fs.existsSync(cielovaCesta) && fs.readFileSync(cielovaCesta, 'utf8') === obsah) return false;
  fs.writeFileSync(cielovaCesta, obsah);
  return true;
}

/**
 * Dlaždice miest na hlavnej stránke.
 *
 * `index.html` je ručne písaná stránka a generátor jej NEPREPISUJE nič okrem
 * dvoch blokov medzi značkami — mestá sa inak menia každú noc a ručne
 * dopisované by boli zastarané prv, než by ich niekto opravil. Keď značky
 * v súbore nie sú (niekto ich pri úprave vyhodil), beh sa nezastaví: napíše
 * o tom a nechá stránku tak, ako je.
 */
function dopisMestaDoIndexu(bloky) {
  const cesta = path.join(ROOT, 'index.html');
  if (!fs.existsSync(cesta)) {
    console.warn('  ! index.html neexistuje — dlaždice miest sa nedoplnili.');
    return false;
  }
  const povodne = fs.readFileSync(cesta, 'utf8');
  let html = povodne;
  for (const [meno, obsah] of Object.entries(bloky)) {
    const re = new RegExp(`(<!-- ${meno}:start -->)[\\s\\S]*?(<!-- ${meno}:end -->)`);
    if (!re.test(html)) {
      console.warn(`  ! index.html nemá značky ${meno}:start/end — dlaždice miest sa nedoplnili.`);
      continue;
    }
    html = html.replace(re, `$1\n${obsah}\n          $2`);
  }
  if (html === povodne) return false;
  fs.writeFileSync(cesta, html);
  return true;
}

/** Dlaždice miest do bloku na hlavnej stránke; bez miest zostane veta. */
function dlaziceMiest(mesta, predpona, prazdneText) {
  if (!mesta.length) return `          <p class="next-note">${esc(prazdneText)}</p>`;
  return mesta
    .map((m) => `          <a class="city-chip" href="${predpona}${m.slug}/">${esc(m.name)} <span>${m.count}</span></a>`)
    .join('\n');
}

/**
 * Priečinky trénerov, ktorí v dátach už nie sú (stránku si vypli, účet zmizol).
 *
 * Maže sa VÝHRADNE vnútri `t/` a len priečinky, ktoré tam generátor sám
 * vyrobil — koreň repozitára obsahuje `legal/`, `auth/` a obrázky webu a
 * generátor nemá dôvod siahnuť na čokoľvek z toho.
 */
function zmazStareStranky(zive) {
  const tDir = path.join(ROOT, 't');
  if (!fs.existsSync(tDir)) return [];
  const zmazane = [];
  for (const meno of fs.readdirSync(tDir).sort()) {
    const p = path.join(tDir, meno);
    if (!fs.statSync(p).isDirectory()) continue;
    if (zive.has(meno)) continue;
    fs.rmSync(p, { recursive: true, force: true });
    zmazane.push(meno);
  }
  return zmazane;
}

/**
 * Zmaže podpriečinky `dir`, ktoré nie sú v `zive` — použité na `treneri/`
 * (mestá aj adresáre športov ležia na tej istej úrovni) aj na `treneri/<sport>/`
 * (mestá toho športu).
 */
function zmazNezive(dir, zive) {
  if (!fs.existsSync(dir)) return [];
  const zmazane = [];
  for (const meno of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, meno);
    if (!fs.statSync(p).isDirectory()) continue;
    if (zive.has(meno)) continue;
    fs.rmSync(p, { recursive: true, force: true });
    zmazane.push(meno);
  }
  return zmazane;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Hlavný beh
// ═══════════════════════════════════════════════════════════════════════════

function argHodnota(meno) {
  const i = process.argv.indexOf(meno);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const fixture = argHodnota('--fixture');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  let treneri;
  let skupinySurove = [];
  if (fixture) {
    console.log(`Fixture: ${fixture}`);
    treneri = JSON.parse(fs.readFileSync(path.resolve(fixture), 'utf8'));
  } else {
    if (!url || !key) {
      console.error('Chýba SUPABASE_URL alebo SUPABASE_SERVICE_KEY (alebo použi --fixture <súbor>).');
      process.exit(1);
    }
    treneri = await nacitajZoSupabase(url, key);
    skupinySurove = await nacitajSkupiny(url, key);
  }

  // Bez slugu niet adresy; bez mena a mesta niet čo ukázať.
  const platni = treneri.filter((c) => c && c.slug && /^[a-z0-9][a-z0-9-]*$/.test(String(c.slug)) && c.name && c.city);
  const preskocene = treneri.length - platni.length;
  if (preskocene > 0) console.warn(`Preskočených ${preskocene} trénerov bez slugu / mena / mesta.`);

  // Bez `sports` (starí tréneri spred migrácie 336, alebo neznáme kódy) je
  // jediný šport tenis — `sportyOf` túto normalizáciu robí pri každom čítaní,
  // tu sa dorába len samotné pole na objekte, nech ho vidí aj `coach.sports`.
  for (const c of platni) c.sports = sportyOf(c);

  // Deterministické poradie: overení hore, potom hodnotenie, počet hodnotení
  // a nakoniec meno. `localeCompare` s pevným locale, nie podľa prostredia.
  const zorad = (a, b) =>
    (b.verified ? 1 : 0) - (a.verified ? 1 : 0)
    || (Number(b.avg_rating) || 0) - (Number(a.avg_rating) || 0)
    || (Number(b.review_count) || 0) - (Number(a.review_count) || 0)
    || String(a.name).localeCompare(String(b.name), 'sk')
    || String(a.slug).localeCompare(String(b.slug), 'sk');
  platni.sort(zorad);

  // ── Fotky ────────────────────────────────────────────────────────────────
  for (const coach of platni) {
    const dir = path.join(ROOT, 't', coach.slug);
    coach.fotoSubor = null;
    if (coach.photo_path && !fixture) {
      const ok = await stiahniFotku({
        url, key, photoPath: coach.photo_path,
        cielovySubor: path.join(dir, 'foto.jpg'),
        updatedAt: coach.updated_at,
      });
      if (ok) coach.fotoSubor = 'foto.jpg';
    } else if (coach.photo_path && fixture) {
      // Pri fixture sa nesťahuje; ak fotka na disku je (z predošlého behu), použije sa.
      if (fs.existsSync(path.join(dir, 'foto.jpg'))) coach.fotoSubor = 'foto.jpg';
    }

    const reviews = Array.isArray(coach.reviews) ? coach.reviews.slice(0, 6) : [];
    coach.reviews = reviews;
    for (let i = 0; i < reviews.length; i++) {
      const r = reviews[i];
      r.fotoSubor = null;
      const meno = `r${i + 1}.jpg`;
      if (r.photo_path && !fixture) {
        const ok = await stiahniFotku({
          url, key, photoPath: r.photo_path,
          cielovySubor: path.join(dir, meno),
          updatedAt: coach.updated_at,
        });
        if (ok) r.fotoSubor = meno;
      } else if (r.photo_path && fixture && fs.existsSync(path.join(dir, meno))) {
        r.fotoSubor = meno;
      }
    }
  }

  // ── Mestá ────────────────────────────────────────────────────────────────
  const mestaMap = new Map();
  for (const coach of platni) {
    const slug = slugify(coach.city_key || coach.city);
    if (!slug) continue;
    coach.mestoSlug = slug;
    if (!mestaMap.has(slug)) mestaMap.set(slug, { slug, name: coach.city, coaches: [] });
    mestaMap.get(slug).coaches.push(coach);
  }
  const mesta = [...mestaMap.values()]
    .map((m) => ({ ...m, count: m.coaches.length }))
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'sk'));

  // Športy prítomné v jednotlivých mestách a celkovo — pre chipy vo filtri
  // a pre to, ktoré `treneri/<sport>/` stránky vôbec dáva zmysel generovať.
  const sportyPoMeste = new Map();
  for (const coach of platni) {
    if (!sportyPoMeste.has(coach.mestoSlug)) sportyPoMeste.set(coach.mestoSlug, new Set());
    for (const s of coach.sports) sportyPoMeste.get(coach.mestoSlug).add(s);
  }
  const sportyGlobalne = SPORT_ORDER.filter((s) => platni.some((c) => c.sports.includes(s)));

  // Tréneri a mestá pre každý šport — `treneri/<sport>/` a `treneri/<sport>/<mesto>/`.
  const sportMestaMap = new Map(); // sport -> Map(citySlug -> {slug, name, coaches})
  for (const coach of platni) {
    for (const s of coach.sports) {
      if (!sportMestaMap.has(s)) sportMestaMap.set(s, new Map());
      const m = sportMestaMap.get(s);
      if (!m.has(coach.mestoSlug)) m.set(coach.mestoSlug, { slug: coach.mestoSlug, name: coach.city, coaches: [] });
      m.get(coach.mestoSlug).coaches.push(coach);
    }
  }

  // ── Skupiny ──────────────────────────────────────────────────────────────
  //
  // Bez mesta a názvu niet čo ukázať; bez `city_key` by skupina nemala kam
  // patriť. Sport, ktorý generátor nepozná, sa berie ako tenis — rovnaká
  // úvaha ako pri trénerovi bez `sports`.
  const skupiny = skupinySurove.filter((g) => g && g.name && g.city && slugify(g.city_key || g.city));
  const preskoceneSkupiny = skupinySurove.length - skupiny.length;
  if (preskoceneSkupiny > 0) console.warn(`Preskočených ${preskoceneSkupiny} skupín bez mena alebo mesta.`);
  for (const g of skupiny) {
    g.mestoSlug = slugify(g.city_key || g.city);
    if (!SPORT_NAZOV[g.sport]) g.sport = 'tennis';
  }

  const skupinyMestaMap = new Map();
  for (const g of skupiny) {
    if (!skupinyMestaMap.has(g.mestoSlug)) {
      skupinyMestaMap.set(g.mestoSlug, { slug: g.mestoSlug, name: g.city, skupiny: [] });
    }
    skupinyMestaMap.get(g.mestoSlug).skupiny.push(g);
  }
  // Poradie ako v RPC (349): najbližší termín hore, skupina bez termínu na
  // koniec, pri zhode podľa názvu. Mestá podľa počtu skupín, potom abecedne —
  // rovnako ako pri trénerov.
  const casTerminu = (g) => {
    const t = Date.parse(g.next_starts_at || '');
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  for (const m of skupinyMestaMap.values()) {
    m.skupiny.sort((a, b) =>
      casTerminu(a) - casTerminu(b) || String(a.name).localeCompare(String(b.name), 'sk'));
  }
  const mestaSkupin = [...skupinyMestaMap.values()]
    .sort((a, b) => b.skupiny.length - a.skupiny.length || a.name.localeCompare(b.name, 'sk'));
  const mestaSoSkupinami = new Set(mestaSkupin.map((m) => m.slug));
  const mestaSTrenermi = new Set(mesta.map((m) => m.slug));

  // ── Generovanie ──────────────────────────────────────────────────────────
  const ctx = { appStore: APP_STORE, playStore: PLAY_STORE };
  let zmenene = 0;
  const zive = new Set(platni.map((c) => c.slug));

  for (const coach of platni) {
    if (zapis(path.join('t', coach.slug, 'index.html'), strankaTrenera(coach, ctx))) zmenene++;
  }

  const vsetkyMesta = mesta.map(({ slug, name, count }) => ({ slug, name, count }));
  if (zapis(path.join('treneri', 'index.html'),
    strankaZoznamu({
      mesto: null, sport: null, coaches: platni, ostatneMesta: vsetkyMesta,
      sportyVScope: sportyGlobalne, skupinyMesta: mestaSoSkupinami,
    }))) zmenene++;

  for (const m of mesta) {
    const sportyMesta = SPORT_ORDER.filter((s) => sportyPoMeste.get(m.slug)?.has(s));
    if (zapis(path.join('treneri', m.slug, 'index.html'),
      strankaZoznamu({
        mesto: m, sport: null, coaches: m.coaches, ostatneMesta: vsetkyMesta,
        sportyVScope: sportyMesta, skupinyMesta: mestaSoSkupinami,
      }))) zmenene++;
  }

  // Adresáre podľa športu — len tie, kde je aspoň jeden tréner.
  const sportyStranky = []; // { sport, slug, mesta: [{slug,name,count}] } — pre sitemapu a upratovanie
  for (const sport of sportyGlobalne) {
    const cityMap = sportMestaMap.get(sport);
    const sportCoaches = platni.filter((c) => c.sports.includes(sport));
    const sportMesta = [...cityMap.values()]
      .map((m) => ({ ...m, count: m.coaches.length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'sk'));
    const sportSlug = SPORT_SLUG[sport];
    sportyStranky.push({ sport, slug: sportSlug, mesta: sportMesta.map(({ slug, name, count }) => ({ slug, name, count })) });

    if (zapis(path.join('treneri', sportSlug, 'index.html'),
      strankaZoznamu({
        mesto: null, sport, coaches: sportCoaches,
        ostatneMesta: sportMesta.map(({ slug, name, count }) => ({ slug, name, count })),
        sportyVScope: sportyGlobalne, skupinyMesta: mestaSoSkupinami,
      }))) zmenene++;

    for (const m of sportMesta) {
      const sportyVMesteScope = SPORT_ORDER.filter((s) => sportyPoMeste.get(m.slug)?.has(s));
      if (zapis(path.join('treneri', sportSlug, m.slug, 'index.html'),
        strankaZoznamu({
          mesto: m, sport, coaches: m.coaches,
          ostatneMesta: sportMesta.map(({ slug, name, count }) => ({ slug, name, count })),
          sportyVScope: sportyVMesteScope, skupinyMesta: mestaSoSkupinami,
        }))) zmenene++;
    }
  }

  // Skupiny. Stránka `skupiny/` vzniká VŽDY, aj keď skupina zatiaľ nie je
  // žiadna: odkazuje na ňu hlavička, pätička aj hlavná stránka a 404 by z toho
  // spravila chybu webu, nie prázdny zoznam.
  if (zapis(path.join('skupiny', 'index.html'),
    strankaSkupin({ mesto: null, mestaPodla: mestaSkupin, maTrenerov: false }))) zmenene++;

  for (const m of mestaSkupin) {
    if (zapis(path.join('skupiny', m.slug, 'index.html'),
      strankaSkupin({
        mesto: { slug: m.slug, name: m.name },
        mestaPodla: mestaSkupin,
        maTrenerov: mestaSTrenermi.has(m.slug),
      }))) zmenene++;
  }

  // ── Sitemap ──────────────────────────────────────────────────────────────
  const den = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
  };
  const najnovsi = platni.reduce((acc, c) => {
    const d = den(c.updated_at);
    return d && (!acc || d > acc) ? d : acc;
  }, null);
  // Skupiny majú vlastný `lastmod`: keď pribudne skupina, stránka trénerov sa
  // nezmenila a naopak. `created_at` je jediný dátum, ktorý RPC vydáva.
  const najnovsiaSkupina = skupiny.reduce((acc, g) => {
    const d = den(g.created_at);
    return d && (!acc || d > acc) ? d : acc;
  }, null);
  const polozka = (loc, lastmod, priority) =>
    `  <url>\n    <loc>${loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <priority>${priority}</priority>\n  </url>`;
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[
    polozka(`${WEB_ORIGIN}/`, najnovsi, '1.0'),
    polozka(`${WEB_ORIGIN}/treneri/`, najnovsi, '0.9'),
    ...mesta.map((m) => polozka(`${WEB_ORIGIN}/treneri/${m.slug}/`, najnovsi, '0.8')),
    ...sportyStranky.map((s) => polozka(`${WEB_ORIGIN}/treneri/${s.slug}/`, najnovsi, '0.75')),
    ...sportyStranky.flatMap((s) => s.mesta.map((m) =>
      polozka(`${WEB_ORIGIN}/treneri/${s.slug}/${m.slug}/`, najnovsi, '0.7'))),
    polozka(`${WEB_ORIGIN}/skupiny/`, najnovsiaSkupina || najnovsi, '0.8'),
    ...mestaSkupin.map((m) => polozka(`${WEB_ORIGIN}/skupiny/${m.slug}/`, najnovsiaSkupina || najnovsi, '0.7')),
    ...platni.map((c) => polozka(`${WEB_ORIGIN}/t/${c.slug}/`, den(c.updated_at), '0.7')),
  ].join('\n')}
</urlset>
`;
  if (zapis('sitemap.xml', sitemap)) zmenene++;

  // ── GitHub Pages a hlboké odkazy ─────────────────────────────────────────
  // Bez `.nojekyll` Jekyll priečinky začínajúce bodkou nepublikuje a
  // `.well-known/` by na webe vôbec nebolo — hlboké odkazy by tíško nefungovali.
  if (zapis('.nojekyll', '')) zmenene++;

  const aasa = {
    applinks: { apps: [], details: [{ appID: APPLE_APP_ID, paths: ['/t/*'] }] },
  };
  if (zapis(path.join('.well-known', 'apple-app-site-association'), `${JSON.stringify(aasa, null, 2)}\n`)) zmenene++;

  // Odtlačok podpisového kľúča sa dá získať len z EAS (`eas credentials`) —
  // do repa ho generátor nemá odkiaľ vziať, preto placeholder. Kým tam je
  // „DOPLNIT", Android hlboké odkazy na `/t/*` neoveria a otvoria sa v prehliadači.
  // Súbor musí zostať čistým Digital Asset Links statementom — overovač Googlu
  // cudzie kľúče neznáša, takže poznámka je v README a vo výpise, nie tu.
  const assetlinks = [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE,
      sha256_cert_fingerprints: ['DOPLNIT'],
    },
  }];
  if (zapis(path.join('.well-known', 'assetlinks.json'), `${JSON.stringify(assetlinks, null, 2)}\n`)) zmenene++;

  // ── Upratovanie ──────────────────────────────────────────────────────────
  const zmazaniTreneri = zmazStareStranky(zive);
  // `treneri/` obsahuje mestá aj adresáre športov na tej istej úrovni —
  // priečinok, ktorý nie je ani jedno z toho (šport bez trénera, mesto bez
  // trénera), sa zmaže tu; podmestá vnútri žijúcich športov sa upracú zvlášť.
  const ziveVTreneri = new Set([...mesta.map((m) => m.slug), ...sportyStranky.map((s) => s.slug)]);
  const zmazaneMesta = zmazNezive(path.join(ROOT, 'treneri'), ziveVTreneri);
  for (const s of sportyStranky) {
    const zmazane = zmazNezive(path.join(ROOT, 'treneri', s.slug), new Set(s.mesta.map((m) => m.slug)));
    zmazaneMesta.push(...zmazane.map((m) => `${s.slug}/${m}`));
  }

  const zmazaneMestaSkupin = zmazNezive(path.join(ROOT, 'skupiny'), mestaSoSkupinami);

  // ── Dlaždice miest na hlavnej stránke ────────────────────────────────────
  if (dopisMestaDoIndexu({
    'mesta-treneri': dlaziceMiest(
      mesta.map(({ slug, name, count }) => ({ slug, name, count })),
      '/treneri/',
      'Mestá pribúdajú, ako sa tréneri pridávajú.',
    ),
    'mesta-skupiny': dlaziceMiest(
      mestaSkupin.map((m) => ({ slug: m.slug, name: m.name, count: m.skupiny.length })),
      '/skupiny/',
      'Prvé skupiny vznikajú v appke.',
    ),
  })) zmenene++;

  console.log(`Tréneri: ${platni.length} · mestá: ${mesta.length} · zapísaných súborov: ${zmenene}`);
  console.log(`Skupiny: ${skupiny.length} · mestá so skupinami: ${mestaSkupin.length}`);
  if (zmazaniTreneri.length) console.log(`Zmazané stránky trénerov: ${zmazaniTreneri.join(', ')}`);
  if (zmazaneMesta.length) console.log(`Zmazané stránky miest: ${zmazaneMesta.join(', ')}`);
  if (zmazaneMestaSkupin.length) console.log(`Zmazané stránky miest so skupinami: ${zmazaneMestaSkupin.join(', ')}`);
  const bezOdtlacku = fs.readFileSync(path.join(ROOT, '.well-known', 'assetlinks.json'), 'utf8').includes('DOPLNIT');
  if (bezOdtlacku) {
    console.log('POZOR: .well-known/assetlinks.json má placeholder "DOPLNIT" — doplň SHA-256 odtlačok z `eas credentials`, inak Android hlboké odkazy neoverí.');
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
