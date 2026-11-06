// The tokenized stocks Inphinity knows about. Each is a Circle CCTPx cross-chain token with the
// same address on Base Sepolia and Arc. `listing` is the price it was listed at (the baseline
// for the change column). A future stock can be added without token/tokenId until it is deployed.
export type StockInfo = {
  symbol: string
  company: string
  listing: number
  token?: `0x${string}`
  tokenId?: `0x${string}`
}

export const STOCK_CATALOG: StockInfo[] = [
  { symbol: 'tAAPL', company: 'Apple Inc.', listing: 344.17, token: '0x4572E4D21199deA83a5E069361871512c31a3bBd', tokenId: '0x1b74494bb815db7ea0cf94909db07a2ec21f109fae6fbd3276f31b0d72092ef4' },
  { symbol: 'tMSFT', company: 'Microsoft Corp.', listing: 535.93, token: '0xeFde44E09DDDc17d169760FC3922b55BEda7a53B', tokenId: '0x39afcc0d3dd1bf27fb4fc1c9a717612a0a5e2324224f6954e2b6558da0033c64' },
  { symbol: 'tNVDA', company: 'NVIDIA Corp.', listing: 181.6, token: '0x5263E1f5A05e6b3F733fA401042c6F9f4a09464f', tokenId: '0x9ab5edaaea24e9523d025fcdafb9ebd33c8c5ff8d37864a4b379e8fba2d69eba' },
  { symbol: 'tTSLA', company: 'Tesla Inc.', listing: 343.69, token: '0xA6128ee533f73a1CF116a752a2cf65e20134F1D0', tokenId: '0xe42e7f910eb5f821cc627e741cd5b65a8e6220e5e4066867e4496c6de413090d' },
  { symbol: 'tAMZN', company: 'Amazon.com Inc.', listing: 260.21, token: '0x4e297D91F5622c129fE926b197795B5d3124316C', tokenId: '0x10b72a0de5d4c460fc4fe05ddb4ddb6e3985a98dc051ac8a2e363f9ef7573e40' },
  { symbol: 'tGOOGL', company: 'Alphabet Inc. Cl A', listing: 282.57, token: '0xc9e364b45DEb73de694c7d97eF189A99013029dB', tokenId: '0x86d53a65b0623b4c2f7361b46582d6c94648290396c6c849bf1aea92894ad976' },
  { symbol: 'tMETA', company: 'Meta Platforms Inc.', listing: 605.08, token: '0xC382598902b4bfBE61aC085EF3c7334EDb6917BB', tokenId: '0x43fd17f5b0e844c7ad50469e85ec4ff286dd2d8239251951ab7fdbe3c209bcad' },
  { symbol: 'tSPY', company: 'SPDR S&P 500 ETF', listing: 733.0, token: '0x6a915806B8CE8545C4701CC041B1077Db5274f48', tokenId: '0xc91fad91315f1e16ddd6862f0789bf60e4fe0ab9c81b556719568575b7c52d8d' },
  // Second batch, issued 6 Nov 2026 (listing prices from Yahoo).
  { symbol: 'tNFLX', company: 'Netflix Inc.', listing: 65.56, token: '0xadBdd7e70f38048bEE1Ca1FBa5a1A73f6DD36AEC', tokenId: '0x678035079cc615ca1aa6a61f189461543630aa81b083dbe127c861ef64028502' },
  { symbol: 'tAMD', company: 'Advanced Micro Devices', listing: 404.4, token: '0x95154926e13D5585874483ee7b25Cbe6D226D30F', tokenId: '0xf654972cd32084fb301172c6e00831f1fd40c487f415ec4ec24b69d8c1ac272d' },
  { symbol: 'tJPM', company: 'JPMorgan Chase & Co.', listing: 337.34, token: '0x5F17C5090dE9A5A2FeB5270ac3F9078D3530C744', tokenId: '0xf95476d1451075457c2eecdc77d02fe619b67b654b598b897fff4303dc7fb3ca' },
  { symbol: 'tV', company: 'Visa Inc.', listing: 422.59, token: '0x70076eDE3b4994ABB85ffD36322d563aCdEEEc74', tokenId: '0xa745f74da56696525c5135ca3deff0505384dbcd949e746245610d991b7fac5f' },
  { symbol: 'tWMT', company: 'Walmart Inc.', listing: 127.72, token: '0x56aAccF719d3648dCA20b41809663dB8ce9cE868', tokenId: '0x83010be916955d047d014ebc7940addc1b2a17863f349f8ccd8b281d5ef239b7' },
  { symbol: 'tKO', company: 'The Coca-Cola Co.', listing: 95.73, token: '0xEf9E358F2B415a5b4D13cfe64fc1936dF0f0275b', tokenId: '0xbced77af9782ae7fc5d90f53eeb6b89d60028fefe08ed721ad8fac70aa81ac57' },
  { symbol: 'tDIS', company: 'The Walt Disney Co.', listing: 117.22, token: '0x6C2e16e5e0E309fB0c0E3468E4613454e92c22dF', tokenId: '0x9211627b8c085017ac0bfdec70640db1f5d7d0ee0d095fbccc3d9ba0395b2f96' },
  { symbol: 'tORCL', company: 'Oracle Corp.', listing: 115.16, token: '0xd0C2d2f5288F1BD2527207122Df0696B2B6CFe5B', tokenId: '0x34a8f3ce94d8c54e92811f6f2093517a06bf509ff796805f58d92a9ea7d767ad' },
]

/** Stocks deployed on both chains, so they can be bridged. */
export const BRIDGEABLE = STOCK_CATALOG.filter((s): s is StockInfo & Required<Pick<StockInfo, 'token' | 'tokenId'>> => !!s.token && !!s.tokenId)
