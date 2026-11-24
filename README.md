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

## How it is hosted

Cloudflare serves this repository as a Worker with static assets (`wrangler.jsonc`):

- `public/` is the app.
- `worker/index.js` answers `/relay` and hands every other request to the app files.
- `functions/relay.js` holds the relay itself (it also works as a Cloudflare Pages Function).

Yahoo Finance does not let web pages read its public chart data directly, so the app asks the relay. It
forwards only Yahoo's public chart and spark endpoints, keeps no logs or accounts, and caches answers for a
few seconds. Crypto prices come straight from Coinbase's public API.

Every push to `main` goes live automatically. The app picks up the new version the next time it is opened.

## Where the code comes from

`public/` is generated from the PaperDesk source with `node web/build.js`. It bundles the engine in
`core/` into `public/js/engine.js` and adds the phone layout (`phone.css`, `js/phone.js`), the service
worker (`sw.js`) and the icons. Edit the PaperDesk source and rebuild instead of editing `public/` by hand.
