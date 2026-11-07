# Cloudy — opschoning met behoud van bestaand gedrag

## Status en opdracht

Werkbranch: `codex/builder-catalog-cleanup-20261107`.
Basis: `0f41f9d6f8fece613a156b732b4e2e8a7e36e888` van `main`.
De eigenaar heeft implementatie en controles toegestaan. **Niet mergen naar main en niet deployen totdat de eigenaar expliciet zegt dat het live mag.** Deze overdracht vult het oorspronkelijke plan aan; onderstaande actuele behoudsregels gaan voor oudere uitspraken over alleen recente usage.

Behoud alles wat Cloudy gebruikt of gebruikte, wat de eigenaar heeft aangepast, wat is uitgebreid, en wat daarvan afhankelijk is. Verwijder alleen aantoonbaar gepensioneerde implementaties. Leeftijd, auteursnaam, een gelijke titel, een lege recente log of een ontbrekend catalogus-ID bewijst niet dat iets ongebruikt is.

## Wat uit de broncode is verwijderd

Deze twaalf bestanden werden vóór deze wijziging al door de commandloader overgeslagen. De volledige geladen commandset blijft gelijk: 97 routes, waarvan 96 slash commands en één contextmenu.

| Verwijderde bestanden onder src/commands | Bestaande werking die blijft |
| --- | --- |
| Economy/fish.js, mine.js, slots.js | Bestaande accounts, inventaris en gedeelde economyfuncties blijven intact |
| Economy/gamble.js | Huidige `/gamble info` uit Economy/gambling.js blijft |
| Fun/count.js | Het bestaande counting-event en opgeslagen configuratie blijven |
| Fun/fight.js, flip.js, roll.js | Huidige `/game info` en casino’s blijven |
| Giveaway/gcreate.js | Huidige `/giveaway create` blijft |
| Giveaway/gend.js, gdelete.js, greroll.js | Huidige `/giveaway manage`, knoppen en gedeelde acties blijven |

Er is een regressietest met de exacte 97 namen van de gedeployde versie. De Join to Create-override blijft leidend. De bestaande knoppen van oude giveawayberichten blijven werken via de bestaande handlers.

De overige geladen commands worden niet verwijderd op basis van aannames over gebruik. De volledige geschiedenis is beschikbaar: 3221 commits op de onderzochte main. Vergelijking met de upstreambaseline beschermt 175 bronbestanden die Cloudy heeft toegevoegd of aangepast. Dit is voorzichtig bewijs voor behoud, geen verklaring dat ieder command dagelijks wordt gebruikt.

## Embed Builder

`builderCatalogPolicy.js` is de gedeelde beslissing voor Search, Modify, het openen van een oude selectie en het toevoegen van standaard catalogusvoorbeelden. Runtime-rendering en opgeslagen content staan los van deze zichtbaarheid.

| Bewijs | Beslissing |
| --- | --- |
| Expliciete Save, bewezen overlay, gemodificeerd record of herkenbare eigen Builder-write | Tonen |
| Exacte gebruikssleutel in dezelfde server | Tonen, ook bij historisch gebruik |
| Huidige Cloudy-familie, vaste melding of beschermde tickettemplate | Tonen |
| Eigen echte post of oud record met onzekere herkomst | Bewaren en beoordelen |
| Verschil in tekst, witruimte, kleur, logo, banner, velden, footer, auteur of knoppen | Bewaren en beoordelen |
| Exact ongewijzigd bronvoorbeeld van een niet toegelaten functie, zonder bekend gebruik | Niet tonen als standaardvoorbeeld |
| Gebruiksinformatie niet beschikbaar of bron niet betrouwbaar herkenbaar | Bewaren en beoordelen |

Een automatisch `manualSaved`-vlaggetje bewijst geen eigen bewerking. Een echte Save blijft beschermd. Een post met dezelfde titel bewijst geen gebruik van een andere templatefamilie. De fysieke identiteit blijft server + kanaal + bericht-ID + embed-index.

De 20 oude brondefinities van de verwijderde bestanden hebben 19 verschillende familie-identiteiten. Alleen hun identiteiten en 20 SHA-256-vingerafdrukken blijven als herkenningsgegevens bestaan in `retiredBuilderCatalogFingerprints.json`; de oude embedfabrieken zijn verwijderd. Daardoor keert een herkend ongebruikt bronvoorbeeld na een herstart niet terug doordat zijn bronbestand ontbreekt. Een gewijzigde of expliciet opgeslagen variant blijft behouden.

Plain-text replies gebruiken dezelfde regel als embeds. Zodra Cloudy een reply vastlegt als verzonden, wordt de exacte sleutel per server als gebruikt onthouden. De catalogus maakt bij opstarten niet meer automatisch ieder ongebruikt bronvoorbeeld aan. Aliassen en runtimebronnen blijven beschikbaar voor de huidige functies.

## Bescherming tegen verlies

- De automatische taak die een hele registry-array overschreef na het vinden van vermeende weesrecords is verwijderd. De diagnostiek leest alleen en staat standaard uit.
- Een mislukte Discord-history-read breekt catalogusinitialisatie af. Opgeslagen catalogus-ID’s worden samengevoegd, niet overschreven door een gedeeltelijk gelezen venster.
- Oude plain-text-bronbaselines blijven bewaard wanneer een bron verdwijnt.
- Bestaande Discordberichten, opgeslagen templates, overlays, tombstones, reappearregels, media, economydata en instellingen worden niet door deze opschoning verwijderd of herschreven.
- Bestaande Save/Post/Delete-, media-, ticket-, giveaway- en casinowerking wordt door regressietests gecontroleerd. Er is geen nieuwe automatische migratie bij opstarten.

## Cloudy-naamgeving en Help

De actieve response-marker, foutklasse, standaardnaam voor een nieuwe lokale database, Compose-containers/netwerk, CI-testdatabases en README gebruiken Cloudy. Bestaande expliciete database-URL’s, gebruikersnamen en databasenamen blijven exact behouden. Compose vereist de werkelijke databasegebruiker en databasenaam om een bestaande volume niet ongemerkt anders te benaderen.

De oorspronkelijke MIT-vermelding blijft in LICENSE; Cloudy heeft een eigen aanvullende copyrightregel. Gitgeschiedenis is niet herschreven.

Help leest de geladen commandregistry, toont slash routes eenmaal, slaat contextmenu’s en de uitgeschakelde Leveling-categorie over en gebruikt de command-ID’s van de betreffende server. Oude aliassen voor gepensioneerde funcommands en de dashboardverwijzing naar `/gcreate` zijn bijgewerkt.

## Controle vóór een latere livegang

De huidige Railway-verbinding geeft databasecredentials afgeschermd terug. In deze sessie is daarom **geen ruwe productie-export, volledige backup/restoreproef of Discord-eindtest tegen productie** uitgevoerd. Ook zijn geen productiegegevens aangepast. De tests bewijzen lokaal gedrag; ze bewijzen niet dat ieder onbekend historisch productierecord al is beoordeeld.

Het gereedschap `scripts/builder-catalog-audit.js` importeert geen database-initializer en voert alleen directe SELECTs uit binnen een `REPEATABLE READ READ ONLY`-transactie. Het exporteert alle gevonden applicatietabellen. Originele mediabytes kunnen worden meegekopieerd met SHA-256-controle. Het bestand wordt uitsluitend nieuw aangemaakt met beperkte bestandsrechten; een bestaande export wordt niet overschreven.

Voorbeeld, uitgevoerd door een operator met de bestaande productieomgeving:

```bash
pg_dump --format=custom --file=/secure-backup/cloudy-before-cleanup.dump "$POSTGRES_URL"
node scripts/builder-catalog-audit.js --out /secure-backup/cloudy-audit/snapshot.json --media-dir /cloudy-media
node scripts/builder-catalog-audit.js --input /secure-backup/cloudy-audit/snapshot.json --out /secure-backup/cloudy-review/snapshot.json
```

De JSON-export is data-only (`schemaIncluded: false`) en vervangt geen geverifieerde pg_dump-backup. Controleer herstelbaarheid en originele mediabestanden vóór een latere livegang. Offline analyse meldt `show`, `archive` en `review`, heeft `canMutate: false` en voert nooit verwijderingen uit. Onbekende herkomst blijft review. De oorspronkelijke export blijft de bron voor herstel.

Beoordeel de productie-export op eigen templates, overlays, oude varianten, originele media en exacte historische gebruikssleutels. Er is bewust geen `--apply` of automatische productie-opruiming. Pas na de expliciete live-instructie volgen main, Railway en de Discord-eindcontrole.

## Verificatie

Volledige lokale suite: 1808 tests, 1805 geslaagd, 3 overgeslagen (PostgreSQL-integraties zonder testdatabase), 0 fouten en 0 geannuleerd. Een aanvullende controle van de offline analyse slaagt met 5/5 tests. ESLint: 0 errors, 428 waarschuwingen. De onafhankelijke review vond één belangrijk randgeval: een aangepast auteursicoon of auteurslink naast de technische catalogusnaam moest meetellen als eigen wijziging. Dit is hersteld; normale en gepensioneerde bronvergelijking zijn met icon-only- en link-only-regressies getest (28/28 gerichte controles). Er zijn geen verdere bevestigde codeblokkades gevonden. De hele suite draait in een aparte kopie omdat enkele bestaande tests fixturebestanden in de bronboom schrijven. De werkbranch en main blijven daarvan gescheiden.
