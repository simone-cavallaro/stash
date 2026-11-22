# Stash

Stash è una PWA per salvare note e link e ritrovarli nell’Inbox. Su Android l’app installata può ricevere testo e URL dal menu **Condividi**.

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

I test usano PostgreSQL in memoria con i ruoli Supabase simulati e un trasporto fittizio per Groq. Verificano la persistenza con AI disattivata, l’isolamento tra utenti, l’idempotenza, il recupero di un lavoro interrotto e la gestione di timeout, quota e risposta non valida.

## Attivare la classificazione

Il salvataggio conferma la persistenza in Supabase. La classificazione è disattivata per impostazione predefinita. L’opzione nell’app abilita l’invio a Groq dei salvataggi successivi da quel dispositivo. La funzione server controlla il consenso e cerca indizi di credenziali prima di inviare l’originale. Verifica quote e conservazione dei dati nel tuo account Groq prima di usare note personali.

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
    select 1 from public.item_classifications
    where status = 'pending' and (lease_until is null or lease_until <= now())
  );
$$);
```

## Prova su Android

Imposta la configurazione pubblica del progetto Supabase, esegui `npm run build` e pubblica il contenuto di `dist/` alla radice di un sito HTTPS. Per una prima prova puoi usare il caricamento diretto di Cloudflare Pages. Apri il sito in Chrome su Android e installa Stash.

1. Accedi, lascia la classificazione disattivata e salva «Prendere treno». Chiudi Stash, riaprilo e verifica il testo nell’Inbox. Accedi con il secondo utente di prova e verifica che la nota sia assente.
2. Condividi un URL da Chrome e uno da YouTube. Verifica che entrambi compaiano al riavvio. Se la connessione si interrompe prima della conferma, riapri la schermata della condivisione e riprova lo stesso invio. L’Inbox deve contenere un solo Item per invio. Per provare un nuovo salvataggio intenzionale, condividi nuovamente lo stesso link.
3. Abilita la classificazione e salva una nota sintetica. Verifica che l’Inbox mostri il risultato o, con il backend di prova privo di chiave Groq, un errore con **Riprova**. Dopo un tentativo riuscito, controlla che la classificazione compaia sulla stessa nota.
