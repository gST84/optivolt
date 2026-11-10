# Ontwerp: EV-laden opnieuw opgebouwd

Status: **ontwerp, ter review** — nog geen code.
Branch: `feature/ev-redesign`.

## 1. Waarom

Het EV-laden is in stappen gegroeid: weekplanner, ESS-ondergrens, goedkoopste-bron-greedy,
zachte doelen, override, tripvoorspelling. Elke stap greep op een andere plek in (LP,
config-builder, greedy na de solve, `/ev/current`). Het resultaat is moeilijk te voorspellen en
moeilijk te testen. We bouwen het EV-deel opnieuw op rond één duidelijk model, met alle
bestaande functionaliteit plus de nieuwe eisen hieronder.

## 2. Uitgangspunten

| # | Principe |
|---|---|
| P1 | **De planner beslist *wat*, de bewaker beslist *hoe hard*.** De planner (elk kwartier) maakt het plan; de bewaker (elke 10–30 s, bij elke `/ev/current`-oproep) past de laadstroom aan de werkelijkheid aan. |
| P2 | **De EV-beslissing is een vaste regel, geen vrije keuze van de solver.** De EV-regels (§ 6) leggen per kwartier de EV-stroom en de bron vast. De LP plant de ESS, het huis en het net daaromheen. Zo zie je in het plan precies de regel terug. |
| P3 | **Alles zacht, nooit "Infeasible".** Doelen en grenzen die niet haalbaar zijn geven een zo goed mogelijk plan plus een melding *welk* doel gemist wordt en *waarom*. Alleen fysieke grenzen zijn hard. |
| P4 | **De capaciteitspiek blijft bij het minimum.** De gefactureerde minimumpiek (2,5 kW in Vlaanderen) is de doelgrens, met een veiligheidsmarge zodat de piek niet kruipt. |
| P5 | **Rangorde:** Direct laden > Eenmalig plan > Terugkerend plan. Een hoger plan schort een lager plan in hetzelfde tijdvak op, het verwijdert het niet. |

## 3. Begrippen

| Begrip | Betekenis |
|---|---|
| **Batterijprijs** | Gewogen gemiddelde prijs van de energie die nu in de ESS zit (c€/kWh), zie § 5. |
| **Kost ESS→EV** | `batterijprijs / ηd + slijtage` — wat één kWh uit de ESS naar de EV kost. |
| **ESS-ondergrens voor EV** | Laagste SoC tot waar de EV de ESS mag leegtrekken, zie § 6.1. |
| **Herlaadmoment** | Eerste kwartier waarop het plan de ESS weer laadt (net of PV) of waarop PV het huisverbruik dekt. |
| **Doelgrens (piek)** | `max(minimumpiek, betaalde piek indien toegelaten) − marge`, in kW, zie § 7. |
| **Emmer** | Toegelaten netafname in het lopende kwartier: `doelgrens × 0,25 h`. |

## 4. Plannen

### 4.1 Overzicht

| Prioriteit | Type | Herhaling | Kern |
|---|---|---|---|
| 1 | **Direct laden** | – | Nu laden, schakelaar + stroom/modus |
| 2 | **Doel-SoC op tijdstip** (vertrek) | eenmalig of weekdagen | SoC X % om HH:MM |
| 2 | **Trip** | eenmalig of weekdagen | vertrek + terugkeer + afstand in km |
| 2 | **Aankomst** | eenmalig of weekdagen | auto komt om HH:MM thuis met ±Y % |
| 3 | **Goedkoopste laden** | weekdagen | laadvenster zonder harde deadline |

- *Vertrek* en *aankomst* werken zoals nu in Optivolt (`EvScheduleEntry` types `departure`,
  `arrival`, `target`).
- Elk plan van prioriteit 2 en 3 heeft weekdag-checkboxen (ma → zo). Geen vinkje = eenmalig op
  de gekozen datum.
- Een *goedkoopste*-plan kan een **ESS-doel-SoC** krijgen (bestaat nu als `ess_soc_percent`): de
  ESS moet bij het begin van het laadvenster op dat niveau staan; de LP mag ze daarvoor op
  goedkope momenten voorladen (zacht doel). Plannen met een deadline hebben geen vast venster,
  dus daar geen ESS-doel.
- Datamodel: `EvPlan` in `api/types.ts`, logica in `api/services/ev-plans.ts`, API
  `GET/POST /ev/plans`, `PATCH/DELETE /ev/plans/:id`. Eenmalig = ISO-tijd, terugkerend = `HH:MM`
  plus weekdagen.

### 4.2 Direct laden (prioriteit 1)

Schakelaar op de EV-tab met een modus:

| Modus | Gedrag |
|---|---|
| **Vaste stroom** | Laden aan de gekozen stroom (zoals nu `evOverrideCurrent_A`), binnen de piekgrens. |
| **Snel vanaf ESS** | Laadvermogen = wat de omvormer nog kan leveren (`maxDischargePower_W − huisverbruik`), tot de ESS-ondergrens. Daarna *traag van het net* (zie hieronder). |
| **Piek negeren** | Optie die je bewust aanzet: de piekgrens geldt niet. Toont een waarschuwing. |

*Traag van het net* (enkel zichtbaar als een maandpiek-sensor gekozen is):

- **Minimumstroom** — `evMinChargeCurrent_A`, of pauze als dat niet onder de doelgrens past.
- **Tot de doelgrens** — zoveel als de emmer toelaat (§ 7).

Zonder maandpiek-sensor: minimumstroom.

### 4.3 Doel-SoC op tijdstip (prioriteit 2)

1. Lees de EV-SoC (HA). Nodige energie: `(doel − SoC) × capaciteit / ηEV` (laadrendement).
2. Kies de goedkoopste kwartieren tot de deadline, per kwartier de goedkoopste bron:
   net (`importprijs + piekkost`) of ESS (`kost ESS→EV`, zolang boven de ondergrens en binnen het
   vrije omvormervermogen).
3. Niet haalbaar binnen de piekgrens → plan zo dicht mogelijk bij het doel + melding.

### 4.4 Trip (prioriteit 2)

- Instelling **verbruik** (kWh/100 km). Geen wintertoeslag (V7).
- **Geleerd verbruik:** is er een **kilometerstand-sensor** gekozen, dan berekent Optivolt per rit
  `SoC-daling × capaciteit ÷ gereden km` en gebruikt het gemiddelde van de laatste weken (recente
  ritten zwaarder). Zonder sensor geldt het vaste getal uit de instellingen.
- Tripplanner: vertrektijd, terugkeertijd, **af te leggen afstand (km)**.
- Nodige SoC bij vertrek = `afstand × verbruik + buffer (evTripSocBuffer_percent)`.
- Daarna identiek aan § 4.3. Tijdens de trip is de auto weg; bij terugkeer is de verwachte SoC
  `SoC bij vertrek − tripverbruik` (tenzij de sensor iets anders zegt).
- Het huidige veld `usage_percent` vervalt (migratie: omrekenen naar km met het verbruik).

### 4.5 Goedkoopste laden (prioriteit 3)

Laadvenster op weekdagen (bv. wo + vr 22:00 → 07:00), **zonder harde deadline**. Prijs en
capaciteitstarief gaan voor; de EV laadt zoveel als goedkoop kan, tot `evMaxSoc_percent`.

Voorbereiding (vóór het venster):

- **SoC-voorspelling:** de EV-SoC wordt continu gelezen; het verbruik tussen nu en de laaddag
  wordt voorspeld uit de historiek (bestaand: `ev-trip-usage.ts`, per weekdag). Recente weken
  wegen zwaarder, zodat de voorspelling seizoenen (winterverbruik) snel volgt.
- **Prijsvoorspelling:** bestaand — `price-forecast-service.ts` (EpexPredictor-feed via
  `priceForecastUrl`) verlengt de prijzen tot `extendedHorizonDays` (max. 6). Echte day-ahead
  prijzen gaan altijd voor; zodra ze er zijn wordt herpland.
- **ESS voorladen:** het ESS-doel van het plan (§ 4.1) laat de LP de ESS vooraf laden als dat
  goedkoper is dan de verwachte netprijs in het venster, *rekening houdend met laad- en
  ontlaadverliezen*: voorladen loont pas als
  `prijs_nu / (ηc × ηd) + slijtage < verwachte netprijs in het venster`.

Tijdens het venster: elk kwartier de regel van § 6.2.

Instelling per plan: **na de ESS-ondergrens** → *stoppen* of *doorladen van het net* (tot max.
SoC, binnen de piekgrens).

## 5. Batterijprijs

**Bron:** historiek uit HA. Er zijn geen energietellers per stroom, wel **vermogenssensoren**;
die worden kiesbaar zoals de andere HA-variabelen:

| Sensor | Eenheid |
|---|---|
| Netvermogen (import +, export −; of twee aparte sensoren in/uit) | W |
| PV-vermogen | W |
| Batterijvermogen (laden +, ontladen −; of twee aparte sensoren in/uit) | W |
| Importprijs | c€/kWh (bestaande prijsreeks van Optivolt) |

**Splitsing net/PV → batterij** (per meetpunt, PV gaat eerst naar het huis):

```text
huis        = net_in − net_uit + pv + bat_uit − bat_in
pv_naar_bat = min(bat_in, max(0, pv − huis))
net_naar_bat = bat_in − pv_naar_bat
```

- Historiek: HA-statistieken per 5 min (gemiddeld vermogen; HA bewaart die standaard ±10
  dagen) → per kwartier omgezet naar Wh. Daarna houdt Optivolt de voorraad zelf lopend bij en
  bewaart ze in `data.json`, zodat er geen lange historiek nodig is.
- Het batterijvermogen van Victron is DC-zijde; het omvormerverlies zit dus al tussen net en
  batterij. Geen extra correctie.

**Berekening:** lopend gewogen gemiddelde. Laden verhoogt de voorraad tegen zijn prijs;
ontladen haalt energie weg zonder de gemiddelde prijs te veranderen.

- Net → batterij telt aan de **importprijs** van dat kwartier.
- PV → batterij telt aan **0 ct** (beslissing V1).
- Laadverlies: de prijs per kWh *in* de batterij is `prijs / ηc`.

**Terugval** zonder sensoren: de huidige berekening uit het plan (`battery-energy-price.ts`).

*Gebouwd (fase 2):* `lib/battery-ledger.ts` (grootboek: energie + kost, bijgewerkt per 5 min,
na elke update herschaald naar de echte SoC) en `api/services/battery-ledger-service.ts`
(HA-statistieken, eenheden W/kW, opslag als `batteryLedger` in `data.json`). Bij de eerste keer
start het grootboek bij het begin van de opgeslagen prijsreeks (max. 24 h terug), met de
prijs uit het vorige plan of de schatting. Een grootboek ouder dan 6 h wordt niet gebruikt. De
bron staat in het plan als `batteryEnergyPriceSource` (`ha` / `plan` / `estimate`) en als
tooltip op de prijs.

## 6. EV-regels

### 6.1 ESS-ondergrens voor de EV

```text
ondergrens_Wh = minSoc_VRM_Wh
              + voorspeld huisverbruik (nu → herlaadmoment) / ηd
              + marge (instelbaar, standaard 0)
```

- `minSoc_VRM` is de minimum-SoC uit VRM/instellingen (`minSoc_percent`).
- Het herlaadmoment wordt **uit het plan afgeleid**, niet uit een vast uur.
- Wordt elk kwartier herberekend (verbruik en plan schuiven mee).
- De vaste ondergrens `evEssSocFloor_percent` blijft als *minimum* bestaan:
  `ondergrens = max(vast, dynamisch)`.

*Gebouwd (fase 2):* `lib/ess-ev-floor.ts`, per kwartier berekend uit het opgeloste plan en
getoond als stippellijn "EV floor" op de SoC-grafiek (`essEvFloor_percent` per rij). De EV-regels
gebruiken hem vanaf fase 3.

### 6.2 Bronkeuze per kwartier

Voor elk kwartier waarin de EV mag laden:

```text
kost_net = importprijs + piekkost (0 zolang onder de doelgrens)
kost_ess = batterijprijs / ηd + slijtage

als kost_net ≤ kost_ess            → laden van het net (binnen de emmer)
anders als ESS > ondergrens        → laden van de ESS (binnen vrij omvormervermogen)
anders (ondergrens bereikt)        → stoppen of doorladen van het net (instelling)
```

- *Huis eerst*: de ESS voedt eerst het huis; de EV krijgt enkel wat de omvormer daarnaast nog kan
  leveren. Wat de EV meer vraagt komt van het net en valt onder de piekgrens.
- PV-overschot gaat altijd eerst naar de EV, als die laadt.

*Gebouwd (fase 3):* `lib/ev-rules.ts`. De planner zet de plannen om in laadverzoeken
(`buildEvRuleRequests` in `api/services/ev-plans.ts`): een *deadline* (doel-SoC, vertrek met
SoC, trip = verbruik + buffer) vanaf het begin van het venster waarin de auto thuis is, en een
*goedkoopste* venster per stuk waarin de auto thuis is. Per verzoek, in tijdsvolgorde, lost de
planner het huisplan op met de EV-stromen tot dan, berekent de dynamische ondergrens en laat de
regels de stromen vastleggen:

- *goedkoopste*: per kwartier PV-overschot, dan net als `importprijs ≤ ESS-kost`, anders ESS tot
  de ondergrens (met het vermogen dat het huis vrijlaat), daarna net enkel bij `afterFloor: grid`;
- *deadline*: de goedkoopste (kwartier, bron)-opties eerst tot het doel gehaald is.

Daarna gaat PV-overschot buiten de plannen naar de EV (tot `evMaxSoc_percent`), en lost de LP
een laatste keer op met alle EV-stromen vast. Net voor de EV blijft onder de piek-doelgrens en
`maxGridImport_W`. Een trip die meer verbruikt dan er bij vertrek in de auto zit, wordt
afgetopt zodat de LP haalbaar blijft. Met "Charge now" aan blijft het oude pad (LP kiest vrij)
tot fase 4.

### 6.3 Minimale laadduur

Om aan/uit per kwartier te vermijden: **minimale laadduur** (standaard 30 min) en **minimale
pauze** (standaard 15 min). De regel groepeert kwartieren tot aaneengesloten blokken; een los
kwartier dat net goedkoper is wordt niet apart gestart.

### 6.4 Stoppen

| Reden | Gedrag |
|---|---|
| EV-SoC ≥ doel of `evMaxSoc_percent` | stoppen |
| ESS-ondergrens bereikt en instelling = stoppen | stoppen |
| Emmer leeg (piekgrens) | pauze tot het volgende kwartier |
| API-pauze (§ 9.2) | pauze tot de opgegeven tijd |
| Vangnet (§ 9.3) | terugvalstand |

## 7. Capaciteitstarief en piekbewaking

### 7.1 Doelgrens

```text
basis      = max(minimumpiek, betaalde maandpiek)   als "gebruik betaalde piek" aan
           = minimumpiek                            anders (standaard)
doelgrens  = basis − marge
```

- **Minimumpiek** instelbaar, standaard **2,5 kW**.
- **Marge** instelbaar, standaard **0,2 kW**. Zo blijft een kleine overschrijding onder de piek
  die je al betaalt en kruipt de piek niet omhoog.
- **Betaalde maandpiek** uit een HA-sensor (digitale meter / P1).

### 7.2 Planner

- De LP krijgt een **zachte** grens op netafname per kwartier = doelgrens, met een hoge boete
  (tier 2, § 8). Dat geldt voor *alle* netafname: huis + ESS-laden + EV.
- Het ESS-laden van het net wordt dus over de goedkope kwartieren gespreid zodat
  `huis (voorspeld) + ESS-laden + EV ≤ doelgrens`.
- `maxGridImport_W` blijft bestaan als **harde fysieke grens** (aansluiting/zekering).

*Gebouwd (fase 3):* `peakTarget_W` in de LP is één variabele voor het hoogste deel boven de
doelgrens, met een boete van 500 c€ per kW (`PEAK_PENALTY_CENTS_PER_KW`, ongeveer een maand
capaciteitstarief). Een piek die al boven de grens zit is daarna gratis voor de rest van de
horizon, zoals een maandpiek. De maandpiek-sensor telt enkel mee met "gebruik betaalde piek";
minimumpiek 0 = uit.

### 7.3 Bewaker (emmer per kwartier)

Bij elke `/ev/current`-oproep (verwacht elke 10–30 s):

```text
emmer          = doelgrens × 0,25 h
verbruikt      = netafname sinds begin van dit kwartier (live sensor, geïntegreerd)
over           = emmer − verbruikt − veiligheidsreserve (5 % van de emmer)
resttijd       = tijd tot einde kwartier
huis_zonder_ev = live netvermogen − huidig EV-vermogen
toegelaten_ev  = over / resttijd − huis_zonder_ev     (+ ESS- en PV-bijdrage)
```

- `toegelaten_ev` < minimumvermogen → pauze.
- Omdat het tarief op het **kwartiergemiddelde** rekent, mag de EV na een korte piek (oven)
  even inhalen zolang de emmer niet leeg raakt.
- De bewaker kan de EV alleen *verminderen* ten opzichte van het plan, nooit verhogen boven het
  plan (behalve bij PV-overschot dat anders teruggeleverd wordt — *open vraag V3*).
- Benodigde HA-sensor: **live netvermogen** (W, dezelfde als in § 5). Optioneel:
  **EV-vermogen** (W) voor een exactere `huis_zonder_ev`; anders wordt de laatst gestuurde
  stroom gebruikt. Optivolt leest de sensor zelf bij elke oproep en integreert hem per kwartier.
- **Oproepfrequentie:** Optivolt meet de tijd tussen twee `/ev/current`-oproepen en toont die in
  het statusblok, met een waarschuwing als ze boven 30 s ligt. Het document levert een
  voorbeeld-automatisering die elke 15 s oproept (`time_pattern`, `seconds: "/15"`).

*Gebouwd (fase 4):* `lib/ev-guard.ts` + `api/services/ev-guard-service.ts`. De bewaker telt de
netafname per kwartier op uit de live netsensor (tussen twee metingen geldt de vorige waarde,
gaten tot een kwartier worden opgevuld) en berekent per oproep
`EV-vermogen ≤ huidig EV-vermogen + toegelaten gemiddelde − huidige netafname`. Zo vangt de EV
een huispiek (oven) op, en wordt een EV die uit de ESS laadt niet onnodig afgeremd (het net
blijft daar ±0). PV die op dat moment teruggeleverd wordt mag er bovenop (V3), behalve als de
EV al aan zijn maximum zit. De toestand (emmer, fasen, laatste opdracht) zit in het geheugen;
na een herstart begint een nieuw kwartier. Is de netsensor onleesbaar of ouder dan de
vangnet-tijd terwijl er een piekgrens geldt, dan volgt het vangnet (`grid_sensor_unavailable`).

### 7.4 Status op de EV-tab

Klein blok: live netvermogen, doelgrens, gebruikt/over in de emmer van dit kwartier, betaalde
maandpiek, huidige beslissing en **reden** (bv. "piekbudget", "ESS-ondergrens", "goedkoper van
net"). Geen aparte live-pagina.

## 8. Solver (uit evcc)

### 8.1 Zachte doelen met boetes in trappen

| Tier | Wat | Boete (orde van grootte) |
|---|---|---|
| hard | huisverbruik gedekt, omvormer- en laderlimieten, `maxGridImport_W` | – |
| 1 | ESS onder `minSoc` (VRM) | × 1000 basis |
| 2 | Doelgrens piek overschreden, EV-doel niet gehaald, ESS-doel per plan niet gehaald | × 100 basis |
| 3 | Gewone kosten: import, export, slijtage, restwaarde | geld |
| 4 | Voorkeuren (tie-breaks): liever PV lokaal, liever vroeg | klein |

`basis` = hoogste importprijs in de horizon (zoals evcc's `penalty_base`), zodat de trappen bij
elk prijsniveau gescheiden blijven.

Elke gebruikte boetevariabele (> 0) wordt in het plan gemeld: welk doel, hoeveel tekort, en de
oorzaak (te weinig tijd, piekgrens, ESS-ondergrens).

*Gebouwd (fase 3):* de EV-doelen zitten niet meer in de LP (de regels leggen de stromen vast),
dus de LP kan daardoor niet meer "Infeasible" worden. Meldingen staan in `summary.warnings` en
in `/ev/current` (`warnings`): `ev_target_missed` (met verwacht % en of de piekgrens de
oorzaak was), `peak_over_target` en `ev_rules_failed`. De minimum-SoC-boete is ongewijzigd
gebleven.

### 8.2 Rekenen in stappen

Omdat de EV via een vaste regel loopt (P2), is de LP grotendeels continu en snel. Voorlopig
**één solve** met de tiers van § 8.1. Een tweede stap (voorkeuren onder een kostengrens) komt
er enkel als de tests tie-break-problemen tonen.

### 8.3 Horizon

- Kwartieren voor de hele horizon. Met `extendedHorizonDays = 6` zijn dat ±650 stappen; zonder
  EV-binaries moet dat ruim binnen de tijdslimiet blijven. Te meten in de testscenario's;
  zo niet: uurstappen na de day-ahead periode.

## 9. Aansturing en API

### 9.1 `GET /ev/current`

Bestaande velden blijven (achterwaarts compatibel); nieuw:

```json
{
  "current_A": 10,
  "phases": 1,
  "is_charging": true,
  "source": "ess",
  "reason": "cheaper_than_grid",
  "plan_type": "cheapest",
  "peak": { "target_kW": 2.3, "bucket_left_Wh": 410, "month_peak_kW": 2.48 },
  "override_active": false,
  "paused_until": null,
  "plan_valid": true
}
```

`reason` is één van: `cheaper_than_grid`, `cheaper_than_ess`, `pv_surplus`, `ess_floor`,
`peak_budget`, `soc_reached`, `paused_api`, `fallback`, `no_plan`, `override`.

### 9.2 Pauze-API

- `POST /ev/pause` met `{ "minutes": 15 }` of `{ "until": "<ISO>" }` — EV pauzeert, plan blijft.
- `POST /ev/resume` — pauze opheffen.
- Bedoeld voor HA-automatiseringen (bv. extra pauze bij gekende piekbelasting).

### 9.3 Vangnet

- Krijgt de laadpaal-automatisering geen geldig antwoord (Optivolt of HA onbereikbaar), dan valt
  ze na **X minuten** (instelling, standaard 5) terug op een **terugvalstand**: *stoppen* of
  *minimumstroom*. Dit staat in de HA-automatisering; Optivolt levert een voorbeeld-blueprint.
- Optivolt zelf: plan verlopen of HA-sensoren ouder dan Y minuten → `reason: "fallback"` met de
  terugvalstand.

### 9.4 Fasen

| Instelling | Waarden |
|---|---|
| Fasen | `1` / `3` / `auto` |
| Spanning | 230 V |
| Min./max. stroom | 6 A / 16 A (bestaand) |
| Min. tijd tussen fasewissels | 10 min |

Bereik (230 V, 6–16 A): 1 fase 1,4–3,7 kW, 3 fasen 4,1–11 kW. In het gat 3,7–4,1 kW: 1 fase op
max. stroom.

Bij `auto`: naar 3 fasen als het toegelaten vermogen een paar minuten ≥ ±4,3 kW blijft; terug
naar 1 fase onder ±4,0 kW; nooit sneller dan de minimale wisseltijd. Planner en bewaker gebruiken
dezelfde bereiken, zodat er nooit een vermogen gepland wordt dat de paal niet kan leveren.

*Gebouwd (fase 4):*

- Direct laden: in de planner een `direct`-verzoek vanaf nu tot de auto vertrekt, vóór alle
  plannen in die tijd (die worden ingekort). `fixed` = gekozen stroom × spanning × fasen uit de
  goedkoopste bron; `fast_ess` = PV + wat de ESS boven de ondergrens kan leveren, daarna net op
  minimum of tot de piekgrens. "Piek negeren" heft enkel de piekgrens op, nooit `maxGridImport_W`.
  Zonder geldig plan antwoordt `/ev/current` meteen met de gekozen stroom.
- Vermogen van de lader = stroom × `evVoltage_V` × fasen (`api/services/ev-charger.ts`); bij
  `auto` plant de planner van het 1-fase-minimum tot het 3-fasen-maximum en kiest de bewaker.
- Fasewissel (`auto`): naar 3 fasen boven 105 % van het 3-fasen-minimum, na 2 min, terug onder
  97 %, nooit sneller dan `evPhaseSwitchMinInterval_m`, behalve wanneer 3 fasen niet kunnen
  draaien.
- `POST /ev/pause` (`{ minutes }` of `{ until }`) en `POST /ev/resume`, bewaard als
  `evPausedUntil` in `data.json`; knop "Pause 15 min" op de EV-tab.
- Vangnet: geen of verlopen plan → `evFallbackMode` met `fallback_active: true` en de reden
  (`no_plan`, `before_plan`, `expired_plan`). Voorbeeld-automatisering voor HA, met het vangnet
  aan HA-kant: [ev-charger-automation.md](ev-charger-automation.md).
- `/ev/current?peek=1` (het statusblok) verandert de bewaker niet en telt niet mee voor de
  gemeten oproepfrequentie.

### 9.5 Meldingen

Geen HA-notificaties (beslissing V6). Meldingen verschijnen enkel in Optivolt:

- als banner op de EV-tab,
- als lijst `warnings` in `/ev/current` en in het plan, zodat een HA-automatisering ze later
  zelf kan gebruiken als je dat ooit wil.

Wanneer:

- doel niet haalbaar (met reden en verwachte SoC),
- nieuwe maandpiek boven de doelgrens,
- vangnet actief,
- een gekozen sensor te lang niet bijgewerkt,
- `/ev/current` wordt te traag opgevraagd (§ 7.3).

## 10. Instellingen (overzicht)

| Groep | Instelling | Standaard | Nieuw? |
|---|---|---|---|
| Auto | capaciteit, max. SoC, laadrendement | bestaand | – |
| Auto | verbruik (kWh/100 km) | 18 | ✔ |
| Laadpaal | min./max. stroom | 6 / 16 A | – |
| Laadpaal | fasen (`1`/`3`/`auto`), spanning | 1, 230 V | ✔ |
| Laadpaal | min. tijd tussen fasewissels | 10 min | ✔ |
| Laadpaal | min. laadduur / min. pauze | 30 / 15 min | ✔ |
| ESS | vaste EV-ondergrens (%) | bestaand | – |
| ESS | marge dynamische ondergrens (kWh) | 0 | ✔ |
| Piek | minimumpiek (kW) | 2,5 | ✔ |
| Piek | marge (kW) | 0,2 | ✔ |
| Piek | gebruik betaalde piek | uit | ✔ |
| Vangnet | terugvalstand, timeout | minimumstroom, 5 min | ✔ |
| HA-sensoren | EV-SoC, stekker | bestaand | – |
| HA-sensoren | EV-kilometerstand (optioneel) | – | ✔ |
| HA-sensoren | maandpiek, live netvermogen, EV-vermogen | – | ✔ |
| HA-sensoren | netvermogen in/uit, PV-vermogen, batterijvermogen in/uit | – | ✔ |

## 11. Wat verdwijnt / blijft

| Onderdeel | Lot |
|---|---|
| `lib/ev-cheapest-source.ts` (greedy na de solve) | **verdwijnt** → vervangen door de regels van § 6 |
| EV-binaries in `build-lp.ts` (`ev_on`, `ev_grid_ok`, `ev_target_shortfall`) | **verdwijnen**; EV-stromen worden vaste invoer |
| `evWeeklyCheapestSource`, `evOverrideEnabled/Current_A` | **migreren** naar plantype *goedkoopste* resp. *direct laden* |
| `usage_percent` op trips | **migreert** naar km |
| `ev-trip-usage.ts` (verbruiksvoorspelling) | blijft |
| `price-forecast-service.ts`, `extendedHorizonDays` | blijft |
| `battery-energy-price.ts` | blijft als terugval (§ 5) |
| `socTargets` / ESS-doel per plan | blijft, wordt zacht tier 2 |
| Rebalance-planning | blijft ongewijzigd |
| DESS-mapping | blijft; EV-stromen komen uit de regels |

Upstream-PR's (#208–#213) blijven los hiervan; dit ontwerp is voor de fork.

## 12. Testscenario's

Vaste scenario's als JSON (invoer + verwachte eigenschappen), zoals evcc's `test_cases/`:

1. Avond 22:00, ESS 80 %, batterijprijs 15 ct, net 30 ct → EV uit ESS tot de ondergrens, dan
   stoppen / doorladen volgens instelling.
2. Idem, net daalt om 02:00 onder de ESS-kost → overschakelen naar net.
3. Middag goedkoper dan nacht → geen nachtladen van het net.
4. ESS-doel per plan: ESS wordt vooraf geladen enkel als dat na verliezen goedkoper is.
5. Doel-SoC niet haalbaar binnen de piekgrens → zo dicht mogelijk + melding.
6. Trip 120 km, 18 kWh/100 km → juiste benodigde SoC.
7. Oven tijdens EV-laden → bewaker verlaagt binnen één oproep, emmer niet overschreden.
8. Betaalde piek 3,2 kW, "gebruik betaalde piek" uit/aan → doelgrens 2,3 / 3,0 kW.
9. Fase-`auto` rond 4 kW → geen heen-en-weer schakelen.
10. Direct laden "snel vanaf ESS" → vermogen = vrij omvormervermogen.
11. Overlap direct + goedkoopste → goedkoopste opgeschort, niet verwijderd.
12. 6 dagen horizon → solve-tijd onder de limiet.
13. Sensor weg / plan verlopen → `fallback`.

Per scenario wordt nagekeken: kost, bron per kwartier, piek per kwartier, gemiste doelen.

## 13. Fasering

| Fase | Inhoud |
|---|---|
| 1 | Instellingen + datamodel plannen (+ migratie), HA-sensoren kiesbaar, testscenario-raamwerk |
| 2 | Batterijprijs uit HA (§ 5), dynamische ondergrens (§ 6.1) |
| 3 | LP: EV als vaste invoer, zachte tiers (§ 8.1), piek-doelgrens in de planner (§ 7.2), meldingen |
| 4 | Direct laden (§ 4.2) + bewaker (§ 7.3) + fasen (§ 9.4) + pauze-API + vangnet |
| 5 | Eenmalige plannen: doel-SoC, trip in km, vertrek/aankomst (§ 4.3–4.4) |
| 6 | Goedkoopste laden met voorspelling en ESS voorladen (§ 4.5) |
| 7 | UI: plannen, statusblok, opschonen oude code (§ 11) |

Elke fase: tests groen, eigen commit(s), uitrol naar HA pas na jouw akkoord.

## 14. Open vragen

| # | Vraag | Antwoord / voorstel |
|---|---|---|
| V1 | PV-energie in de ESS: aan 0 ct of aan de exportprijs? | **beslist: 0 ct** |
| V2 | Herlaadmoment uit het plan (eerste ESS-laadkwartier of PV dekt huis) — akkoord? | **beslist: ja** |
| V3 | Mag de bewaker boven het plan gaan bij onverwacht PV-overschot? | **beslist: ja, enkel met PV-overschot** |
| V4 | Welke HA-sensoren voor net→batterij en PV→batterij? | **beslist:** vermogenssensoren net in/uit, PV, batterij in/uit; splitsing berekend (§ 5) |
| V5 | Hoe vaak roept HA `/ev/current` op? | **onbekend** → Optivolt meet het en waarschuwt; voorbeeld-automatisering elke 15 s (§ 7.3) |
| V6 | Welke notify-service voor meldingen? | **beslist: geen**; meldingen enkel in Optivolt (§ 9.5) |
| V7 | Wintertoeslag op het verbruik nodig? | **beslist: nee** — de SoC-voorspelling weegt recente weken zwaarder en het tripverbruik wordt geleerd uit een kilometerstand-sensor (§ 4.4) |
