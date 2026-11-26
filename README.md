# Stash

Stash è una PWA per salvare note e link. La **Home** mostra le cinque note più recenti. La lente apre la ricerca nella **Libreria**, dove puoi cercare e filtrare l’intero archivio. Usa la barra inferiore o uno swipe orizzontale per passare tra Home, Libreria, Progetti, Task e Cestino. Su Android l’app installata riceve testo e URL dal menu **Condividi**.

Nella sezione **Progetti** puoi creare un progetto. Per aggiungere una nota già salvata, apri il menu **⋯** della nota e scegli **Collega a progetto**. Ogni nota resta in Libreria e può appartenere a più progetti. Nel dettaglio del progetto, **Scollega dal progetto** rimuove il singolo collegamento.

Il menu **⋯** in alto a destra di ogni nota raccoglie le azioni disponibili. Puoi modificare la nota, correggere tipo e tag, creare un task e gestire gli allegati. **Sposta nel Cestino** rende la nota recuperabile per 30 giorni. Dal menu della nota nel Cestino, **Ripristina** recupera anche allegati, task e collegamenti.

Ogni nota può avere fino a 5 allegati da 10 MB, caricati dentro Stash. Se un caricamento si interrompe, riprova sulla stessa nota. Per gli allegati da completare puoi riselezionare i file originali dalla nota. Il menu Condividi di Android accetta testo e link.

In Home, **Da chiarire** raccoglie le note con intenzione ancora incerta da un’ora dopo la cattura. Puoi scegliere un’intenzione, aggiungere contesto, creare un task, rimandare di 24 ore o chiudere la domanda. Il contesto salvato compare nella scheda ed è ricercabile in Libreria.

I **Ricordi della settimana** riuniscono fino a cinque note da ricordare o approfondire, salvate da almeno 14 giorni. La raccolta si aggiorna alla prima apertura utile della Home da lunedì, nel fuso Europe/Rome. **Già visto** sospende la nota per 12 settimane, **Più tardi** le dà priorità nella prossima raccolta e **Non riproporre** la esclude.

## Sviluppo locale

Servono Node.js 22.18 o successivo, npm, Supabase CLI e un runtime compatibile con Docker per avviare Supabase in locale.

```sh
npm ci
npm test
npm run build
supabase start
supabase status
```

In Supabase Studio, crea due utenti sintetici confermati in **Authentication → Users**. Stash usa email e password e la registrazione è disattivata nella configurazione locale. Copia `.env.example` in `.env.local` e imposta l’URL API e la chiave pubblica (`publishable` o `anon`) indicati da `supabase status`.

```sh
npm run dev
```

I test usano PostgreSQL in memoria con i ruoli Supabase simulati e un trasporto fittizio per Groq. Verificano l’isolamento di Item, progetti e collegamenti, l’idempotenza, il recupero di un lavoro interrotto e la gestione di timeout, quota e risposta non valida. I test M3 coprono anche i tempi dei chiarimenti, la precedenza delle correzioni, la selezione settimanale e il feedback. Applica le due migrazioni M3 prima di pubblicare il frontend.

Il collaudo M3 su Supabase locale ha verificato l’aggiornamento da M2 con dati sintetici, accesso con due account, allegati privati, Cestino e richieste concorrenti alle RPC. Gli advisor non hanno registrato rilievi. Le Edge Function sono state provate nel runtime Supabase diretto dopo un 404 del gateway nativo locale. Il collaudo M3 sulla PWA installata su Android resta aperto.

## Attivare la classificazione

Il salvataggio conferma la persistenza in Supabase. La classificazione è disattivata per impostazione predefinita. L’opzione nell’app abilita l’invio a Groq dei salvataggi successivi da quel dispositivo. La funzione server controlla il consenso e cerca indizi di credenziali prima di inviare il testo e il link della versione attuale. L’editor parte con la riclassificazione disattivata a ogni modifica. La funzione non riceve allegati. Verifica quote e conservazione dei dati nel tuo account Groq prima di usare note personali.

La funzione Edge `classify-item` elabora la coda. Per provarla in locale, usa `supabase functions serve classify-item --env-file supabase/functions/.env.local`. Imposta `CLASSIFY_WORKER_SECRET` a un segreto casuale di almeno 32 caratteri e metti l’eventuale `GROQ_API_KEY` nello stesso file. Esegui una richiesta `POST` a `/functions/v1/classify-item` con il segreto del worker nell’header `Authorization: Bearer …`. La chiave Groq assente consente di provare lo stato di errore e il retry senza contattare il provider.

Nel progetto Supabase ospitato, disattiva la registrazione pubblica, applica le migrazioni e imposta `CLASSIFY_WORKER_SECRET` e `GROQ_API_KEY` come segreti della funzione. Distribuisci `classify-item` con la configurazione del progetto. Salva in Vault l’URL del progetto con nome `stash_project_url` e lo stesso segreto del worker con nome `stash_classify_worker_secret`. Abilita Cron e `pg_net`, poi registra il job nel progetto.

```sql
select cron.schedule('stash-classify-item', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'stash_project_url')
           || '/functions/v1/classify-item',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'stash_classify_worker_secret')),
    timeout_milliseconds := 45000
  )
  where exists (
    select 1 from public.item_classifications c
    join public.items i on (i.user_id, i.id) = (c.user_id, c.item_id)
    where i.trashed_at is null and i.ai_allowed and c.status = 'pending'
      and (c.lease_until is null or c.lease_until <= now())
  );
$$);
```

## Attivare la pulizia del cestino

Applica le migrazioni in ordine. Aggiorna `classify-item`, quindi distribuisci `purge-trash` come definito in `supabase/config.toml`. Per provare la funzione in locale usa `supabase functions serve purge-trash --env-file supabase/functions/.env.local` e invia un POST con l’header `Authorization: Bearer …`.

Imposta `PURGE_WORKER_SECRET` a un segreto casuale di almeno 32 caratteri e salvalo anche in Vault con nome `stash_purge_worker_secret`. Registra il job prima di pubblicare il frontend. La funzione restituisce `204` quando ha completato il lotto e `503` quando occorre riprovare. Controlla le risposte della funzione e lo stato dei job Cron dopo il rilascio. La pulizia richiede almeno due cicli per i file entrati nel lotto per la prima volta.

```sql
select cron.schedule('stash-purge-trash', '*/15 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'stash_project_url')
           || '/functions/v1/purge-trash',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'stash_purge_worker_secret')),
    timeout_milliseconds := 45000
  )
  where exists (
    select 1 from public.items where trashed_at <= now() - interval '720 hours'
  ) or exists (
    select 1 from public.item_files
    where remove_after <= now() or (status = 'pending' and created_at <= now() - interval '24 hours')
  );
$$);
```

## Prova su Android

Imposta la configurazione pubblica del progetto Supabase, esegui `npm run build` e pubblica il contenuto di `dist/` alla radice di un sito HTTPS. Per una prima prova puoi usare il caricamento diretto di Cloudflare Pages. Apri il sito in Chrome su Android e installa Stash.

1. Accedi, lascia la classificazione disattivata e salva «Prendere treno». Chiudi Stash, riaprilo e verifica il testo in Home. Accedi con il secondo utente di prova e verifica che la nota sia assente.
2. Condividi un URL da Chrome e uno da YouTube. Verifica che entrambi compaiano al riavvio. Se la connessione si interrompe prima della conferma, riapri la schermata della condivisione e riprova lo stesso invio. L’Inbox deve contenere un solo Item per invio. Per provare un nuovo salvataggio intenzionale, condividi nuovamente lo stesso link.
3. Abilita la classificazione e salva una nota sintetica. Verifica che la Home mostri il risultato o, con il backend di prova privo di chiave Groq, lo stato di errore. Dal menu **⋯** usa **Riprova classificazione**. Dopo un tentativo riuscito, controlla che la classificazione compaia sulla stessa nota.

4. Collega una nota a due progetti. Modificala, verifica testo e link nella Libreria e nei due progetti, poi spostala nel Cestino e ripristinala. Verifica che il task collegato torni visibile.
5. Carica un’immagine e un PDF sintetici dal selettore. Interrompi la connessione durante un tentativo e riprova. Verifica che ciascun file compaia una sola volta e sia scaricabile con l’account proprietario.
6. Scorri in orizzontale tra le cinque sezioni e verifica che la barra evidenzi quella corrente. Prova lo scroll verticale, il gesto Indietro di Android e la navigazione con la tastiera aperta. Controlla che la bozza si ritrovi tornando alla Home.
7. Con dati sintetici, riapri Stash dopo un’ora e rispondi a un chiarimento aggiungendo contesto. Cercalo in Libreria. Su una seconda nota usa **Crea task** e verifica che il task compaia solo dopo la conferma e abbia la scadenza vuota.
8. Con note di prova da ricordare o da approfondire, salvate da almeno 14 giorni, apri un ricordo e usa **Già visto**. Chiudi e riapri l’app. Verifica che la stessa raccolta resti disponibile e che la nota già vista sia scomparsa.
