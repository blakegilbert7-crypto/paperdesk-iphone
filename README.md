# PaperDesk for iPhone

PaperDesk as a Home Screen app for iPhone: the same paper-trading engine, research-backed trade ideas,
sell alerts, Top trades, Learn tab and themes as the Windows app, laid out for a phone.

**Paper money only.** It never connects to a broker and cannot place real trades. Past results do not
predict future results.

## Install on your iPhone

1. Open **https://paperdesk-iphone.blakegilbert7.workers.dev** in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open PaperDesk from the new icon. It runs full screen like a normal app.

Your paper account is saved on the phone, inside the Home Screen app. Removing the app from the Home
Screen deletes it. The Safari tab and the Home Screen app keep separate accounts, so use the icon.

PaperDesk watches the market only while it is open. When you come back, it checks the price bars it
missed and fills any stop or target that was hit while it was closed.

## Carry your trades between the PC and the phone

On the Windows app (or the phone), open **Settings > Get my code**. On the other device, open
**More > Sync code** (or Settings) and type the code under **Enter a code**. Your cash, open trades,
orders, history and settings load there, and from then on both stay in step. A code also keeps a backup
of the account if the Home Screen app is ever removed. Keep the code private: anyone with it can see and
change that paper account.

## How it is hosted

Cloudflare serves this repository as a Worker with static assets (`wrangler.jsonc`):

- `public/` is the app.
- `worker/index.js` answers `/relay` and `/sync`, and hands every other request to the app files.
- `functions/relay.js` holds the relay itself (it also works as a Cloudflare Pages Function).
- `functions/sync.js` stores sync codes: one small Durable Object (`SyncBox`, SQLite storage, on the free
  plan) per code, holding that code's paper account as one JSON document. No names, emails or passwords.
  A code that is not used for 400 days is deleted.

Yahoo Finance does not let web pages read its public chart data directly, so the app asks the relay. It
forwards only Yahoo's public chart and spark endpoints, keeps no logs or accounts, and caches answers for a
few seconds. Crypto prices come straight from Coinbase's public API.

Every push to `main` goes live automatically. The app picks up the new version the next time it is opened.

## Where the code comes from

`public/` is generated from the PaperDesk source with `node web/build.js`. It bundles the engine in
`core/` into `public/js/engine.js` and adds the phone layout (`phone.css`, `js/phone.js`), the service
worker (`sw.js`) and the icons. Edit the PaperDesk source and rebuild instead of editing `public/` by hand.
