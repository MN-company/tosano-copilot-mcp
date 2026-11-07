# Tosano Copilot MCP

Fai la spesa su **LaTuaSpesa / IperTosano** parlando con il tuo agente AI: Claude, ChatGPT, Cursor, Copilot, Gemini, Codex.

Ricerca e offerte, carrello e ordini **solo con la tua approvazione esplicita**, ricette vere, menu settimanale, allergie di tutta la famiglia, dispensa, budget, "la solita spesa".

## Installazione

**Il modo più semplice: chiedilo al tuo agente.**

> Installa il plugin Tosano Copilot da github.com/MN-company/tosano-copilot-mcp

In Claude Code:

```
/plugin marketplace add MN-company/tosano-copilot-mcp
/plugin install tosano@tosano-copilot
```

Il plugin si accorge che il server non c'è e Claude lo installa da solo.

**Oppure un comando.** Serve [Docker Desktop](https://www.docker.com/products/docker-desktop/).

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.ps1 | iex
```

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.sh | bash
```

Lo script:

1. scarica il codice;
2. avvia il server in Docker;
3. importa le ricette;
4. ti fa accedere a LaTuaSpesa in una finestra locale (la password la scrivi tu, nessuno la salva);
5. collega l'MCP a tutti gli agenti che trova: Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI, Codex CLI, LM Studio.

Endpoint: `http://127.0.0.1:3788/mcp`. Registrazione manuale e ChatGPT: vedi [AGENTS.md](AGENTS.md).

## Cosa sa fare

| Area | Funzioni |
|---|---|
| Profilo | onboarding, permessi dell'agente, marche, allergie e intolleranze (14 allergeni UE + nichel, istamina, lattosio, polioli), profili famiglia |
| Catalogo | ricerca intelligente, offerte, volantino, prodotti preferiti, etichette, sostituti, storico prezzi, indice glicemico stimato |
| Carrello | modifiche in due fasi con approvazione, prodotti a peso, opzioni, note, imballaggi, sostituzioni, buoni |
| Spesa | fascia oraria, indirizzo e negozio, costi di consegna, preview del checkout, checkout con frase di conferma |
| Ordini | storico, dettaglio, riordino, modifica, annullamento, pagamenti falliti |
| Cucina | 1.400+ ricette reali (Wikibooks CC BY-SA, TheMealDB), ricette personali, menu settimanale → spesa unica, dispensa |
| Abitudini | "la solita spesa" dagli ordini passati, budget settimanale |

## Sicurezza

- **Scritture disattivate di default.** Si attivano in `config/tosano.env`: `ALLOW_CART_WRITES`, `ALLOW_LIST_WRITES`, `ALLOW_ORDER_WRITES`, `ALLOW_CHECKOUT`.
- **Ogni modifica reale** segue lo stesso schema: preparazione → riepilogo → tua approvazione → esecuzione una sola volta → verifica. Mai ritentata se l'esito è incerto.
- **Allergie trattate in modo prudente.** Etichetta incompleta = da verificare; tracce bloccate per le allergie gravi. L'agente non dice mai "sicuro".
- **Nessun segreto passa dagli agenti.** Cookie, password e chiavi restano in locale.

## Sviluppo

```bash
npm ci && npm run check && npm test
```

Documentazione: [docs/](docs/). Guida per gli agenti: [skills/tosano-shopping/SKILL.md](skills/tosano-shopping/SKILL.md).

Progetto personale non affiliato a Tosano.
