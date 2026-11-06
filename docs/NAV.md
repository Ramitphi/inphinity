# How NAV works in Inphinity

Plain-language guide to the net asset value (NAV) of an Inphinity index fund: what it is, what moves it,
and what happens at the edges. Every number below was read live from Arc Testnet (chain 5042002) on
**Fri 6 Nov 2026, 20:18 IST (14:48 UTC)**, block 71045188, unless marked as a "what if".

Code: `contracts/IndexFund.sol` (fund) and `contracts/StockExchange.sol` (prices and trading).

---

## 1. Two numbers: NAV and NAV per share

| | What it is | Formula in the contract |
|---|---|---|
| **NAV** | Everything the fund owns, in USDC | `nav() = idle USDC + Σ (stock balance × mid price)` |
| **NAV per share** | What one share is worth | `navPerShare() = nav × 1e18 / totalSupply` (reads 1.00 when supply is 0) |

A share is an ERC-20 token, so you can think of it like a pizza:

- **NAV** is the size of the whole pizza.
- **NAV per share** is the size of one slice.

Some events make the pizza bigger (a new investor brings money). Others cut the same pizza into more slices
(the management fee). Holders care about the slice.

The fund always values stocks at the exchange **mid price**, the CRE oracle price with no spread. The
spread is only paid when stocks are actually bought or sold.

### Live example: BCHIP (`0x9272a103f49399d1b7FD538f7a5103E11080895A`)

"Big Tech Bluechip": 30% tAAPL, 25% tMSFT, 25% tNVDA, 20% tGOOGL, management fee 1%/yr (100 bps).
One investment of 5 USDC so far.

| Stock | Weight | Fund holds | Mid price | Value (USDC) | Share of NAV |
|---|---|---|---|---|---|
| tAAPL | 30% | 0.004336628 | 344.17 | 1.492537 | 30.0% |
| tMSFT | 25% | 0.002320790 | 535.93 | 1.243781 | 25.0% |
| tNVDA | 25% | 0.006849015 | 181.60 | 1.243781 | 25.0% |
| tGOOGL | 20% | 0.003521339 | 282.57 | 0.995024 | 20.0% |
| Idle USDC | | | | 0.000000 | |
| **NAV** | | | | **4.975123** | |

- Total supply: 4.975123 shares. The creator holds 4.975122999999999; the last 1000 wei are locked at `0x…dEaD`.
- **NAV per share = 1.000000 USDC.**

So the 5 USDC went in and the fund is worth 4.975123. The missing 0.024877 (0.5%) is the exchange spread,
and **the investor paid it with fewer shares**: 5 USDC bought 4.975 shares, not 5. That is why NAV per share
is still exactly 1.00. Section 3 explains this.

The prices have not moved since the deposit yet. The US market opens at 20:00 IST, and the last CRE report
(19:47 IST) still carried the previous close. From tonight's session on, NAV will move with each report.

---

## 2. The five things that move NAV

| # | Event | NAV (pizza) | NAV per share (slice) | Who wins or loses |
|---|---|---|---|---|
| 1 | **Price update** (Chainlink CRE) | moves | moves by the same % | every holder, equally |
| 2 | **Invest / redeem** | up / down | **unchanged** (±rounding) | the person trading pays the 0.5% spread |
| 3 | **Management fee** | unchanged | down (dilution) | holders pay, the creator receives shares |
| 4 | **Idle USDC** (a donation or leftover) | up | up | existing holders gain |
| 5 | **Rounding** | tiny | tiny (always in the fund's favour) | dust, a few millionths of a USDC |

### 2.1 Price moves: "what if tNVDA moves +5%?"

**How prices arrive.** The Chainlink CRE workflow (`cre/price-feed`, branch `feat/cre`) fetches each stock's
USD price from Yahoo Finance and takes the median across nodes. It then writes one signed report to
`StockExchange.onReport`.

- During the demo the workflow runs as a CRE simulation on a timer: `cre/run-loop.sh`, every 5 minutes by default.
- One run can make at most 15 HTTP calls, but 16 stocks are listed. Each run therefore updates the
  **15 stalest prices first**, sorted by `updatedAt` with ties kept in listing order. Every stock rotates
  through within two runs.
- On the first live report (19:47 IST) tORCL was the one left out. It tied with the 7 other newer stocks and
  lost the tie-break, so it is first in line for the next run.

The contract caps each report at **±5%** per stock (`maxMoveBps = 500`). If Yahoo shows a bigger jump, the
workflow clamps the price to ±5% and catches up on later runs.

Suppose tNVDA goes from 181.60 to 190.68 (+5%), and everything else stays flat:

```
tNVDA value before : 0.006849015 × 181.60 = 1.243781
tNVDA value after  : 0.006849015 × 190.68 = 1.305970   (+0.062189)
NAV                : 4.975123 → 5.037312
NAV per share      : 1.000000 → 1.012500   (+1.25%)
```

**Rule of thumb:** NAV per share moves by *(stock's share of NAV) × (stock's move)*. Here that is
25% × 5% = 1.25%.

The weights are fixed at the share counts bought on the day of each deposit. After price moves the fund
drifts from its targets. If tNVDA rallies, it becomes more than 25% of NAV. New deposits are still split
30/25/25/20 by USDC, so the fund does **not** rebalance itself.

### 2.2 Invest and redeem: who pays the spread

The exchange quotes three prices per stock:

| | Formula | tNVDA now |
|---|---|---|
| Buy price | mid × 1.005 (rounded up) | 182.508 |
| Mid price (used for NAV) | CRE price | 181.600 |
| Sell price | mid × 0.995 (rounded down) | 180.692 |

**Invest.** `invest(usdcIn)` works in five steps:

1. Settle any pending fee.
2. Read the current NAV.
3. Split the USDC by weight and buy each stock at the **buy** price.
4. Measure how much NAV rose, valued at **mid**.
5. Mint shares for that rise only: `shares = NAV increase × supply / NAV before`.

The spread never touches existing holders. Example: Alice puts **1000 USDC** into BCHIP today.

```
Stocks she brings in, valued at mid : 1000 / 1.005 ≈ 995.02 USDC
Shares she gets                     : 995.02 × 4.975123 / 4.975123 ≈ 995.02 shares
NAV after                           : 4.975 + 995.02 = 1000.00 USDC
NAV per share after                 : still 1.0000
```

Compare a naive design that mints shares on the USDC paid in. Alice would get 1000 shares for 995.02 of
stock, and NAV per share would fall to ~0.995. Everyone already in the fund would lose 0.5% each time
someone joined. Our contract's `previewInvest(10 USDC)` returns 9.950 shares today, which shows the right
behaviour.

**Redeem.** `redeem(shares)` works in three steps:

1. Burn the shares.
2. Sell the redeemer's pro-rata slice of every stock at the **sell** price.
3. Add their pro-rata slice of idle USDC.

The redeemer gets about NAV × 0.995. The holders who stay keep exactly the same stocks per share, so their
NAV per share does not change.

**Round trip.** `previewRedeem` of BCHIP's whole free supply returns **4.950225 USDC** today, against 5.00 put in.

- That is about 1.0% total: 0.5% in, 0.5% out. Like an ETF's bid/ask cost, it is the price of getting in and out.
- About 0.00002 of it is the creator's own pending fee, so the round trip is really 0.99% + fee.
- The spread USDC stays in the exchange reserve. It funds the exchange's ability to pay out redemptions.

**In-kind deposits.** `investInKind` lets you deposit stock tokens directly. They are valued at **mid**
with no spread, because nothing is bought. The deposit does not have to match the target weights.

### 2.3 Management fee: dilution, not a withdrawal

The fee never takes USDC or stocks out of the fund. Instead, `_accrueFee()` **mints new shares to the
creator**:

```
f          = feeBps × secondsElapsed / (10000 × 365 days)
feeShares  = supply × f / (1 − f)
```

After the mint, the creator owns exactly the fraction *f* of the fund. Fees settle on every invest, every
redeem, and every call to the public `collectFee()`.

**One-year example** (1% fee, flat prices). Take a fund like BCHIP grown to 1000 USDC and 1000 shares:

```
f              = 100 × 365 days / (10000 × 365 days) = 0.01
feeShares      = 1000 × 0.01 / 0.99 = 10.101 shares to the creator
NAV            = 1000 USDC          (unchanged: no money left the fund)
supply         = 1010.101 shares
NAV per share  = 1000 / 1010.101 = 0.9900   (−1.00%)
creator's cut  = 10.101 × 0.99 = 10.00 USDC worth of shares
```

If the fee settles often (say every invest), it compounds very slightly in the holder's favour:
NAV per share ends at e^(−0.01) ≈ 0.99005 instead of 0.99000.

BCHIP right now: 3.68 h have passed since the last accrual, so about **0.0000209** fee shares are pending
(1% × 3.68/8760 × 4.975). The next invest or redeem mints them.

The cap is 2%/yr (`feeBps ≤ 200`), fixed when the fund is created.

### 2.4 Idle USDC

`invest` spends every unit of USDC: the last stock takes the rounding remainder. So idle USDC is normally 0.
Idle USDC appears only if someone sends USDC straight to the fund contract. That raises NAV, and NAV per
share with it, so it is effectively a gift to current holders. On redeem, each holder takes their pro-rata
slice of the idle USDC as cash.

### 2.5 Rounding

All maths floors (rounds down), and always in the fund's or exchange's favour:

- The buy price rounds **up**. Tokens received, the sell proceeds and the shares minted all round **down**.
- `nav()` floors each holding separately. BCHIP's exact value is 4.9751244 USDC; the contract reports 4.975123.
- Redeem floors each stock slice, so the dust stays with the remaining holders.

The scale is millionths of a USDC (1–2 units of the 6th decimal) per operation. It can never be exploited
for profit, because no rounding ever goes in the trader's favour.

---

## 3. Edge cases

**First deposit (supply = 0).**

- NAV per share is defined as **1.00**. The UI shows "The first investment sets the starting NAV at 1.00 USDC per share."
- The first investor gets `value × 1e12` shares (USDC 6 decimals → shares 18 decimals). BCHIP: 4.975123 USDC of stock → 4.975123 shares.
- 1000 wei of those are minted to a dead address and can never move. That blocks the classic "first-depositor
  inflation" trick, where someone mints 1 wei of shares and then donates to make each share huge.
- USDC donated *before* the first deposit is not counted against the first investor; it simply goes to them.

**Zero supply.** `navPerShare()` returns 1.00 instead of dividing by zero, and no fee accrues
(`_pendingFee` returns 0). AICHIP and AIBLD are in this state today: they are created but have no investors.

**Stale price (the freeze rule).** `StockExchange.price()` **reverts** if any price is older than
`maxPriceAge` = 96 h. `nav()`, `invest()` and `redeem()` all read every constituent's price, so one stale stock
freezes the whole fund:

- no deposits;
- no redemptions;
- even `nav()` reverts.

This is deliberate. A fund that refuses to trade is better than one that lets people trade at a wrong price.
96 h covers the US weekend: from Friday close (02:30 IST Sat) to Monday open (20:00 IST Mon) is 65.5 h. The
first CRE report after the open un-freezes everything. No funds are lost; they are just paused.

**Empty exchange inventory.** The exchange sells stocks from its own inventory. These 8 stocks have
**0 inventory** today:

> tNFLX, tAMD, tJPM, tV, tWMT, tKO, tDIS, tORCL

A fund holding any of them can't take cash investments, because `buy` reverts with `InsufficientInventory`.
`previewInvest` still works because it only quotes. The fix is operational: the owner tops up inventory with
bridged tokens. `investInKind` (depositing the stock yourself) still works. Redemptions need USDC in the
reserve (45 USDC today), not stock inventory. The first 8 stocks (tAAPL … tSPY) each have ~10,000 tokens.

**Price cap.** One report can move a stock at most 5%. After a bigger real move (an earnings gap), the
onchain price walks toward Yahoo in 5% steps, one per report (every 5 minutes while the run loop is on). For a short
while NAV lags reality. This limits the damage from a bad or manipulated feed print.

**Holding lock.** Newly minted shares are locked for `holdSeconds` (60 s) before they can be redeemed. The
exchange exempts registered funds from its own hold, and BCHIP is registered, so a fund can sell right after
another investor's buy.

---

## 4. Known limitations

**A fund can brick after a full exit (low severity).**

- Supply never returns to 0, because the 1000 dead-address wei stay forever.
- If every real share is redeemed, the leftover holdings are dust, about `balance × 1000 / supply` wei of
  each stock. `nav()` floors each holding to 0 USDC units, so NAV reads 0 while supply is still above 0.
- A new `invest` or `investInKind` then reverts with `ZeroNAV` (`_investmentShares` in `IndexFund.sol`).
- **Workaround:** anyone can send 1e-6 USDC (1 base unit) to the fund. NAV is then above 0 and the next
  investor is priced normally against that dust; they end up owning almost all shares.
- **Possible fix later:** treat `assets == 0 && supply > 0` like a fresh fund.
- There will be no contract change before judging, and the demo does not hit this case.

**Fixed weights, no rebalancing.** Weights apply only to new deposits (section 2.1).

**The exchange is the only venue.** Cash investing depends on the exchange holding stock inventory and
redemptions depend on its USDC reserve (section 3).

---

## 5. Where NAV shows in the app

- `src/pages/Indices.tsx`: the NAV per share column, plus a fund detail page with NAV per share and supply.
- `src/pages/Portfolio.tsx`: your value = shares × NAV per share, at mid. Cashing out returns about 0.5% less.
- Hooks: `src/hooks/data.ts`, which reads `nav`, `navPerShare` and `totalSupply` for each fund.

---

## 6. Pitch line for judges

> Every Inphinity fund is an ERC-20 whose NAV is computed onchain from Chainlink CRE stock prices, so anyone
> can verify what a share is worth at any block. Whoever trades pays the spread: new money is credited only for
> the stocks it actually bought at mid price, and the 1% fee is taken as transparent share dilution rather than
> hidden withdrawals. If a price goes stale, the fund freezes instead of mispricing, so NAV per share only ever
> moves because the stocks moved.
