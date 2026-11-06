import fs from 'node:fs';
import { parseArgs } from 'node:util';
import * as kitChains from '@circle-fin/bridge-kit/chains';
import {
  CCTPX_FEE_QUOTE_PATH,
  CCTPX_MESSAGES_PATH,
  NATIVE_FEE_TOKEN,
  createCCTPXTokenRegistryFetcher,
} from '@circle-fin/provider-cctpx';
import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodePacked,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  keccak256,
  maxUint256,
  parseAbi,
  parseEventLogs,
  toBytes,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const IRIS_TESTNET_BASE_URL = 'https://iris-api-sandbox.circle.com';
const KEY_ENV = 'CCTPX_PRIVATE_KEY';
const IRIS_TIMEOUT_MS = 30_000;

const TOKEN_MANAGER_PARAMS =
  '(uint8 tokenManagerType, bytes tokenManagerOwner, bytes tokenManagerOperator, bytes tokenOwner, bytes tokenMinter, (uint256 rateLimit, uint256 maxTransferAmount) tokenManagerSettings)';

export const cctsAbi = parseAbi([
  `function deployCrossChainToken(bytes32 salt, string name, string symbol, uint8 decimals, ${TOKEN_MANAGER_PARAMS} params) payable returns (bytes32)`,
  `function deployRemoteCrossChainToken(bytes32 salt, uint32 destinationDomain, string name, string symbol, uint8 decimals, ${TOKEN_MANAGER_PARAMS} params, (bytes signedQuote, address refundAddress) claim) payable returns (bytes32)`,
  `function registerCustomToken(bytes32 salt, address tokenAddress, ${TOKEN_MANAGER_PARAMS} params) payable returns (bytes32)`,
  'function registerOwnerlessToken(address tokenAddress) payable returns (bytes32)',
  'function deployRemoteOwnerlessToken(address originalTokenAddress, uint32 destinationDomain, (bytes signedQuote, address refundAddress) claim) payable returns (bytes32)',
  'function getOwnerlessTokenId(address tokenAddress) view returns (bytes32)',
  'function isTrustedDomain(uint32 domain) view returns (bool)',
  'function resolveTokenAddress(bytes32 tokenId) view returns (address)',
  'function resolveTokenManager(bytes32 tokenId) view returns (address)',
  'event CrossChainTokenDeployed(bytes32 indexed tokenId, address tokenAddress, string name, string symbol, uint8 decimals)',
  `event CrossChainTokenDeploymentStarted(bytes32 indexed tokenId, uint32 destinationDomain, string name, string symbol, uint8 decimals, ${TOKEN_MANAGER_PARAMS} params)`,
  'event CrossChainTokenIdClaimed(bytes32 indexed tokenId, address indexed tokenAddress, address deployer, bytes32 salt)',
  `event TokenManagerDeployed(bytes32 indexed tokenId, address indexed tokenAddress, address tokenManager, ${TOKEN_MANAGER_PARAMS} params)`,
  'error DecimalsMismatch(uint8 expected, uint8 actual)',
  'error DenylistedAddress(address account)',
  'error EmptyTokenName()',
  'error EmptyTokenSymbol()',
  'error EnforcedPause()',
  'error FieldLengthExceeded(uint32 length, uint32 max)',
  'error InsufficientMsgValue()',
  'error InvalidDecimals()',
  'error InvalidTokenManagerType(uint8 tokenManagerType)',
  'error MessageExpired(uint256 expirationBlock, uint256 currentBlock)',
  'error OwnableUnauthorizedAccount(address account)',
  'error SystemPaused()',
  'error TokenAlreadyRegistered(bytes32 tokenId)',
  'error TokenIdMismatch(bytes32 expected, bytes32 actual)',
  'error TokenNotRegistered(bytes32 tokenId)',
  'error UnexpectedNativePayment(uint256 provided)',
  'error UntrustedDomain(uint32 domain)',
  'error ZeroAddress()',
]);

const tokenManagerAbi = parseAbi([
  'function token() view returns (address)',
  'function tokenManagerType() view returns (uint8)',
  'function rateLimit() view returns (uint256)',
  'function maxTransferAmount() view returns (uint256)',
  'function paused() view returns (bool)',
]);

const TOKEN_MANAGER_TYPES: Record<string, number> = { 'burn-mint': 1, 'lock-unlock': 2 };
const TOKEN_MANAGER_TYPE_NAMES = ['native-crosschain-token', 'burn-mint', 'lock-unlock'];

export interface CctpxChain {
  key: string;
  name: string;
  chainId: number;
  domain: number;
  service: Address;
  rpc: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

interface KitChainShape {
  type?: unknown;
  chain?: unknown;
  name?: unknown;
  chainId?: unknown;
  isTestnet?: unknown;
  rpcEndpoints?: unknown;
  nativeCurrency?: { name: string; symbol: string; decimals: number };
  cctp?: { domain?: unknown };
  cctpx?: { serviceAddress?: unknown };
}

export function listCctpxTestnets(): CctpxChain[] {
  const out: CctpxChain[] = [];
  for (const value of Object.values(kitChains) as unknown[]) {
    if (typeof value !== 'object' || value === null) continue;
    const c = value as KitChainShape;
    if (c.type !== 'evm' || c.isTestnet !== true || typeof c.chain !== 'string') continue;
    const service = c.cctpx?.serviceAddress;
    const domain = c.cctp?.domain;
    const rpcs = c.rpcEndpoints;
    if (typeof service !== 'string' || !isAddress(service) || typeof domain !== 'number') continue;
    if (!Array.isArray(rpcs) || typeof rpcs[0] !== 'string' || typeof c.chainId !== 'number' || !c.nativeCurrency) continue;
    out.push({
      key: c.chain,
      name: typeof c.name === 'string' ? c.name : c.chain,
      chainId: c.chainId,
      domain,
      service: getAddress(service),
      rpc: rpcs[0],
      nativeCurrency: c.nativeCurrency,
    });
  }
  return out;
}

export function resolveChain(key: string | undefined, flag: string): CctpxChain {
  if (!key) throw new Error(`Missing --${flag} <chain key>, e.g. Arc_Testnet`);
  const chains = listCctpxTestnets();
  const found = chains.find((c) => c.key === key);
  if (!found) {
    throw new Error(
      `--${flag} ${key} is not a CCTPx testnet. Supported: ${chains.map((c) => c.key).join(', ')}. Mainnet is not supported.`,
    );
  }
  return found;
}

const PREFIX_CUSTOM_TOKEN_SALT = keccak256(toBytes('circle-cctpx-custom-token-salt'));
const PREFIX_CROSS_CHAIN_TOKEN_ID = keccak256(toBytes('circle-cctpx-cross-chain-token-id'));
const SALT_TYPES = [{ type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }] as const;

export function deriveTokenId(signer: Address, salt: Hex): Hex {
  const deploySalt = keccak256(encodeAbiParameters(SALT_TYPES, [PREFIX_CUSTOM_TOKEN_SALT, signer, salt]));
  return keccak256(encodeAbiParameters(SALT_TYPES, [PREFIX_CROSS_CHAIN_TOKEN_ID, signer, deploySalt]));
}

export function requireBytes32(value: string | undefined, flag: string): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`--${flag} must be a 0x-prefixed 32-byte hex value`);
  return value as Hex;
}

export function requireAddress(value: string | undefined, flag: string): Address {
  if (!value || !isAddress(value)) throw new Error(`--${flag} must be an address`);
  return getAddress(value);
}

export function parseLimit(value: string | undefined, flag: string): bigint {
  if (value === undefined || value === 'max') return maxUint256;
  if (!/^\d+$/.test(value)) throw new Error(`--${flag} must be a non-negative integer in token base units, or "max"`);
  return BigInt(value);
}

function ownerBytes(value: string | undefined, flag: string, fallback: Address): Hex {
  return encodePacked(['address'], [value === undefined ? fallback : requireAddress(value, flag)]);
}

function optionalAddress(value: string | undefined, flag: string): Hex {
  return value === undefined ? '0x' : encodePacked(['address'], [requireAddress(value, flag)]);
}

export function minterBytes(value: string | undefined, signer: Address): Hex {
  if (value !== undefined && requireAddress(value, 'minter').toLowerCase() === signer.toLowerCase()) {
    throw new Error("--minter must be the user's wallet, not the signer: the sandbox key must never be able to mint");
  }
  return optionalAddress(value, 'minter');
}

function loadSigner() {
  const key = process.env[KEY_ENV];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${KEY_ENV} is missing from .env. Run: bun scripts/cctpx.ts init-key`);
  }
  return privateKeyToAccount(key as Hex);
}

function clients(chain: CctpxChain, rpcOverride: string | undefined) {
  const rpc = rpcOverride ?? chain.rpc;
  const viemChain = defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [rpc] } },
  });
  return {
    publicClient: createPublicClient({ chain: viemChain, transport: http(rpc) }),
    viemChain,
    rpc,
  };
}

type WriteFunction =
  | 'deployCrossChainToken'
  | 'deployRemoteCrossChainToken'
  | 'registerCustomToken'
  | 'registerOwnerlessToken'
  | 'deployRemoteOwnerlessToken';

async function writeAndWait(
  chain: CctpxChain,
  rpc: string | undefined,
  request: { functionName: WriteFunction; args: readonly unknown[]; value?: bigint },
) {
  const account = loadSigner();
  const { publicClient, viemChain, rpc: url } = clients(chain, rpc);
  const { result, request: simulated } = await publicClient.simulateContract({
    address: chain.service,
    abi: cctsAbi,
    functionName: request.functionName,
    args: request.args as never,
    value: request.value,
    account,
  });
  const walletClient = createWalletClient({ account, chain: viemChain, transport: http(url) });
  const txHash = await walletClient.writeContract(simulated);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`Transaction ${txHash} reverted`);
  return { tokenId: result, txHash, receipt };
}

function eventArgs(receipt: { logs: Parameters<typeof parseEventLogs>[0]['logs'] }) {
  const logs = parseEventLogs({ abi: cctsAbi, logs: receipt.logs });
  const deployed = logs.find((l) => l.eventName === 'CrossChainTokenDeployed');
  const manager = logs.find((l) => l.eventName === 'TokenManagerDeployed');
  return {
    tokenAddress: deployed?.eventName === 'CrossChainTokenDeployed' ? deployed.args.tokenAddress : undefined,
    tokenManager: manager?.eventName === 'TokenManagerDeployed' ? manager.args.tokenManager : undefined,
  };
}

async function deployFeeQuote(tokenId: Hex, source: CctpxChain, dest: CctpxChain) {
  const path = CCTPX_FEE_QUOTE_PATH.replace('{tokenId}', tokenId)
    .replace('{sourceDomain}', String(source.domain))
    .replace('{destinationDomain}', String(dest.domain));
  const res = await fetch(`${IRIS_TESTNET_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(IRIS_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: '1',
      feeToken: NATIVE_FEE_TOKEN,
      requests: [{ type: 'FORWARD', params: { msgType: 'DeployTokenMessage' } }],
    }),
  });
  if (!res.ok) {
    throw new Error(`IRIS deploy fee quote failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { signedQuote?: unknown; feeTotalAmount?: unknown };
  if (typeof body.signedQuote !== 'string' || typeof body.feeTotalAmount !== 'string') {
    throw new Error('IRIS deploy fee quote response is missing signedQuote or feeTotalAmount');
  }
  return { signedQuote: body.signedQuote as Hex, fee: BigInt(body.feeTotalAmount) };
}

async function requireTrusted(source: CctpxChain, dest: CctpxChain, rpc: string | undefined) {
  if (source.key === dest.key) throw new Error('--dest-chain must differ from --chain');
  const { publicClient } = clients(source, rpc);
  const trusted = await publicClient.readContract({
    address: source.service,
    abi: cctsAbi,
    functionName: 'isTrustedDomain',
    args: [dest.domain],
  });
  if (!trusted) {
    throw new Error(`${dest.key} (domain ${dest.domain}) is not trusted by the ${source.key} CCTS; pick another destination`);
  }
}

function isTokenNotRegistered(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'TokenNotRegistered';
}

async function readState(chain: CctpxChain, tokenId: Hex, rpc: string | undefined) {
  const { publicClient } = clients(chain, rpc);
  const manager = await publicClient
    .readContract({
      address: chain.service,
      abi: cctsAbi,
      functionName: 'resolveTokenManager',
      args: [tokenId],
    })
    .catch((error: unknown) => {
      if (isTokenNotRegistered(error)) return zeroAddress;
      throw error;
    });
  if (manager === zeroAddress) return { chain: chain.key, tokenId, registered: false as const };
  const [tokenAddress, type, rateLimit, maxTransferAmount, paused] = await Promise.all([
    publicClient.readContract({ address: manager, abi: tokenManagerAbi, functionName: 'token' }),
    publicClient.readContract({ address: manager, abi: tokenManagerAbi, functionName: 'tokenManagerType' }),
    publicClient.readContract({ address: manager, abi: tokenManagerAbi, functionName: 'rateLimit' }),
    publicClient.readContract({ address: manager, abi: tokenManagerAbi, functionName: 'maxTransferAmount' }),
    publicClient.readContract({ address: manager, abi: tokenManagerAbi, functionName: 'paused' }),
  ]);
  const [symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'totalSupply' }),
  ]);
  return {
    chain: chain.key,
    tokenId,
    registered: true as const,
    tokenAddress,
    tokenManager: manager,
    tokenManagerType: TOKEN_MANAGER_TYPE_NAMES[type] ?? String(type),
    rateLimit,
    maxTransferAmount,
    paused,
    symbol,
    decimals,
    totalSupply,
  };
}

function initKey(): { address: Address; created: boolean } {
  const envPath = '.env';
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = new RegExp(`^${KEY_ENV}=(.*)$`, 'm').exec(existing);
  if (line) {
    const value = line[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error(`${KEY_ENV} in .env is not a 0x-prefixed 32-byte key; fix that line instead of creating a new key`);
    }
    return { address: privateKeyToAccount(value as Hex).address, created: false };
  }
  const key = generatePrivateKey();
  fs.appendFileSync(envPath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${KEY_ENV}=${key}\n`);
  return { address: privateKeyToAccount(key).address, created: true };
}

function managerParams(
  flag: (name: string) => string | undefined,
  tokenManagerType: number,
  owners: { tokenManagerOwner: Hex; tokenOwner: Hex },
  tokenMinter: Hex = '0x',
) {
  return {
    tokenManagerType,
    ...owners,
    tokenManagerOperator: optionalAddress(flag('operator'), 'operator'),
    tokenMinter,
    tokenManagerSettings: {
      rateLimit: parseLimit(flag('rate-limit'), 'rate-limit'),
      maxTransferAmount: parseLimit(flag('max-transfer-amount'), 'max-transfer-amount'),
    },
  };
}

const FLAGS = [
  'chain',
  'dest-chain',
  'rpc',
  'name',
  'symbol',
  'decimals',
  'salt',
  'owner',
  'manager-owner',
  'operator',
  'minter',
  'rate-limit',
  'max-transfer-amount',
  'token',
  'type',
  'token-id',
  'tx',
  'timeout-seconds',
] as const;

const USAGE = `usage: bun scripts/cctpx.ts <command> [flags]
  init-key                                   create ${KEY_ENV} in .env once and print the signer address
  signer                                     print the signer address
  new-salt                                   print a fresh 32-byte salt
  chains                                     list CCTPx testnets (chain key, CCTP domain)
  list-tokens [--symbol S]                   tokens registered with CCTPx (IRIS registry)
  trusted --chain C --dest-chain D           check that D is trusted by the CCTS on C
  deploy-token --chain C --name N --symbol S --decimals 0-18 --salt X
               [--owner A] [--manager-owner A] [--minter A] [--operator A] [--rate-limit n|max] [--max-transfer-amount n|max]
  deploy-remote-token --chain C --dest-chain D --salt X [--name N] [--symbol S]
               [--owner A] [--manager-owner A] [--operator A] [--rate-limit n|max] [--max-transfer-amount n|max]
  register-custom-token --chain C --token A --salt X --manager-owner A --type burn-mint|lock-unlock
               [--operator A] [--rate-limit n|max] [--max-transfer-amount n|max]
  register-ownerless-token --chain C --token A
  deploy-remote-ownerless-token --chain C --dest-chain D --token A
  state --chain C --token-id X               token and TokenManager state for a tokenId
  status --chain C --tx H                    IRIS attestation and forward state of a remote deploy
  wait-remote --dest-chain D --token-id X [--timeout-seconds 900]
                                             wait until the remote token is deployed
Every command accepts --rpc <url>. Testnet only.`;

export async function main(argv: string[]): Promise<unknown> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: Object.fromEntries(FLAGS.map((name) => [name, { type: 'string' as const }])),
  });
  const flag = (name: string): string | undefined => {
    const value = values[name];
    return typeof value === 'string' ? value : undefined;
  };
  const rpc = flag('rpc');
  if (flag('minter') !== undefined && command !== 'deploy-token') {
    throw new Error('--minter applies only to deploy-token; other chains get supply by bridging from the home chain');
  }

  switch (command) {
    case undefined:
    case 'help':
      return USAGE;
    case 'init-key':
      return initKey();
    case 'signer':
      return { address: loadSigner().address };
    case 'new-salt':
      return { salt: generatePrivateKey() };
    case 'chains':
      return listCctpxTestnets().map(({ key, name, domain }) => ({ key, name, domain }));
    case 'list-tokens': {
      const { tokens } = await createCCTPXTokenRegistryFetcher({ baseUrl: IRIS_TESTNET_BASE_URL }).refresh();
      const symbol = flag('symbol')?.toLowerCase();
      return symbol ? tokens.filter((t) => t.symbol.toLowerCase() === symbol) : { count: tokens.length };
    }
    case 'trusted': {
      const source = resolveChain(flag('chain'), 'chain');
      const dest = resolveChain(flag('dest-chain'), 'dest-chain');
      await requireTrusted(source, dest, rpc);
      return { source: source.key, dest: dest.key, destDomain: dest.domain, trusted: true };
    }
    case 'deploy-token': {
      const chain = resolveChain(flag('chain'), 'chain');
      const signer = loadSigner().address;
      const decimals = Number(flag('decimals'));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('--decimals must be 0-18');
      const name = flag('name');
      const symbol = flag('symbol');
      if (!name || !symbol) throw new Error('--name and --symbol are required');
      const params = managerParams(
        flag,
        0,
        {
          tokenManagerOwner: ownerBytes(flag('manager-owner'), 'manager-owner', signer),
          tokenOwner: ownerBytes(flag('owner'), 'owner', signer),
        },
        minterBytes(flag('minter'), signer),
      );
      const { tokenId, txHash, receipt } = await writeAndWait(chain, rpc, {
        functionName: 'deployCrossChainToken',
        args: [requireBytes32(flag('salt'), 'salt'), name, symbol, decimals, params],
      });
      const minter = flag('minter');
      return {
        chain: chain.key,
        tokenId,
        txHash,
        signer,
        minter: minter === undefined ? null : requireAddress(minter, 'minter'),
        ...eventArgs(receipt),
      };
    }
    case 'deploy-remote-token': {
      const source = resolveChain(flag('chain'), 'chain');
      const dest = resolveChain(flag('dest-chain'), 'dest-chain');
      const signer = loadSigner().address;
      const salt = requireBytes32(flag('salt'), 'salt');
      const tokenId = deriveTokenId(signer, salt);
      const home = await readState(source, tokenId, rpc);
      if (!home.registered) {
        throw new Error(
          `No token for this signer and salt on ${source.key} (tokenId ${tokenId}); run deploy-token there first with the same --salt`,
        );
      }
      await requireTrusted(source, dest, rpc);
      const { signedQuote, fee } = await deployFeeQuote(tokenId, source, dest);
      const params = managerParams(flag, 0, {
        tokenManagerOwner: ownerBytes(flag('manager-owner'), 'manager-owner', signer),
        tokenOwner: ownerBytes(flag('owner'), 'owner', signer),
      });
      const { txHash } = await writeAndWait(source, rpc, {
        functionName: 'deployRemoteCrossChainToken',
        args: [
          salt,
          dest.domain,
          flag('name') ?? '',
          flag('symbol') ?? '',
          home.decimals,
          params,
          { signedQuote, refundAddress: signer },
        ],
        value: fee,
      });
      return {
        source: source.key,
        dest: dest.key,
        tokenId,
        txHash,
        feePaid: fee,
        next: `bun scripts/cctpx.ts wait-remote --dest-chain ${dest.key} --token-id ${tokenId}`,
      };
    }
    case 'register-custom-token': {
      const chain = resolveChain(flag('chain'), 'chain');
      const tokenManagerType = TOKEN_MANAGER_TYPES[flag('type') ?? ''];
      if (tokenManagerType === undefined) {
        throw new Error(
          '--type is required: lock-unlock (token unchanged) or burn-mint (token must let the TokenManager mint and burn)',
        );
      }
      const params = managerParams(flag, tokenManagerType, {
        tokenManagerOwner: encodePacked(['address'], [requireAddress(flag('manager-owner'), 'manager-owner')]),
        tokenOwner: '0x',
      });
      const { tokenId, txHash, receipt } = await writeAndWait(chain, rpc, {
        functionName: 'registerCustomToken',
        args: [requireBytes32(flag('salt'), 'salt'), requireAddress(flag('token'), 'token'), params],
      });
      return { chain: chain.key, tokenId, txHash, ...eventArgs(receipt) };
    }
    case 'register-ownerless-token': {
      const chain = resolveChain(flag('chain'), 'chain');
      const { tokenId, txHash, receipt } = await writeAndWait(chain, rpc, {
        functionName: 'registerOwnerlessToken',
        args: [requireAddress(flag('token'), 'token')],
      });
      return { chain: chain.key, tokenId, txHash, ...eventArgs(receipt) };
    }
    case 'deploy-remote-ownerless-token': {
      const source = resolveChain(flag('chain'), 'chain');
      const dest = resolveChain(flag('dest-chain'), 'dest-chain');
      const token = requireAddress(flag('token'), 'token');
      const { publicClient } = clients(source, rpc);
      const tokenId = await publicClient.readContract({
        address: source.service,
        abi: cctsAbi,
        functionName: 'getOwnerlessTokenId',
        args: [token],
      });
      if (!(await readState(source, tokenId, rpc)).registered) {
        throw new Error(`${token} is not registered as ownerless on ${source.key}; run register-ownerless-token there first`);
      }
      await requireTrusted(source, dest, rpc);
      const { signedQuote, fee } = await deployFeeQuote(tokenId, source, dest);
      const { txHash } = await writeAndWait(source, rpc, {
        functionName: 'deployRemoteOwnerlessToken',
        args: [token, dest.domain, { signedQuote, refundAddress: loadSigner().address }],
        value: fee,
      });
      return {
        source: source.key,
        dest: dest.key,
        tokenId,
        txHash,
        feePaid: fee,
        next: `bun scripts/cctpx.ts wait-remote --dest-chain ${dest.key} --token-id ${tokenId}`,
      };
    }
    case 'state':
      return readState(resolveChain(flag('chain'), 'chain'), requireBytes32(flag('token-id'), 'token-id'), rpc);
    case 'status': {
      const chain = resolveChain(flag('chain'), 'chain');
      const tx = requireBytes32(flag('tx'), 'tx');
      const path = CCTPX_MESSAGES_PATH.replace('{sourceDomain}', String(chain.domain));
      const res = await fetch(`${IRIS_TESTNET_BASE_URL}${path}?transactionHash=${tx}`, {
        signal: AbortSignal.timeout(IRIS_TIMEOUT_MS),
      });
      if (res.status === 404) return { tx, indexed: false, note: 'IRIS has not indexed this transaction yet' };
      if (!res.ok) throw new Error(`IRIS message status failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
      const { messages } = (await res.json()) as { messages?: Record<string, unknown>[] };
      return (messages ?? []).map(({ status, forwardState, forwardTxHash, forwardErrorCode }) => ({
        status,
        forwardState,
        forwardTxHash,
        forwardErrorCode,
      }));
    }
    case 'wait-remote': {
      const dest = resolveChain(flag('dest-chain'), 'dest-chain');
      const tokenId = requireBytes32(flag('token-id'), 'token-id');
      const timeoutSeconds = flag('timeout-seconds') ?? '900';
      if (!/^[1-9]\d*$/.test(timeoutSeconds)) throw new Error('--timeout-seconds must be a positive integer');
      const deadline = Date.now() + Number(timeoutSeconds) * 1000;
      for (;;) {
        const state = await readState(dest, tokenId, rpc);
        if (state.registered) return state;
        if (Date.now() > deadline) {
          throw new Error(`${tokenId} is still not deployed on ${dest.key}; check the source tx with the status command`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
    default:
      throw new Error(`Unknown command ${command}. Run: bun scripts/cctpx.ts help`);
  }
}

function explain(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
      return `reverted with ${reverted.data.errorName}(${(reverted.data.args ?? []).map(String).join(', ')})`;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

if ((import.meta as unknown as { main?: boolean }).main === true) {
  main(process.argv.slice(2))
    .then((result) =>
      console.log(
        typeof result === 'string'
          ? result
          : JSON.stringify(result, (_key: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v), 2),
      ),
    )
    .catch((error: unknown) => {
      console.error(`error: ${explain(error)}`);
      process.exit(1);
    });
}
