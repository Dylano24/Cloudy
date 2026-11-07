# Cloudy: opschoning zonder verlies — Implementation Plan

> Voor de uitvoerende bot: behandel dit als een onderzoek, specificatie en uitvoerplan. Implementeer per fase en controleer het resultaat voordat je doorgaat. Als de workflow beschikbaar is: gebruik `superpowers:executing-plans`. Er is in dit onderzoek geen productiecode gewijzigd, geen productiedata verwijderd en geen deployment gestart.

**Goal:** de Embed Builder bevat de huidige Cloudy-embeds, eigen berichten en bewaarde aanpassingen; ongebruikte, ongewijzigde oude bronvoorbeelden verdwijnen uit de Builder zonder eigen werk, berichten, instellingen of werkende functies te verliezen.

**Architecture:** één gedeelde toelatingsregel bepaalt welke items bij de Builder horen. Herkomst, bewezen bewerkingen, actuele functie en fysieke berichtidentiteit worden afzonderlijk beoordeeld. Begin met volledige export en omkeerbare archivering; verwijder uitsluitend aantoonbaar uitgefaseerde commandcode nadat afhankelijkheden en behoud zijn gecontroleerd.

**Tech Stack:** Node.js 24, ES modules, discord.js 14, PostgreSQL, bestaande Redis-caches, Railway, `node:test`.

**Spec:** de wens van Dylano onder §1; de huidige repositoryregels in `AGENTS.md`; de broninventaris en bewijsgegevens in `Cloudy_audit_inventaris.json`.

## Global Constraints

- Repository: `Dylano24/Cloudy`. Onderzochte commit: `0f41f9d6f8fece613a156b732b4e2e8a7e36e888`.
- Haal vóór implementatie opnieuw de actuele `main`, bestandsversies en Railway-status op. Bouw niet blind verder op deze momentopname.
- Bestaande Discord-embeds veranderen uitsluitend door een expliciete gebruikersactie of de specifiek gevraagde wijziging. Geen automatische tekst-, kleur-, logo-, footer- of mediamigratie.
- Eén fysiek embed heeft de identiteit `guildId + channelId + messageId + embedIndex`. Houd rekening met `backingChannelId` bij catalogusprojecties.
- Behoud `PRESERVE_EXISTING_EMBEDS = true`.
- Save werkt op hetzelfde bericht; Repost en Reappear behouden hun bestaande identiteits- en opvolgingsregels.
- De ZORP Guide, eigen Builder-posts, opgeslagen templates, custom emoji’s, banners/GIF’s, knoppen en links blijven intact.
- Gebruik geen Delete-, purge- of tombstone-operatie om een overbodig catalogusvoorbeeld alleen uit de Builder te halen.
- De bestaande Builderbediening, snelheid, modalvelden, spacing, kleuren, timerregels en mediaflow blijven behouden.
- Search toont zoals nu alleen de opgeslagen titel, inclusief letterlijke custom emoji’s. Voeg geen technische IDs, kanaalnamen, variantnummers of andere suffixen toe om classificatieproblemen te verbergen.
- Verander geen moderatiebevoegdheden, economie, giveaways, claims, tickets, muziek of gamefeeds onder het mom van opruimen.
- Een kort test- of logvenster zonder activiteit bewijst niet dat een functie ongebruikt is.
- Dit document bereidt werk voor de andere bot voor. Het is geen melding dat de problemen al zijn opgelost. Laat een deployment afhangen van de expliciete live-opdracht aan de uitvoerende bot.

## Review Focus

1. Een oud item met alleen een logo-, kleur-, footer-, media- of knopaanpassing moet als eigen werk behouden blijven.
2. Twee verschillende functies met dezelfde titel mogen elkaar niet toelaten, verbergen, overschrijven of verwijderen.
3. Een fout bij PostgreSQL of Discord mag nooit worden behandeld als bewijs dat eigen data of een bericht niet bestaat.
4. Een late history-scan, restart of catalogusrefresh mag een verwijderd/gearchiveerd oud voorbeeld niet terugbrengen of een recente Save terugdraaien.
5. Een rollback mag geen nieuwe wijzigingen, tickets, deelnemers, claims of economiehandelingen terugzetten naar een oude databasekopie.

---

## 1. Wat Dylano precies wil

Beoordeel oude broncode op actuele functie en eigen bewerkingen. De concrete opdracht is:

- Haal ongebruikte, ongewijzigde oude voorbeelden en templates uit de Embed Builder.
- Behoud alles wat Dylano zelf heeft gemaakt, expliciet opgeslagen, aangepast of voor Cloudy heeft laten aanpassen.
- Behoud een aangepaste oude template ook wanneer de oorspronkelijke functie niet meer wordt gebruikt.
- Behoud de huidige Cloudy-functies en hun benodigde meldingen.
- Laat oude technische catalogusvoorbeelden niet terugkomen via Search, Modify, history, runtime-capture of een restart.
- Maak dit structureel goed; alleen de zichtbare zoeklijst filteren is onvoldoende.

Een titel, Cloudy-logo, witte zijlijn, timestamp of `manualSaved`-vlag alleen bewijst geen bewuste gebruikersbewerking. Omgekeerd bewijst het ontbreken van een moderne vlag niet dat een oud item ongewijzigd is.

## 2. Wat daadwerkelijk is onderzocht

| Onderdeel | Vastgesteld |
|---|---|
| GitHub-bron | De hierboven genoemde `main`-commit is lokaal onderzocht. |
| Railway | De laatst opgevraagde Cloudy-deployment was `SUCCESS` en gebruikte dezelfde commit. Deployment-ID: `f8021e68-dcae-4daa-beb2-b372f20083da`. |
| Commandloader | In een geïsoleerde kopie uitgevoerd: 97 unieke routes, bestaande uit **96 slashcommands en 1 contextmenuactie** (`Cloudy report`). |
| Brondiscovery | De echte `discoverEmbedDefinitions()` uitgevoerd: **608 definities**, waarvan **498 embeds en 110 tekstreacties**. |
| Catalogusopbouw | De opbouw sluit curated casino-contexten uit de statische lijst uit; 608 gevonden definities worden daarmee 606 brondefinities in die opbouw. Dit sluit aan op de ingeziene runtime-logregel. |
| Uitgefaseerde bronbestanden | **20 gevonden embeddefinities** komen uit 12 commandbestanden die de commandloader al overslaat. |
| Bestaande tests | **117 tests geslaagd**, verdeeld over 19 gerichte bestaande testbestanden. |
| Diagnostische probes | **7 scenario’s gereproduceerd**: 1 controle en 6 tekortkomingen/verschillen. De probes bevestigen huidig gedrag; dit zijn geen uitgevoerde fixes. |
| Productiewijzigingen | Geen codepush, databasebewerking, Discord-bewerking of deployment uitgevoerd. |

De volledige lijst met de 97 routes en alle 608 definities staat in het JSON-bestand. De classificatie daar gaat over bronbestanden, niet over bewezen bezit of gebruik van afzonderlijke productie-embeds.

### Grenzen van deze momentopname

Er is geen volledige ruwe productie-export van alle embed-, template-, media- en configuratiedata gemaakt. Daardoor zijn de exacte aantallen eigen, gemodificeerde, ongebruikte en verweesde productie-items nog niet vastgesteld. De uitvoerende bot moet die export en vergelijking doen voordat hij een opruiming toepast.

Een opgevraagde zoekactie in de gebruikslogs leverde geen betrouwbare commandtellingen op. Die uitkomst is niet gebruikt als bewijs dat commands ongebruikt zijn. Er is geen live Discord-login of volledige gebruikerstest uitgevoerd. De lokale tests werken met mocks en fixtures.

## 3. De huidige keten

1. `embedDefinitionDiscoveryService.js` doorzoekt breed de JavaScript-bestanden onder `src`, met enkele technische uitzonderingen.
2. De scanner herkent embedconstructies, helperaanroepen en bepaalde tekstreacties. Hij kent niet automatisch de actuele commandregistratie of bewuste Cloudy-keuzes.
3. `systemEmbedCatalogService.js` bouwt hiervan catalogusberichten, bewaart bronaliassen en vult runtime-templatecaches.
4. `embedRegistryService.js` bewaart fysieke berichten, catalogusprojecties, eigen posts en opgeslagen records.
5. `embedTemplateService.js` bewaart de eigen templatebewerkingen op globale en kanaalscope.
6. De Search-patch mengt registry-, canonieke en catalogusrecords en past daarna zichtbaarheid toe.
7. Kanaalselectie/Modify heeft daarnaast eigen fysieke discovery en browserroutes.
8. History-, recovery-, gateway- en startup-processen kunnen opnieuw records toevoegen of opruimen.

Een sluitende oplossing moet deze grenzen samen behandelen. Het mag de runtime-rendering of opgeslagen bewerkingen niet verwijderen om een lijst schoner te maken.

## 4. Concrete bevindingen en hun gevolg

### F1 — De scanner vindt nog templates uit uitgefaseerde commands

**Bevestigd door uitvoering.** De commandloader en registratiescript slaan oude routes over, maar de brondiscovery doet diezelfde uitsluiting niet.

De 20 gevonden definities uit die bestanden zijn:

| Bestand | Definities |
|---|---:|
| `src/commands/Economy/fish.js` | 1 |
| `src/commands/Economy/mine.js` | 1 |
| `src/commands/Fun/count.js` | 6 |
| `src/commands/Fun/fight.js` | 3 |
| `src/commands/Fun/flip.js` | 1 |
| `src/commands/Fun/roll.js` | 1 |
| `src/commands/Giveaway/gdelete.js` | 1 |
| `src/commands/Giveaway/gend.js` | 1 |
| `src/commands/Giveaway/greroll.js` | 1 |
| `src/commands/Economy/gamble.js` | 4 |
| `src/commands/Giveaway/gcreate.js` | 0 |
| `src/commands/Economy/slots.js` | 0 |
| **Totaal** | **20** |

Voorbeelden: Fishing Success, Mining Expedition Successful, Counting Game Status, Duel Complete, Heads or Tails, oude You Won/You Lost-varianten.

**Nodig:** stop de automatische opname van deze ongewijzigde oude bronvoorbeelden. Exporteer en bescherm eerst eventuele eigen bewerkingen van dezelfde families. Het cijfer 20 is geen aantal te verwijderen Discord-berichten.

### F2 — “Ooit verstuurd” is de huidige regel, niet “eigen of bewust aangepast”

**Bevestigd door bron en probe.** `markBuilderCatalogUsed()` bewaart dat een sleutel ooit is verstuurd. `isUnusedBuilderCatalogRecord()` gebruikt die historische set. Die regel controleert niet of de functie nu actief is of de inhoud door Dylano is aangepast.

**Gevolg:** een ongewijzigde oude functie kan zichtbaar blijven na één historisch gebruik.

**Nodig:** behandel gebruik als ondersteunend signaal, niet als eigendomsbewijs of permanente toelating.

### F3 — Verwijderen van de bron kan het oude catalogusitem juist weer toelaten

**Lokaal gereproduceerd.** De huidige ongebruikt-filter geldt alleen voor sleutels in `codeDiscoveredCatalogKeys`. Een oud opgeslagen catalogusitem waarvan de bron niet meer in de huidige discovery zit, valt buiten die controle.

**Nodig:** een blijvende beslissing per stabiele identiteit, óók wanneer bronbestanden verdwijnen, een sleutel verandert of een oudere catalogus opnieuw wordt geladen. Dit moet worden opgelost vóór het verwijderen van de 12 bestanden.

### F4 — Tekstreacties vallen buiten de nieuwe ongebruikt-set

**Bevestigd door bron en probe.** `rememberCodeDiscoveredCatalogKeys()` slaat `kind: 'content'` over. De scanner vindt 110 tekstreacties. Andere weergavefilters kunnen bepaalde onbruikbare labels verbergen, maar dat is geen algemene herkomst- of gebruikscontrole.

**Nodig:** dezelfde toelatingsbeslissing voor embed- én teksttemplates. Alle 110 reacties beoordelen; niet aannemen dat ze allemaal fout of ongebruikt zijn.

### F5 — `manualSaved` alleen is onvoldoende bewijs

**Bevestigd door bron en probe.** De ongebruikt-filter stelt ieder catalogusrecord met `manualSaved: true` vrij. Andere code en tests erkennen dat oude automatisch uitgezonden records zo’n vlag kunnen hebben.

Ook `source: 'embed-builder'` alleen is onvoldoende: `embedMissingChannelService.buildRecords()` gebruikt die source voor bepaalde markerloze fysieke discoveryrecords die nog geen bewuste Save hebben.

**Nodig:** combineer bron, Builder-marker, expliciete Save, opgeslagen overlay en historische bewerkingsinformatie. Bij twijfel eerst behouden en laten beoordelen.

### F6 — Een gelijke titel kan een andere familie zichtbaar houden

**Lokaal gereproduceerd.** `mergeSearchRecords()` maakt een set geposte titels; `isUnusedBuilderSearchRecord()` kan op basis van die titel een catalogusrecord toelaten. Daarbij is niet dezelfde stabiele familie vereist.

**Nodig:** vergelijk `guild + context + templateKey` of de exacte fysieke identiteit. Gebruik titels uitsluitend als weergavenaam. Geen bulkverwijdering of samenvoeging op titel.

### F7 — Bij ontbrekende gebruiksinformatie wordt nu alles getoond

**Bevestigd door bestaande test.** `ensureUsedBuilderCatalogLoaded()` en `embedBuilderSearchUsedOnly.test.js` bevatten bewust de regel dat een databasefout geen entries mag verbergen en Search dan alles laat zien.

Dat voorkomt dat eigen werk onterecht verdwijnt, maar voldoet niet aan de nieuwe wens dat oude voorbeelden niet terugkomen.

**Nodig:** een laatst betrouwbaar vastgestelde selectie behouden. Bij een koude start zonder betrouwbare informatie uitsluitend bewezen eigen/goedgekeurde items tonen; onzekere data behouden voor herstel/beoordeling. Geen destructieve opruiming op basis van een fout of leeg fallbackresultaat. Dit is een bewuste wijziging van het oude contract en de bijbehorende test.

### F8 — Alleen Search aanpassen dekt Modify en kanaaldiscovery niet

**Vastgesteld in de bron; nog geen volledige live doorloop gedaan.** Kanaalbrowser, fysieke discovery, canonieke records, directe selectie en cached autocomplete gebruiken verschillende invoerroutes.

**Nodig:** dezelfde selectie toepassen bij Search, Modify, kanaallijsten, directe aangeboden selectie en catalogusprojecties. Dit mag een rechtmatige fysieke post of opgeslagen bewerking niet uitwissen.

### F9 — Filteren in Search voorkomt het aanmaken van oude catalogusvoorbeelden niet

**Vastgesteld in de bron.** `buildSystemEmbedCatalogs()` en `flushPendingTemplates()` kunnen nog bronvoorbeelden materialiseren, ook wanneer een latere zoekfilter ze verbergt. `captureSystemEmbedData()` kan nieuwe varianten leren.

**Nodig:** de toelatingsregel ook vóór het aanmaken of aanvullen van catalogusentries toepassen. Runtime-aliassen en aangepaste overlays blijven afzonderlijk beschikbaar waar echte functies die nodig hebben.

### F10 — Er is al een recente bescherming tegen de codekopie in echte berichten

**Bestaande tests slagen.** `loadRecordSnapshotIntoState()` onderscheidt echte fysieke berichten van catalogusvoorbeelden. Een echte welcome-post opent met zijn eigen velden, afbeelding, logo, footer en kleur, niet met `{dynamic}`-waarden uit de codekopie.

**Nodig:** dit gedrag behouden. Het is geen reden om de hele Builder, broncache of previewlogica te herschrijven. Een bewust door de gebruiker getypte variabele mag evenmin blind met een regex worden gewist.

### F11 — Het huidige auditbestand is geen volledige back-up van de Builder

**Vastgesteld in de bron.** `scripts/embed-registry-audit.js` exporteert de registry, verwijdertombstones, globale templates en Reappear-data voor kanalen uit de registry.

Het exporteert niet aantoonbaar alle kanaalspecifieke templates, catalogus-ID’s, verborgen/gebruikt-sets, bronbaselines, orphan-indexen, knopacties, mediabestanden en overige samenhangende configuratie.

Bovendien roept het `initializeDatabase()` aan. De gedeelde PostgreSQL-initialisatie kan tabellen/indexen/triggers en migratie-informatie schrijven. De scriptcomment “read-only” bewijst daardoor niet dat de hele initialisatie read-only is.

**Nodig:** voor deze opruiming een complete export via een werkelijk alleen-lezen verbinding/transactie maken, buiten de normale auto-initialisatie. Controleer herstel in een geïsoleerde database. Gebruik een beperkte bestaande audit niet als enige herstelbasis.

### F12 — Automatische orphan-opruiming beschermt bewerkte catalogusrecords niet expliciet

**Vastgesteld in de bron; geen verlies in productie vastgesteld.** `gamingCatalogDiagnosticReady.js` verwijdert registryrecords met `source: 'system-catalog'` wanneer hun bericht-ID niet in de catalogus-ID-lijst staat. Deze selectie controleert geen eigen Save/overlay en schrijft de hele registry rechtstreeks via `setInDb` terug.

Daarbij kan `loadCatalogMessages()` na een mislukte of gedeeltelijke history-fetch een onvolledige lijst teruggeven. Dit is een reden om afhankelijkheid van alleen een ID-lijst extra te controleren, geen bewijs dat dit incident al heeft plaatsgevonden.

**Nodig:** geen orphan-delete zonder positieve volledigheidscontrole en bescherming van bewerkingen. Gebruik de bestaande registry-mutatieserialisatie, commitpublicatie en generatieverhoging. Voorkom dat een oude volledige lijst een gelijktijdige Save overschrijft. `PRESERVE_EXISTING_EMBEDS` beschermt deze aparte schrijfroute niet automatisch.

### F13 — Help adverteert nog commands die niet geladen worden

**Lokaal gereproduceerd voor beheerderweergave.** Help leest commandbestanden opnieuw uit de mappen in plaats van uitsluitend de geladen registry te gebruiken. De categorieën Giveaway, Economy en Fun tonen nog respectievelijk `/gdelete`, `/fish` en `/flip`.

**Nodig:** Help en commandoverzichten op dezelfde actuele commandregistry/toegangsregels baseren. Normaliseer categorieën; voorkom technische mappen zoals `00Overrides`, uitgefaseerde routes en dubbele implementaties. Controleer bij commandmentions de daadwerkelijk gebruikte guildregistratie.

### F14 — Een uitgezet slashcommand betekent niet dat alle achterliggende code ongebruikt is

**Voorbeelden uit de bron:**

- `/count` wordt niet geregistreerd, maar `messageCreate.js` roept nog `handleCountingGame()` aan. Een opgeslagen countingconfig kan dus effect hebben.
- Oude giveawayknoppen worden nog opgevangen. Het verwijderen van losse `/gend`-bestanden is geen toestemming om gedeelde giveawayservices of compatibiliteitsknoppen te verwijderen.
- `00Overrides/jointocreate.js` importeert en gebruikt de oorspronkelijke Join to Create-implementatie. Die basisfile is geen veilige “duplicate delete”.
- `autoverify.js` is een re-export. Een klein bestand zonder eigen commandbuilder kan toch een geregistreerd command opleveren.
- De twee Builder-patchbestanden met `00_` en `zz_` zijn actieve infrastructuur, geen overbodige slashcommands.
- De vijf levelingcommands worden geladen. De statische featureflag is momenteel `false`. Er bestaat een herstelservice die die flag kan aanzetten, maar er is in `src`/`scripts` geen productieaanroep van die service gevonden. Beoordeel configuratie en data; verwijder geen XP, ranks of role rewards op basis van alleen een naam of statische vlag.

## 5. Commands: concrete indeling

### 5.1 Uitgefaseerde commandbestanden, na bescherming en referentiecontrole te verwijderen

```text
src/commands/Economy/fish.js
src/commands/Economy/mine.js
src/commands/Economy/slots.js
src/commands/Economy/gamble.js
src/commands/Fun/count.js
src/commands/Fun/fight.js
src/commands/Fun/flip.js
src/commands/Fun/roll.js
src/commands/Giveaway/gcreate.js
src/commands/Giveaway/gend.js
src/commands/Giveaway/gdelete.js
src/commands/Giveaway/greroll.js
```

Behoud de huidige `/gamble` in `src/commands/Economy/gambling.js`, `/game` in `games.js` en `/giveaway create|manage` in `Giveaway/giveaway.js`.

De retired-set noemt ook `slut`; daarvoor bestaat op deze baseline geen commandbestand meer. Oude namen zoals `poll`, `mapvote`, `endvote` en `votemanage` zijn geen aanleiding om de huidige `/vote start|manage` of oude geposte stemmen te verwijderen.

De volgende tests importeren nog uitgefaseerde bestanden en moeten gericht worden gemigreerd als die bestanden verdwijnen:

| Testbestand | Belangrijk bij migratie |
|---|---|
| `test/giveawayRebuild.test.js` | Verplaats relevante buildercontrole naar de actuele `/giveaway create`-route. |
| `test/commercialGiveawayPersistence.test.js` | Behoud controles op persistence bij End/Delete/Reroll via huidige services en Manage. |
| `test/fishAndMineAtomic.test.js` | Alleen verwijderen/archiveren als die functies werkelijk uitgefaseerd blijven; geen economische opslag wissen. |
| `test/dedicatedChannels.test.js` | Behoud kanaalrestrictietests voor de huidige casino- en economiecommands. |
| `test/gambleAndAdminGiveAtomic.test.js` | Het bestand bevat ook controles voor het actieve geldgeven; niet het hele bestand weggooien. |
| `test/cleanedCommandImportsSmoke.test.js` | Werk de importlijst bij; geen gebroken imports achterlaten. |

### 5.2 Nog geladen: beoordelen, niet automatisch verwijderen

| Commands/functie | Advies |
|---|---|
| `/support` | Bevat een vaste invite `QnWNz2dKCE` en generieke tekst om die link te wijzigen. Verifiëren welke bestemming bij Cloudy hoort; aanpassen of op expliciete keuze uitfaseren. De eigenaar van de invite is niet vastgesteld. |
| `/baseconvert`, `/generatepassword`, `/shorten`, `/unixtime` | Optionele hulpmiddelen. Standaardbronvoorbeelden horen niet automatisch bij de Builder; commandverwijdering is een aparte keuze. |
| `/weather`, `/todo`, `/search`, `/birthday` | Geen betrouwbare gebruiksmeting beschikbaar. Behoud bestaande data en aangepaste templates. |
| `/level`, `/leveladd`, `/levelremove`, `/levelset`, `/rank` | Geregistreerd maar statisch uitgeschakelde feature. Eerst actuele behoefte, configuratie en opgeslagen voortgang beoordelen. |
| `/welcome setup`, `/goodbye setup`, `/greet dashboard` | Overlap in beheer, maar setup en dashboard zijn verschillende toegangspaden. Niet blind samenvoegen of de echte welcome/goodbye-events verwijderen. |
| `/stats`, `/uptime`, `/ping` | Diagnosecommands; geen bewijs dat ze ongebruikt zijn. |
| `/join`, `/play`, `/queue`, `/nowplaying`, `/music` | Verschillende muziekhandelingen; de losse commands zijn niet allemaal duplicaten van `/music`. |
| `/verification`, `/autoverify`, `/autorole`, `/verify` | Verschillende verificatie-/rolflows. Eerst configuratie en actieve panelen controleren. |
| `/reactroles`, `/serverstats`, `/apply`, `/app-admin` | Optionele bestaande functies met mogelijke opgeslagen instellingen. Niet verwijderen op basis van dit onderzoek. |

Oude prefixaliassen naar `flip`/`roll`/`fight` zijn aanvullende opruimkandidaten. Controleer subcommandaliassen afzonderlijk: `roll -> reroll` is iets anders. De alias `give -> pay` heeft bovendien een andere betekenis dan het huidige slashcommand `/give money`; wijzig die semantiek niet stilzwijgend tijdens cataloguswerk.

## 6. De nieuwe toelatingsregel

Leg per item vier verschillende feiten vast:

1. **Identiteit:** welke templatefamilie of welk exact fysiek embed is dit?
2. **Herkomst:** eigenaar, bewust aangepaste Cloudy-code, upstream of onbekend?
3. **Bewerking:** is er bewijs van een bewuste Save, Post of inhoudelijke/visuele wijziging?
4. **Functiestatus:** actief/goedgekeurd, uitgefaseerd, uitgeschakeld of onbekend?

### Gewenste beslissingen

| Item | Builder | Opslag/runtime |
|---|---|---|
| Bewezen eigen Builder-post | Tonen | Identiteit, snapshot, knoppen en media behouden. |
| Bewust opgeslagen aangepaste template, ook van oude functie | Tonen | Eigen versie en benodigde aliassen behouden. |
| In code aantoonbaar voor Cloudy aangepaste huidige template | Tonen | Alleen de goedgekeurde versie gebruiken; geen oud origineel ernaast. |
| Benodigde huidige Cloudy-melding, ticketmaster of botfunctie | Eén goedgekeurde familie tonen waar bewerkbaar nodig | Runtime blijft werken. |
| Ongewijzigd oud bronvoorbeeld van uitgefaseerd command | Niet in de Builder opnemen | Omkeerbaar archiveren; daarna niet opnieuw aanmaken. |
| Ongewijzigd, ongebruikt optioneel upstreamvoorbeeld | Niet standaard opnemen | Actieve commandfunctionaliteit niet automatisch verwijderen. |
| Twee verschillende eigen embeds met dezelfde titel | Beide bewaren en correct kunnen selecteren | Geen identiteitsmerge op titel. |
| Historische runtimekopieën | Geen aparte template per gebeurtenis | Originele log-/berichtgeschiedenis behouden. |
| Ambigue herkomst of onvolledige gegevens | Eerst review, geen automatische vernietiging | Origineel volledig bewaren; rapporteren wat nog onbekend is. |
| Expliciet eerder verwijderd of beleidsmatig gearchiveerd item | Niet terugbrengen | Respecteer tombstone of aparte archiefbeslissing, afhankelijk van het type handeling. |

### Bewijs van eigen werk

- Een echte Builder-marker plus bijpassende Post-/Save-registratie.
- `explicitSave: true` in de juiste fysieke context.
- Een opgeslagen globale of kanaalspecifieke template-overlay met passende canonical identity, inclusief alleen kleur/logo/footer/mediawijzigingen.
- Bewuste `modified`/`modified-template`-geschiedenis, gekoppeld aan de juiste familie en opslagversie.
- Een aantoonbare wijziging van die template in git op verzoek van Dylano, met bronlocatie en voor/na-vergelijking.
- Oud opgeslagen materiaal zonder moderne vlag: behouden totdat de historie en overlays zijn onderzocht.

Automatische branding, veranderende aantallen, gebruikersnamen, tijden of gegenereerde voorbeeldvelden zijn geen eigendomsbewijs. Vergelijking uitsluitend met de huidige bron is onveilig: oude bronversies en normalisatielagen kunnen eveneens verschillen verklaren.

### Omgaan met twijfel

Maak een reviewlijst met oorspronkelijke records, redenen en herstelverwijzing. De eerste dry-run verandert niets. Een item krijgt pas een definitieve show/archive-beslissing na bewijs. Een onzekere entry is nooit een automatische delete-kandidaat. Claim pas een volledig opgeschoonde selectie wanneer de onzekere gevallen zijn opgelost of veilig en aantoonbaar herstelbaar zijn ondergebracht.

## 7. Verplichte export vóór enige opruiming

Maak een consistente PostgreSQL-snapshot en een volledige embedgerichte export. Bewaar alle oorspronkelijke JSON-waarden, fysieke IDs, metadata, aliassen en versies. Lees ruwe opslag, niet uitsluitend normaliserende registryviews die al filters toepassen.

Minimaal omvat dit voor iedere betrokken guild:

```text
cloudy:embed-registry:<guild>
cloudy:embed-registry-deleted:<guild>
cloudy:embed-template:<guild>:__global__
cloudy:embed-template:<guild>:<alle kanaalscopes>
cloudy:system-embed-catalog:<guild>
cloudy:system-embed-source-baseline:<guild>
cloudy:embed-builder-hidden-catalog:<guild>
cloudy:embed-builder-used-catalog:<guild>
cloudy:embed-reappear-index:<guild>:<channel>
cloudy:embed-reappear:<guild>:<channel>:<origin>
cloudy:embed-reappear-disabled:<guild>:<channel>:<origin>:<embedIndex>
cloudy:builder-button-action:<guild>:<actionId>
guild:<guild>:config
```

Dit is een minimale lijst, geen bewijs dat er verder geen afhankelijke keys bestaan. Enumeratie moet ook entries vinden die niet meer via de huidige registry worden verwezen. Neem benodigde recovery-/indexmetadata mee. Inspecteer de werkelijke opslagrouting en schema’s; neem niet aan dat alles in één KV-tabel staat. Bewaar relevante Redis-data alleen voor zover die niet uit de primaire opslag kan worden opgebouwd; gebruik Redis niet als enige back-up.

Neem daarnaast op:

- De ruwe echte Discord-berichten waar custom catalogusbewerkingen in kunnen staan: alle embeds per message, componenten, attachments, content en locatie.
- De mediabestanden op de volume achter `CLOUDY_EMBED_MEDIA_DIR`, met hashes. Alleen een URL opslaan bewijst niet dat een banner/GIF herstelbaar is.
- Alle referenties uit templates én het archief; geen media garbage collection tijdens deze taak.
- Codecommit, schema-/configversies en catalogus-ID-lijsten.
- Een wijzigingsjournaal met vóór/na-hashes en versies per daadwerkelijk aangepast document.

Gebruik een afzonderlijke read-only verbinding/transactie. Controleer dat een mislukte verbinding niet in een lege memoryfallback verandert. Een lege of gedeeltelijke export is een fout, geen geldige “niets gevonden”-uitslag.

Test herstel in een geïsoleerde omgeving zonder Discord-token en zonder de bot tegen productiedata te starten. De bestaande `backup.js` en `restore-drill.js` kunnen onderdelen ondersteunen, maar moeten op de doelomgeving worden gecontroleerd; de beperkte embed-audit is op zichzelf onvoldoende.

## 8. Bestanden en verantwoordelijkheden voor de implementatie

De eerste drie bestanden hieronder zijn **voorgestelde nieuwe bestanden**, niet bestaande API’s:

| Bestand | Verantwoordelijkheid |
|---|---|
| `src/services/builderCatalogPolicy.js` — nieuw | Zuivere classificatie van tonen, archiveren of review op basis van expliciet bewijs. |
| `src/config/builderCatalogManifest.js` — nieuw | Bewuste Cloudy-functies, bronfamilies, uitgefaseerde bestanden en herkomstbeslissingen. Geen brede “alles onder src is goed”-regel. |
| `scripts/builder-catalog-audit.js` — nieuw | Strikt read-only export/dry-run, tellingen, referenties en herstelcontrole. |
| `src/services/embedDefinitionDiscoveryService.js` | Behoud noodzakelijke brondiscovery, maar geef herleidbare broninformatie door en scheid die van opname in de Builder. |
| `src/services/systemEmbedCatalogService.js` | Pas beleid toe vóór materialisatie, runtime-append, searchable-record-publicatie en herladen van oude catalogusitems. |
| `src/commands/Tools/zz_embedbuilderLiveSearchPatch.js` | Eén selectieregel voor fast/cold/cached Search en selectie; geen titel-only uitzonderingen. |
| `src/services/embedManagerService.js` | Dezelfde beslissing voor canonical browser/Modify; behoud fysieke preview en Savegedrag. |
| `src/services/embedMissingChannelService.js` | Fysieke discovery correct als observatie classificeren; niet als bewijs van een eigen Post. |
| `src/services/embedRegistryService.js` | Bestaande mutatieserialisatie, autoritatieve snapshots, tombstones en generatiepublicatie behouden. |
| `src/services/embedTemplateService.js` | Opgeslagen overlays beschermen; runtime-toepassing onafhankelijk houden van Builderzichtbaarheid. |
| `src/events/gamingCatalogDiagnosticReady.js` | Orphan-opruiming begrenzen en veilig laten samenwerken met registrywrites en beschermde templates. |
| `src/commands/Core/help.js` en `src/handlers/help/helpSelectMenus.js` | Werkelijke geladen routes tonen in plaats van commandbestanden opnieuw te importeren. |
| `src/handlers/loaders/commandLoader.js` en `scripts/register-cloudy-guild-commands.js` | Registratie consistent houden; geen tweede sync of onbedoelde nieuwe commands. |

Dit is geen uitnodiging voor een grote refactor. Hergebruik bestaande services en caches. De twee grote Builderbestanden hoeven niet volledig te worden herschreven.

### Voorgestelde kerninterface

```js
classifyBuilderRecord(record, evidence)
// => {
//   identity: string,
//   decision: 'show' | 'archive' | 'review',
//   reasons: string[],
//   ownerModified: true | false | null,
//   featureState: 'active' | 'retired' | 'disabled' | 'unknown'
// }
```

`record` is een bestaand registry-/catalogusrecord. `evidence` bevat de betrouwbare command-/functiestatus, bronfamilie, bewezen eigen bewerking en bestaande beleidsbeslissing. De functie doet geen Discord-, database- of filesystem-I/O.

Gebruik voor families een guildgebonden identiteit op basis van stabiele key en context; voor fysieke posts de echte fysieke identiteit. Bewaar oude aliasverwijzingen zonder ze als extra zichtbare items te presenteren. Nieuwe metadata mag legacyrecords niet ongeldig maken. Een record dat geen bewijs heeft blijft `review`, niet impliciet `archive` of `delete`.

Voeg geen keuze voor willekeurige “30 dagen niet gebruikt = verwijderen” toe. Deze wens geeft geen bewaartermijn voor eigen templates. Een nieuw goedgekeurd Cloudy-onderdeel moet zonder brede src-scan via zijn expliciete manifestregistratie beschikbaar kunnen worden; leg bij zo’n toevoeging meteen de herkomst en juiste familiesleutel vast.

Een policywijziging moet de bestaande Search-cachegeneratie/revisie onmiddellijk ongeldig maken. De gebruikte cache-entry heeft zowel registrygeneratie, catalogusrevisie als beleidsrevisie nodig, of een aantoonbaar gelijkwaardige gecombineerde revisie. Doe geen netwerk- of databasewerk per toetsaanslag.

## 9. Uitvoerplan voor de andere bot

### Fase A — Baseline en volledige veilige inventaris

- [ ] Lees actuele `AGENTS.md`, `main`, deployment en relevante monitoringcontext.
- [ ] Maak een schone branch of geïsoleerde checkout; respecteer bestaande gebruikerswijzigingen.
- [ ] Maak de volledige export uit §7 met aantoonbaar read-only initialisatie.
- [ ] Leg per record de fysieke identiteit, familiesleutel, source, Savegegevens, overlays, media, componenten en referenties vast.
- [ ] Produceer tellingen `show / archive / review`, plus uitleg per kandidaat. Vergelijk aantallen en hashes met de export.
- [ ] Controleer restore van een representatieve eigen post, een aangepaste oude template, een kanaaloverlay en een GIF in een testomgeving.

**Resultaat:** een volledige, herhaalbare inventaris en herstelbasis. Nog geen productiedata of Discord-berichten opruimen.

### Fase B — Gedeelde selectie implementeren

- [ ] Voeg `test/builderCatalogPolicy.test.js` toe voor de matrix uit §6 en randgevallen uit §10.
- [ ] Laat tests falen op het huidige gedrag: verdwenen bron, kind content, titelbotsing, onbetrouwbare Savevlag en historisch gebruik.
- [ ] Implementeer `classifyBuilderRecord(record, evidence)` en een expliciet manifest.
- [ ] Voeg duurzame, versiegebonden show/archive-beslissingen toe; een verdwenen bron mag de beslissing niet resetten.
- [ ] Bescherm eigen werk voordat retired-/upstreamregels worden toegepast.
- [ ] Houd ambigue gevallen apart en geef nooit een destructieve beslissing terug.
- [ ] Laat de policytests slagen.

**Resultaat:** een geteste beslisregel, onafhankelijk van Discordweergave en runtime-templates.

### Fase C — Alle Builderroutes en cataloguswriters aansluiten

- [ ] Voeg `test/builderCatalogPolicyRoutes.test.js` toe voor fast/cold/cached autocomplete, Searchselectie, Modify en kanaaldiscovery.
- [ ] Voeg `test/builderCatalogNoResurrection.test.js` toe voor restart, weggevallen bron, runtime-capture, late history en veranderende canonieke records.
- [ ] Pas dezelfde policy toe vóór `appendCatalogEntry`, in `flushPendingTemplates` en bij herladen/publicatie van bestaande catalogusrecords.
- [ ] Behoud runtime-aliassen en bewerkte templates zonder ze allemaal als Builderitems aan te bieden.
- [ ] Vervang de titel-only uitzondering door familie-/identiteitsbewijs.
- [ ] Controleer aangeboden selecties opnieuw op rechten en actuele policy; ook een oude gecachte selectie mag de policy niet omzeilen.
- [ ] Behoud een betrouwbare selectie bij fouten; wijzig de oude “databasefout toont alles”-test gericht naar het nieuwe contract.
- [ ] Verhoog cachegeneraties/revisies direct na eigen Save en policycommit. Behoud de huidige directe vindbaarheid van hernoemde titels.
- [ ] Controleer dat het aantal nieuwe oude-codecatalogusentries na een tweede start nul is.

**Resultaat:** de Builder blijft schoon in alle toegangspaden, zonder aanpassingen aan bestaande posts.

### Fase D — Bewaar-/opruimroutes veilig maken

- [ ] Voeg `test/builderCatalogArchivePersistence.test.js` toe: ongewijzigde oude entries worden alleen logisch gearchiveerd; aangepaste entries blijven bewerkbaar.
- [ ] Test meerdere embeds in één catalogusbericht: een oud voorbeeld verbergen mag de andere aangepaste embeds niet meenemen.
- [ ] Test orphan-opruiming met `manualSaved`, overlays, gedeeltelijke catalogus-ID-lijsten en gelijktijdige Save.
- [ ] Laat alle registrywrites de bestaande serialisatie en commitpublicatie gebruiken; geen rechtstreekse complete-lijstoverschrijving van een oude snapshot.
- [ ] Maak archivering idempotent en herleidbaar met vóór/na-versie en reden.
- [ ] Behoud oorspronkelijke IDs en opgeslagen templates. Verwijder in deze taak geen fysieke Discord-catalogusberichten om ruimte te winnen.

**Resultaat:** de selectie verandert zonder dat eigen inhoud of berichtidentiteit verloren gaat. Fysieke Discord-verwijdering is niet volledig omkeerbaar: een opnieuw gepost bericht krijgt een ander ID.

### Fase E — Aantoonbaar uitgefaseerde broncode en overzichten opruimen

- [ ] Controleer opnieuw alle imports, dynamic directory-loaders, tests en gedeelde services van de 12 bestanden.
- [ ] Migreer de testverwijzingen uit §5.1 naar huidige routes waar hun businesscontrole nog relevant is.
- [ ] Verwijder de 12 uitgefaseerde commandbestanden pas nadat de selectie en archivering niet meer van hun aanwezigheid afhankelijk zijn.
- [ ] Behoud onderliggende countingconfig/gegevens en giveawaycompatibiliteit. Verwijder een eventservice alleen met een aparte, bewezen beslissing over actief gebruik.
- [ ] Werk dode commandaliassen en gedocumenteerde lijsten gericht bij; verander geen actieve prefixbetekenis zonder aparte opdracht.
- [ ] Voeg `test/helpUsesLoadedRegistry.test.js` toe en laat Help dezelfde actuele registry en toegangsregels gebruiken.
- [ ] Verifieer dat de actuele 96 slashroutes en contextmenuactie gelijk blijven, behalve een afzonderlijk expliciet afgesproken commandwijziging.
- [ ] Laat geen `00Overrides`-implementatie, Builderpatch of re-export verdwijnen doordat die op een “oud” bestand lijkt.

**Resultaat:** echte dode commandcode verdwijnt, met behoud van huidige functies. Overige optionele actieve commands blijven een afzonderlijke productkeuze.

### Fase F — Verificatie en concrete oplevering

- [ ] Voer nieuwe gedrags- en regressietests uit; daarna de verplichte repo-checks in een geïsoleerde kopie.
- [ ] Herhaal de catalogusopbouw en een gesimuleerde restart; eigen hashes/IDs blijven gelijk en oude voorbeelden keren niet terug.
- [ ] Vergelijk voor/na-exporten: nul verdwenen eigen records, overlays, attachmentreferenties, knopacties of actieve Reappear-ketens.
- [ ] Doorloop de Builder in een testserver met eigen tekst, custom emoji, logo uit/aan, afbeelding/GIF, Save, Repost, Delete, Search en editor.
- [ ] Controleer de huidige overige functies met representatieve smoke-tests uit §10; gebruik daarvoor testdata.
- [ ] Lever een kleine reviewbare diff/PR met tellingen, onbekende gevallen, testresultaten en rollbackinstructies.
- [ ] Zet pas live wanneer Dylano dat aan de uitvoerende bot heeft opgedragen; controleer daarna Railway `SUCCESS`, juiste commit en bot `ONLINE`, plus de relevante gebruikersflows.

## 10. Acceptatiecriteria en testmatrix

| Testgeval | Vereiste uitkomst |
|---|---|
| Oude ongewijzigde fishing-/fight-/oude gamble-template | Niet zichtbaar en niet opnieuw gematerialiseerd. |
| Hetzelfde oude item met eigen tekst | Blijft aanwezig, exact bewaard en bewerkbaar. |
| Alleen kleur, logo, footer, afbeelding of knop is gewijzigd | Behouden als eigen wijziging. |
| Oud `manualSaved: true` zonder verder bewijs | Review; niet blind als custom toelaten of verwijderen. |
| Een werkelijk eigen oudere post zonder moderne Savevlag | Behouden totdat veilige classificatie mogelijk is. |
| Eigen ongeposte opgeslagen draft | Blijft beschikbaar; niet verwarren met een ongebruikt codevoorbeeld. |
| Ongewijzigde template is ooit eenmaal verstuurd | Gebruik alleen is geen vrijstelling van de nieuwe policy. |
| Bronbestand verdwijnt of wordt hernoemd | Gearchiveerd item blijft gearchiveerd; eigen wijziging blijft behouden. |
| Ongebruikte plain/content-template | Zelfde policy als voor embeds. |
| Twee families met dezelfde titel | Geen wederzijdse toelating of verkeerde Save. |
| Twee eigen fysieke embeds met dezelfde titel | Beiden behouden; juiste fysieke selectie en Save. |
| Eén fysiek embed is via meerdere bronnen geregistreerd | Eén fysieke identiteit, zonder verlies van eigenaarssnapshot. |
| Search warm/koud en aangeboden selectie | Zelfde toegestane set, met juiste guild- en kanaalrechten. |
| PostgreSQL-fout of onvolledige catalogusfetch | Geen verlies, destructive cleanup of terugkeer van oude voorbeelden. |
| Discord 403/50001/50013, timeout of 429 | Geen bewijs van verwijdering; behoud data en herstelbaar gedrag. |
| Late history na Save/rename/archive/Delete | Geen oude titel of content terug in Search. |
| Automatische registrywrite tegelijk met Save | Recente Save blijft autoritatief en direct zichtbaar. |
| Eén catalogusbericht bevat custom én oude voorbeelden | De custom entries en oorspronkelijke identiteit blijven intact. |
| Echte welcome-/logpost openen | Eigen inhoud; geen codevelden of `{dynamic}`-kopie invoegen. |
| Ongewijzigde Save met GIF | Zelfde messageId, originele kwaliteit/animatie en juiste media binnen het embed. |
| Add/Remove media | Bestaande snelle preview- en opslagwerking blijft werken. |
| Bewust verwijderd item | Geen terugkeer via scan, cache, runtime-capture of restart. |
| Reappear na Save/Repost | Eén gevolgde identiteit; geen dubbele post of verloren previousMessageIds. |
| Archivering | Geen fysieke post-delete, Reappear-disable of permanente tombstone als bijeffect. |
| Andere guild | Geen zichtbaarheid, template-overlays of policybeslissingen van de eerste guild. |
| Help | Geen retired commands, technische mappen of dubbele bronimplementaties. |
| Herhaald uitvoeren | Geen extra catalogusberichten, inhoudswijzigingen of duplicaten. |

Representatieve controles buiten de Builder: ticket aanmaken/claimen/sluiten/heropenen, giveaway Create/Manage/Enter/Leave/claim, stem Start/Manage/End, de bestaande casino-/economiecommands, welcome/goodbye, logbestemmingen, muziek en gamefeeds. Deze opdracht verandert hun gedrag niet; ze moeten na integratie nog werken. Gebruik opgeslagen code-/land-/deelnemersgegevens nooit als opruimdoel.

## 11. Reeds uitgevoerde lokale controles

### 117 bestaande tests geslaagd

Eerste selectie, 36 tests:

```text
test/embedBuilderSearchUsedOnly.test.js
test/embedBuilderPhysicalOwnContent.test.js
test/embedBuilderSearchCatalogCleanup.test.js
test/embedBuilderAuthoritativeSnapshots.test.js
test/embedBuilderSavedEmojiPersistence.test.js
test/embedBuilderSearchTitlesOnly.test.js
test/balanceRetiredCommand.test.js
```

Aanvullende behoudscontrole, 81 tests:

```text
test/embedBuilderCanonicalIdentity.test.js
test/embedBuilderSaveOnlyRetention.test.js
test/embedBuilderConcurrentSavePermanentDelete.test.js
test/embedBuilderGifBannerEditPreservation.test.js
test/embedBuilderDurableRepost.test.js
test/embedBuilderNoopGifSaveAndPreviewParity.test.js
test/embedTenantIsolation.test.js
test/systemErrorTemplate.test.js
test/errorTemplateIsolation.test.js
test/ticketLogTemplatePersistence.test.js
test/embedBuilderPersistenceFailure.test.js
test/embedRegistryResolveTransient.test.js
```

Uitvoering: Node `v24.22.1`, dependencies via `npm ci --ignore-scripts --no-audit --no-fund`, afzonderlijke tijdelijke checkout, geen productiecredentials. Sommige geïmporteerde configuratie logt dat geen bottoken is ingesteld; er werd geen Discord-client ingelogd. Verwachte databasefouten in foutpaden zijn gemockt. De test-runners eindigden met exitcode 0.

### Diagnostische probes

De JSON-bijlage bevat de volledige probe-broncode en geobserveerde uitkomsten:

1. Controle: huidige, nooit gebruikte code-only embed wordt verborgen.
2. Hetzelfde ongebruikte item wordt weer zichtbaar wanneer zijn bron niet meer in discovery zit.
3. Een plain/content-reactie valt buiten de ongebruikt-keyset.
4. `manualSaved` alleen stelt een catalogusrecord zonder overlay vrij.
5. Een eigen post met dezelfde titel houdt een andere codefamilie zichtbaar.
6. Ooit-gebruikte code blijft toegelaten zonder actuele functiestatuscontrole.
7. Beheerder-Help toont retired `/gdelete`, `/fish` en `/flip` uit de bestandmappen.

Deze zeven probes slagen omdat ze het huidige gedrag aantonen. Voor een fix moeten de gewenste uitkomsten van de probleemgevallen worden getest; “probe geslaagd” betekent niet “probleem opgelost”.

Er is geen volledige lint-/test-/live-certificering van de hele bot uitgevoerd. Daarvoor is na de implementatie nog de integratiecontrole uit fase F nodig.

## 12. Rollback zonder nieuw dataverlies

1. Bewaar de vorige codecommit en de policyversie. Een code-rollback moet de bestaande opslag kunnen lezen.
2. Houd de eerste wijziging hoofdzakelijk omkeerbaar: selectie en logisch archief, geen fysieke Discord-deletes.
3. Bewaar een wijzigingsjournaal per aangepast document met vóór/na-versies en hashes.
4. Herstel alleen de relevante policy-/cataloguswijziging wanneer er inmiddels nieuwere Saves of gebeurtenissen zijn. Detecteer versieconflicten en merge bewust.
5. Zet nooit de volledige productiedatabase blind terug terwijl er na de back-up nieuwe tickets, claims, deelnemers, economiehandelingen of Saves zijn ontstaan.
6. Publiceer na herstel de actuele registry- en catalogusgeneraties; een geheugencache kan anders het oude beeld blijven tonen.
7. Controleer IDs, aantallen, mediahashes, knoppen, aliases en Reappear-ketens na herstel.

## 13. Definitie van klaar

- Alle eigen en aangepaste embeds uit de voor-export zijn aantoonbaar behouden, met dezelfde inhoud en fysieke identiteit waar die bestond.
- Ongewijzigde ongebruikte oude bronvoorbeelden ontbreken uit Search én overige Buildertoegangspaden.
- Ze worden niet opnieuw gegenereerd na gebruik van andere functies, history, cacheverversing of een restart.
- Aangepaste oude templates blijven bewerkbaar en herstelbaar, ook wanneer de oorspronkelijke commandcode is uitgefaseerd.
- Gedeelde runtimefuncties en benodigde huidige Cloudy-meldingen werken nog.
- Voor ieder gearchiveerd item bestaat een reden, oorspronkelijke data en een gecontroleerde herstelroute.
- De gewijzigde testcontracten zijn expliciet; de nieuwe tests en relevante regressie-/repo-checks slagen.
- Het opleverrapport noemt vóór/na-aantallen, bewaarde eigen items, resterende reviewgevallen en werkelijke live-validatie. Bij onbekende gevallen wordt geen “alles veilig verwijderd” of “alles 100% werkt” geclaimd.

## 14. Bronnen om direct te openen

Alle links verwijzen naar de onderzochte commit. Haal bij uitvoering de actuele versies op.

- [Commandloader en retired-routes](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/handlers/loaders/commandLoader.js#L120)
- [Het aparte registratiescript](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/scripts/register-cloudy-guild-commands.js#L75)
- [Brondiscovery onder src](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/embedDefinitionDiscoveryService.js#L587)
- [De huidige ongebruikt-regel](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/systemEmbedCatalogService.js#L707)
- [Catalogusopbouw](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/systemEmbedCatalogService.js#L1914)
- [Runtime-append van catalogusentries](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/systemEmbedCatalogService.js#L2059)
- [Searchmerge en titeluitzondering](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/commands/Tools/zz_embedbuilderLiveSearchPatch.js#L854)
- [Fysieke berichtinhoud in de Builder](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/embedManagerService.js#L1095)
- [Fysieke kanaaldiscovery](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/embedMissingChannelService.js#L106)
- [Eigen Post/Save-registratie](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/embedRegistryService.js#L900)
- [Opgeslagen overlays](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/services/embedTemplateService.js#L308)
- [Beperkte bestaande audit/back-up](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/scripts/embed-registry-audit.js#L103)
- [Automatische orphan-opruiming](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/events/gamingCatalogDiagnosticReady.js#L31)
- [Help leest commandbestanden opnieuw](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/src/handlers/help/helpSelectMenus.js#L159)
- [Bestaande test: used-only Search](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/test/embedBuilderSearchUsedOnly.test.js)
- [Bestaande test: eigen fysieke inhoud](https://github.com/Dylano24/Cloudy/blob/0f41f9d6f8fece613a156b732b4e2e8a7e36e888/test/embedBuilderPhysicalOwnContent.test.js)

## 15. Korte opdracht om samen met deze bestanden naar de andere bot te sturen

> Lees deze volledige overdracht en de JSON-inventaris. Mijn doel is een schone Embed Builder met mijn eigen en aangepaste Cloudy-embeds. Haal ongebruikte, ongewijzigde oude bronvoorbeelden eruit, maar behoud alles wat ik zelf heb gemaakt, opgeslagen of aangepast, ook van oude functies. Maak eerst een volledige gecontroleerde export en dry-run. Los de toelating structureel op voor Search, Modify, catalogusopbouw, runtime-capture, history en restarts. Gebruik geen titel-only of manualSaved-only selectie. Verwijder alleen aantoonbaar uitgefaseerde commandbestanden na afhankelijkheidscontrole; laat actieve commands en gedeelde functies werken. Bewaar alle tekst, spacing, kleuren, custom emoji’s, media/GIF-kwaliteit, knoppen, links, IDs, overlays en Reappear-regels. Werk in kleine geteste stappen en lever de concrete diff, behoudstellingen, tests en rollback op. Zet pas live wanneer ik dat expliciet vraag. Zeg niet dat alles werkt zolang er nog ongeteste flows of onopgeloste reviewgevallen zijn.
