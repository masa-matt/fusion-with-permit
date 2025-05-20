const fusionSDK = require("@1inch/fusion-sdk");
const { ethers } = require("ethers");
const {
  Eip2612PermitUtils,
  PrivateKeyProviderConnector,
} = require("@1inch/permit-signed-approvals-utils");

const ERC20ABI = [
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
  "function nonces(address owner) external view returns (uint256)",
  "function DOMAIN_SEPARATOR() external view returns (bytes32)",
  "function name() external view returns (string)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

let getPrivateKey;
try {
  // Attempt to import getPrivateKey from keyHandler.js
  ({ getPrivateKey } = require("./keyHandler"));
} catch (err) {
  console.warn(
    "keyHandler.js not found. Ensure you provide the private key manually.",
  );
}

let getApiKey;
try {
  // Attempt to import getApiKey from keyHandler.js
  ({ getApiKey } = require("./keyHandler"));
} catch (err) {
  console.warn(
    "keyHandler.js not found. Ensure you provide the api key manually.",
  );
}

Error.stackTraceLimit = Infinity; // Set stack trace limit to Infinity

// used to convert BigInt values to strings for JSON serialization
const transformBigInts = (obj) =>
  typeof obj === "bigint"
    ? obj.toString()
    : Array.isArray(obj)
      ? obj.map(transformBigInts)
      : obj && typeof obj === "object"
        ? Object.fromEntries(
            Object.entries(obj).map(([k, v]) => [k, transformBigInts(v)]),
          )
        : obj;
// used to convert ethers v5 BigNumber objects to BigInt
const convertToBigInt = (obj) =>
  typeof obj !== "object" || obj === null
    ? obj
    : Array.isArray(obj)
      ? obj.map(convertToBigInt)
      : obj._hex && (obj._isBigNumber || typeof obj.toHexString === "function")
        ? (() => {
            try {
              return BigInt(
                typeof obj.toHexString === "function"
                  ? obj.toHexString()
                  : obj._hex,
              );
            } catch (e) {
              console.warn("Failed to convert object to BigInt:", obj, e);
              return obj;
            }
          })()
        : Object.fromEntries(
            Object.entries(obj).map(([k, v]) => [k, convertToBigInt(v)]),
          );

Error.stackTraceLimit = Infinity; // Set stack trace limit to Infinity

const chainId = 137; // Polygon mainnet
const ONE_INCH_ROUTER = "0x111111125421ca6dc452d289314280a0f8842a65";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // USDC on polygon
const dai = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063"; // Dai on polygon
const VALUE = "5000000";

async function restOfLogic(pkey, apikey) {
  const ethersRpcProvider = new ethers.JsonRpcProvider(
    "https://polygon-rpc.com",
  );
  const wallet = new ethers.Wallet(pkey, ethersRpcProvider);
  console.log("Wallet address:", wallet.address);
  const ethersProviderConnector = {
    eth: {
      call(transactionConfig) {
        return ethersRpcProvider.call(transactionConfig);
      },
    },
    extend() {},
  };
  const connector = new PrivateKeyProviderConnector(
    pkey,
    ethersProviderConnector,
  );

  const erc20Contract = new ethers.Contract(USDC, ERC20ABI, wallet); // Create contract instance so we can get the nonces of the wallet address
  const name = await erc20Contract.name();
  console.log("Token name:", name);

  const eip2612PermitUtils = new Eip2612PermitUtils(connector);

  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // Set the deadline to 20 minutes from now
  const permitParams = {
    owner: wallet.address,
    spender: ONE_INCH_ROUTER,
    value: VALUE,
    deadline: deadline,
    nonce: await eip2612PermitUtils.getTokenNonce(USDC, wallet.address),
  };
  console.log("Permit params:", permitParams);

  const signature = await eip2612PermitUtils.buildPermitSignature(
    permitParams,
    chainId,
    name,
    USDC,
  );
  console.log("Permit signature", signature);
  // Split the signature into v, r, s
  const vrs = ethers.Signature.from(signature);
  let permitString = "0x";
  permitString += ethers.zeroPadValue(permitParams.owner, 32).replace("0x", "");
  permitString += ethers
    .zeroPadValue(permitParams.spender, 32)
    .replace("0x", "");
  permitString += ethers
    .zeroPadValue(ethers.toUtf8Bytes(permitParams.value), 32)
    .replace("0x", "");
  permitString += ethers
    .zeroPadValue(ethers.toUtf8Bytes(permitParams.deadline.toString()), 32)
    .replace("0x", "");
  permitString += ethers
    .zeroPadValue(ethers.toUtf8Bytes(vrs.v.toString()), 32)
    .replace("0x", "");
  permitString += vrs.r.toString().replace("0x", ""); // r and s are already 32 bytes long
  permitString += vrs.s.toString().replace("0x", ""); // r and s are already 32 bytes long
  console.log("Permit string:", permitString);

  const fusionOrderParams = {
    amount: VALUE,
    fromTokenAddress: USDC,
    toTokenAddress: dai,
    walletAddress: wallet.address,
    permit: permitString,
    isPermit2: false,
    enableEstimate: true,
  };
  console.log("Fusion order params:", fusionOrderParams);

  const sdk = new fusionSDK.FusionSDK({
    blockchainProvider: connector,
    url: "https://api.1inch.dev/fusion", // base URL
    network: chainId, // Ethereum mainnet
    authKey: apikey, // auth key
  });

  const { order, hash, quoteId } = await sdk.createOrder(fusionOrderParams);

  // log the order as a single line because we don't need it formatted
  console.log(`Order: ${JSON.stringify(transformBigInts(order))}`);
  console.log(`OrderHash: ${hash}`);
  console.log(`QuoteId: ${quoteId}`);

  const orderStruct = order.build();
  const typedData = order.getTypedData(chainId);

  // Sign using the correct domain, types, and message (value)
  const orderSignature = await wallet.signTypedData(
    typedData.domain,
    { Order: typedData.types["Order"] },
    typedData.message, // Use the original message; ethers handles BigInts here
  );

  const body = {
    order: orderStruct,
    signature: orderSignature,
    quoteId: quoteId,
    extension: order.extension.encode(),
  };

  console.log(`OrderInfo for API: ${JSON.stringify(transformBigInts(body))}`);
}

(async function main() {
  let pkey = "";
  let apikey = "";

  try {
    if (getPrivateKey) {
      // Use getPrivateKey from keyHandler.js
      pkey = await getPrivateKey();
    } else {
      // Fallback: Prompt user to manually provide the private key
      console.log("Enter your private key manually:");
      const rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      pkey = await new Promise((resolve) =>
        rl.question("", (answer) => {
          rl.close();
          resolve(answer.trim());
        }),
      );
    }
    if (getApiKey) {
      // Use getApiKey from keyHandler.js
      apikey = await getApiKey();
    } else {
      // Fallback: Prompt user to manually provide the api key
      console.log("Enter your api key manually:");
      const rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      apikey = await new Promise((resolve) =>
        rl.question("", (answer) => {
          rl.close();
          resolve(answer.trim());
        }),
      );
    }
    // Call restOfLogic with the private key and api key
    await restOfLogic(pkey, apikey);
  } catch (err) {
    console.error("An error occurred:", err);
  }
})();
