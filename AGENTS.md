# [App Name]

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

[Brief description of what the app does and its primary use case]

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## Share links

- Starter apps already ship `getShareBase`, `buildShareLink` and `installShareSync` in `src/lib/share.ts`; import them instead of rewriting them.
- Keep shareable state in the URL path or query, not in the `#fragment`.
- Never put a secret (private key, claim secret, seed phrase, session token, API key) in the URL path or query, encoded or not: every in-app path and query is mirrored to the visitor's studio.arc.io address bar and browser history and reaches servers. A bearer claim secret goes only in the `#fragment` appended to the share link (`` `${await buildShareLink('/claim')}#${secret}` ``) and is read from `location.hash` on load. A link to the app's own share URL shown inside the app must be copy-only or open in a new tab with `target="_blank" rel="noopener noreferrer"`.
- Build every link a user copies or sends with `buildShareLink()` from `src/lib/share.ts`.
- Keep the `installShareSync()` call in `src/main.tsx` when editing it; it keeps the Studio address bar in step with in-app navigation.
- Navigate inside the app with relative links.

## Build log and Arc Studio sync (standing rule)

- Every meaningful step (merge, deploy, onchain transaction, live test, finding, decision) gets a row in `docs/BUILD_LOG.md`: time in IST with UTC in brackets, one line on what happened, and a commit hash or explorer link. Close items in its "Open items" list as they land.
- After each update, mirror the log into the Arc Studio project (app `7582b931-f752-4b46-a210-d0898b2062a7`) so Studio shows the same timeline: `arc-studio run "<overwrite docs/BUILD_LOG.md with the attached file, touch nothing else>" --file docs/BUILD_LOG.md:docs/ --app 7582b931-f752-4b46-a210-d0898b2062a7`, then confirm with `arc-studio cat docs/BUILD_LOG.md`.
- Keep the Studio workspace in step with GitHub `main` (code, contracts, this file) after merges, so the Arc Studio project link always shows the current build.
- **"sync to arc" command:** when Ramit says "sync to arc", push everything from the current work into the Arc Studio project in one go:
  1. Record new brainstorms and decisions in `docs/DECISIONS.md`.
  2. Add timeline rows to `docs/BUILD_LOG.md`.
  3. Upload every file that changed on GitHub `main` since the last sync, plus these docs, from open PR branches if not merged yet.
  4. Verify each uploaded file byte-for-byte with `arc-studio cat`, and report what was synced.
  Skip PNG screenshots and `.env*` files (the CLI refuses them). Check `arc-studio usage --json` first.
- Brainstorms that change the product (what to build, what to cut, how something is measured) always go into `docs/DECISIONS.md`, so Studio holds the reasoning, not only the code.

## To Run

```bash
bun install
bun run dev
```

## Deployed contracts (Arc Testnet, chain 5042002)

- StockExchange: 0x93662de514b981f8c7bf97085e359e0f18034804 (inventory model, owner 0xC658A9Bd5ADE6CCd87874f5De925528CE57b4C93, CRE mock forwarder)
- IndexFactory: 0x9fa4034efb237a7c154adea20b1ccfa0cd538b11 (registrar = address(0), same owner)
- SIPManager: 0xd96ea5a6c776eac72e5da4f7abb838b5da053f3a (no owner)
- ABIs and addresses: `contracts/contract-metadata/`
- Pending owner steps: `StockExchange.setTrustedFactory(IndexFactory)`, then `listExternalStock` for the bridged tokens and fund inventory/reserve.
