# NAV brainstorm (Ramit × NAV explainer, 6 Nov 2026)

Q&A notes from the session that produced `docs/NAV.md`. Live numbers are from Arc Testnet block 71045188
(20:18 IST / 14:48 UTC), fund **BCHIP** `0x9272a103f49399d1b7FD538f7a5103E11080895A`.

---

## Q1. "So NAV is not based on buy and sell. It's redemption and holdings, and it rises with the base assets?"

Yes.

- The fund's value is **holdings × mid price** (the Chainlink CRE price with no spread), plus any idle USDC.
- The fund's own buying and selling never sets the price. The exchange always trades at mid ± 0.5%, and the
  mid comes only from the feed.
- **Invest and redeem** change the fund's size, but not the value of one share. The trader pays the 0.5%
  spread themselves, by getting fewer shares or less USDC.
- **Only the stocks moving** changes the value of one share. If tNVDA rises 5% and is 25% of the fund, one
  share is worth 1.25% more: 1.00 → 1.0125.
- Two small extras: the **1% management fee** lowers per-share value about 1% a year, through dilution.
  **USDC sent straight to the fund** raises it slightly, like a gift to holders.

## Q2. "If Alice puts 1000 USDC into BCHIP, how does the fund grow from ~5 to ~1000 while one share stays at 1.00?"

**Before:** stocks worth 4.975 USDC, 4.975 shares, so one share = **1.00**.

**Step 1: the fund buys stocks with her 1000 USDC** at the buy price (mid + 0.5%):

| Stock | USDC spent | Worth at mid |
|---|---|---|
| tAAPL (30%) | 300 | 298.51 |
| tMSFT (25%) | 250 | 248.76 |
| tNVDA (25%) | 250 | 248.76 |
| tGOOGL (20%) | 200 | 199.00 |
| **Total** | **1000** | **995.02** |

The 4.98 gap is the spread, and it stays with the exchange.

**Step 2: the fund measures its growth.** It was worth 4.975 and is now worth 1000.00, an increase of 995.02.

**Step 3: the fund mints shares for that increase only.**

`new shares = increase × shares before ÷ value before = 995.02 × 4.975 ÷ 4.975 = 995.02`

**After:** the fund is worth 1000.00 across 1000.00 shares, so one share is still **1.00**.

- The first investor still has 4.975 USDC worth of shares.
- Alice has 995.02 USDC worth, which is exactly what her money bought.

**The wrong way.** Suppose the fund gave Alice 1000 shares for her 1000 USDC. There would be 1004.975 shares
over 1000 USDC of stock, so one share would be worth **0.995**. Every existing holder would lose 0.5%,
paying Alice's spread for her.

**Analogy.** A bag of fruit worth ₹100 is split into 100 tokens, so each token is worth ₹1.

- You bring ₹1000. After market fees, you add ₹995 of fruit.
- You get 995 tokens.
- The bag is now worth ₹1095 across 1095 tokens, so each token is still worth ₹1.
- Money makes the bag bigger. Only pricier fruit makes each token more valuable.

## Q3. "I think it's not NAV, it's AUM that increases."

Correct in fund-industry terms, and especially in Indian mutual-fund terms. We adopted this naming:

| Term | Meaning | Contract | BCHIP before → after Alice |
|---|---|---|---|
| **AUM** | Total value of everything the fund holds | `nav()` | 4.975 → 1000.00 USDC |
| **NAV** | Price of one share/unit | `navPerShare()` | 1.00 → 1.00 |

Formally, NAV means assets minus liabilities. Our funds have no liabilities, so the contract's `nav()` equals
AUM. But "the NAV went up" in mutual-fund speak means the per-unit price.

**The rule:**

- Money in or out changes **AUM**.
- Only stock prices (and the fee) change **NAV**.

| Event | AUM | NAV |
|---|---|---|
| Alice invests 1000 USDC | 4.975 → 1000 | 1.00 → 1.00 |
| tNVDA +5% | +1.25% | 1.00 → 1.0125 |
| One year of the 1% fee | unchanged | 1.00 → 0.99 |

**Follow-ups:**

- `docs/NAV.md` (PR #14) now uses AUM and NAV throughout.
- UI: label `nav()` as "AUM" or "Fund size" wherever it appears. The fund list already says "NAV / share".
- Pitch: "New money grows AUM, never NAV. NAV only moves when the stocks move."

---

## Findings from the same session

- **ZeroNAV after everyone exits (low severity).** A fund can end up with AUM = 0 while 1000 dead-address wei
  of supply remain, so `invest` reverts. Sending 1e-6 USDC to the fund revives it. This is listed under
  Known limitations in NAV.md, with no contract change before judging.
- **tORCL not priced: retracted.** The `feat/cre` workflow updates the 15 stalest prices first. tORCL only
  lost a tie-break on the first report.
- **Copy fix needed:** `src/pages/Indices.tsx:61` says NAV uses the "sell price". It uses the **mid** price.
