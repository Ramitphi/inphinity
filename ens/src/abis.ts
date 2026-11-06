// Minimal ABIs for the live ENSv2 Sepolia contracts and Inphinity's Arc contracts.
// Signatures checked against contracts-v2 branch deploy/mainnet-v2-20261002, deployments/sepolia/*.json.
import { parseAbi } from "viem";

export const ethRegistrarAbi = parseAbi([
  "function commit(bytes32 commitment)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function commitmentAt(bytes32 commitment) view returns (uint64)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function MAX_COMMITMENT_AGE() view returns (uint64)",
  "function MIN_REGISTER_DURATION() view returns (uint64)",
  "function rentPriceOracle() view returns (address)",
  "error NameNotAvailable(string label)",
  "error DurationTooShort(uint64 duration, uint64 minDuration)",
  "error CommitmentTooNew(bytes32 commitment, uint64 validFrom, uint64 blockTimestamp)",
  "error CommitmentTooOld(bytes32 commitment, uint64 validTo, uint64 blockTimestamp)",
  "error UnexpiredCommitmentExists(bytes32 commitment)",
  "error PaymentTokenNotSupported(address paymentToken)",
]);

export const rentPriceOracleAbi = parseAbi(["function isPaymentToken(address paymentToken) view returns (bool)"]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);

/** PermissionedRegistry: the .eth registry and our UserRegistry proxy. */
export const registryAbi = parseAbi([
  "struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }",
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants)",
  "function getState(uint256 anyId) view returns (State)",
  "function getResolver(string label) view returns (address)",
  "function getSubregistry(string label) view returns (address)",
  "function getParent() view returns (address parent, string label)",
  "function getOwner(uint256 anyId) view returns (address)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId)",
  "function setSubregistry(uint256 anyId, address registry)",
  "function setResolver(uint256 anyId, address resolver)",
  "function setParent(address parent, string label)",
  "function renew(uint256 anyId, uint64 newExpiry)",
  "function roles(uint256 anyId, address account) view returns (uint256)",
  "function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)",
  "function isEmancipated() view returns (bool)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
  "function unsafeTransfer(address to, uint256 tokenId, bytes data)",
  "error LabelAlreadyRegistered(string label)",
  "error LabelAlreadyReserved(string label)",
  "error TransferDisallowed(uint256 tokenId, address from)",
  "error TransferUnsafeUntilRegistryIsEmancipated()",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)",
]);

export const verifiableFactoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)",
  "function predictProxyAddress(address deployer, uint256 salt) view returns (address proxy)",
  "function verifyContract(address proxy) view returns (address implementation)",
]);

/** PermissionedResolver (live): setters take a DNS-encoded name; names can share one record. */
export const permissionedResolverAbi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants, bytes[] calls)",
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function linkToNode(bytes sourceName, bytes32 targetNode)",
  "function linkToRecord(bytes sourceName, uint256 recordId)",
  "function getRecordId(bytes32 node) view returns (uint256)",
  "function getRecordCount() view returns (uint256)",
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function multicall(bytes[] calls) returns (bytes[] results)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error InvalidRecord()",
]);

/** Resolver profile functions, used to build `resolve(name, data)` calldata. */
export const profileAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
]);

export const indexFactoryAbi = parseAbi([
  "event IndexCreated(address indexed fund, address indexed creator, string name, string symbol, string label)",
  "function indexCount() view returns (uint256)",
  "function indexAt(uint256 index) view returns (address)",
]);

export const indexFundAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function creator() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function getTokens() view returns (address[])",
  "function getWeights() view returns (uint16[])",
]);

export const erc20MetaAbi = parseAbi(["function symbol() view returns (string)"]);
