export default function App() {
  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-slate-100">
      <div className="bg-amber-400/90 px-4 py-1.5 text-center text-xs font-medium tracking-wide text-amber-950">
        Testnet demo · Not an offer · Not affiliated with the listed companies
      </div>

      <header className="mx-auto flex w-full max-w-5xl items-baseline justify-between gap-4 px-6 py-5">
        <h1 className="text-xl font-semibold tracking-tight">Inphinity</h1>
        <p className="text-sm text-slate-400">Indian stocks. Always open.</p>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <h2 className="max-w-2xl text-balance text-center text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Buy Indian stocks or build your own Indian index, in USDC, 24/7.
        </h2>
      </main>
    </div>
  )
}
