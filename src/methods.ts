import snapshot from '@snapshot-labs/strategies';
import { formatBytes32String } from '@ethersproject/strings';
import { getAddress } from '@ethersproject/address';
import subgraphs from './snapshot-module/delegationSubgraphs.json';
import { JsonRpcProvider, StaticJsonRpcProvider } from '@ethersproject/providers';
import disabled from './disabled.json';
import redis from './redis';
import { getCurrentBlockNum, sha256 } from './utils';
import Multicaller from './snapshot-module/multicaller';
import _strategies from './strategies';
import {jsonToGraphQLQuery} from "json-to-graphql-query";
import fetch from "cross-fetch";

interface GetVpRequestParams {
  address: string;
  network: string;
  strategies: any[];
  snapshot: number | 'latest';
  space: string;
  delegation?: boolean;
}

interface ValidateRequestParams {
  validation: string;
  author: string;
  space: string;
  network: string;
  snapshot: number | 'latest';
  params: any;
}

const disableCachingForSpaces = [
  'magicappstore.eth',
  'moonbeam-foundation.eth'
];

export async function getVp(params: GetVpRequestParams) {
  if (typeof params.snapshot !== 'number') params.snapshot = 'latest';
  if (params.snapshot !== 'latest') {
    const currentBlockNum = await getCurrentBlockNum(
      params.snapshot,
      params.network
    );
    params.snapshot =
      currentBlockNum < params.snapshot ? 'latest' : params.snapshot;
  }

  const key = sha256(JSON.stringify(params));
  const useCache =
    redis &&
    params.snapshot !== 'latest' &&
    !disableCachingForSpaces.includes(params.space);

  if (useCache) {
    const cache = await redis.hGetAll(`vp:${key}`);

    if (cache?.vp_state) {
      cache.vp = parseFloat(cache.vp);

      cache.vp_by_strategy = JSON.parse(cache.vp_by_strategy);
      return { result: cache, cache: true };
    }
  }

  if (['1319'].includes(params.network) || disabled.includes(params.space))
    throw 'something wrong with the strategies';

  const result = await snapshotGetVp(
    params.address,
    params.network,
    params.strategies,
    params.snapshot,
    params.space,
    params.delegation
  );

  if (useCache && result.vp_state === 'final') {
    const multi = redis.multi();
    multi.hSet(`vp:${key}`, 'vp', result.vp);
    multi.hSet(
      `vp:${key}`,
      'vp_by_strategy',
      JSON.stringify(result.vp_by_strategy)
    );
    multi.hSet(`vp:${key}`, 'vp_state', result.vp_state);
    multi.exec();
  }

  return { result, cache: false };
}

export async function validate(params: ValidateRequestParams) {
  if (!params.validation || params.validation === 'any') return true;

  if (!snapshot.validations[params.validation]) throw 'Validation not found';

  const validation = new snapshot.validations[params.validation].validation(
    params.author,
    params.space,
    params.network,
    params.snapshot,
    params.params
  );

  return validation.validate();
}

const DELEGATION_CONTRACT = '0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446';
const EMPTY_ADDRESS = '0x0000000000000000000000000000000000000000';
const EMPTY_SPACE = formatBytes32String('');
const abi = ['function delegation(address, bytes32) view returns (address)'];

interface Delegation {
  in: string[];
  out: string | null;
}

export async function snapshotGetVp(
  address: string,
  network: string,
  strategies: any[],
  snapshot: number | 'latest',
  space: string,
  delegation?: boolean
) {
  const networks = [...new Set(strategies.map((s) => s.network || network))];
  const snapshots = await getSnapshots(
    network,
    snapshot,
    getProvider(network),
    networks
  );

  const delegations = {};
  if (delegation) {
    const ds = await Promise.all(
      networks.map(n => getDelegations(address, n, snapshots[n], space))
    );
    ds.forEach((d, i) => (delegations[networks[i]] = d));
  }

  const p = strategies.map((strategy) => {
    const n = strategy.network || network;
    let addresses = [address];

    if (delegation) {
      addresses = delegations[n].in;
      if (!delegations[n].out) addresses.push(address);
      addresses = [...new Set(addresses)];
      if (addresses.length === 0) return {};
    }

    addresses = addresses.map(getAddress);
    return _strategies[strategy.name].strategy(
      space,
      n,
      getProvider(n),
      addresses,
      strategy.params,
      snapshots[n]
    );
  });
  const scores = await Promise.all(p);

  const vpByStrategy = scores.map((score, i) => {
    const n = strategies[i].network || network;
    let addresses = [address];

    if (delegation) {
      addresses = delegations[n].in;
      if (!delegations[n].out) addresses.push(address);
      addresses = [...new Set(addresses)];
    }

    addresses = addresses.map(getAddress);
    return addresses.reduce((a, b) => a + (score[b] || 0), 0);
  });
  const vp = vpByStrategy.reduce((a, b) => a + b, 0);
  let vpState = 'final';
  if (snapshot === 'latest') vpState = 'pending';

  return {
    vp,
    vp_by_strategy: vpByStrategy,
    vp_state: vpState
  };
}

export async function getDelegationsOut(
  addresses: string[],
  network: string,
  snapshot: number | 'latest',
  space: string
) {
  if (!subgraphs[network])
    return Object.fromEntries(addresses.map(address => [address, null]));

  const id = formatBytes32String(space);
  const options = { blockTag: snapshot };
  const multi = new Multicaller(network, getProvider(network), abi, options);
  addresses.forEach(account => {
    multi.call(`${account}.base`, DELEGATION_CONTRACT, 'delegation', [
      account,
      EMPTY_SPACE
    ]);
    multi.call(`${account}.space`, DELEGATION_CONTRACT, 'delegation', [
      account,
      id
    ]);
  });
  const delegations = await multi.execute();

  return Object.fromEntries(
    Object.entries(delegations).map(([address, delegation]: any) => {
      if (delegation.space !== EMPTY_ADDRESS)
        return [address, delegation.space];
      if (delegation.base !== EMPTY_ADDRESS) return [address, delegation.base];
      return [address, null];
    })
  );
}

export async function getDelegationOut(
  address: string,
  network: string,
  snapshot: number | 'latest',
  space: string
): Promise<string | null> {
  const usersDelegationOut = await getDelegationsOut(
    [address],
    network,
    snapshot,
    space
  );
  return usersDelegationOut[address] || null;
}

export async function getDelegationsIn(
  address: string,
  network: string,
  snapshot: number | 'latest',
  space: string
): Promise<string[]> {
  if (!subgraphs[network]) return [];

  const max = 1000;
  let result = [];
  let page = 0;

  const query = {
    delegations: {
      __args: {
        first: max,
        skip: 0,
        block: { number: snapshot },
        where: {
          space_in: ['', space],
          delegate: address
        }
      },
      delegator: true,
      space: true
    }
  };
  // @ts-ignore
  if (snapshot === 'latest') delete query.delegations.__args.block;
  while (true) {
    query.delegations.__args.skip = page * max;
    const pageResult = await subgraphRequest(subgraphs[network], query);
    const pageDelegations = pageResult.delegations || [];
    result = result.concat(pageDelegations);
    page++;
    if (pageDelegations.length < max) break;
  }

  const delegations: string[] = [];
  let baseDelegations: string[] = [];
  result.forEach((delegation: any) => {
    const delegator = getAddress(delegation.delegator);
    if (delegation.space === space) delegations.push(delegator);
    if ([null, ''].includes(delegation.space)) baseDelegations.push(delegator);
  });

  baseDelegations = baseDelegations.filter(
    delegator => !delegations.includes(delegator)
  );
  if (baseDelegations.length > 0) {
    const delegationsOut = await getDelegationsOut(
      baseDelegations,
      network,
      snapshot,
      space
    );
    Object.entries(delegationsOut).map(([delegator, out]: any) => {
      if (out === address) delegations.push(delegator);
    });
  }

  return [...new Set(delegations)];
}

export async function getDelegations(
  address: string,
  network: string,
  snapshot: number | 'latest',
  space: string
): Promise<Delegation> {
  const [delegationOut, delegationsIn] = await Promise.all([
    getDelegationOut(address, network, snapshot, space),
    getDelegationsIn(address, network, snapshot, space)
  ]);
  return {
    in: delegationsIn,
    out: delegationOut
  };
}

let cache: Record<string, any> = {};
let expirationTime = 0;

export async function getSnapshots(
  network,
  snapshot,
  provider,
  networks,
  options: any = {}
) {
  // If snapshot is latest, return all latest
  const snapshots = {};
  networks.forEach(n => (snapshots[n] = 'latest'));
  if (snapshot === 'latest') return snapshots;

  // Check if cache is valid
  const cacheKey = `${network}-${snapshot}-${networks.join('-')}`;
  const cachedEntry = cache[cacheKey];
  const now = Date.now();
  if (cachedEntry && expirationTime > now) {
    return cachedEntry;
  }
  // Reset cache every hour
  if (expirationTime < now) {
    cache = {};
    // Set expiration time to next hour
    expirationTime = now + 60 * 60 * 1000 - (now % (60 * 60 * 1000));
  }

  snapshots[network] = snapshot;
  const networkIn = Object.keys(snapshots).filter((s) => network !== s);
  if (networkIn.length === 0) return snapshots;
  const block = await provider.getBlock(snapshot);
  const query = {
    blocks: {
      __args: {
        where: {
          ts: block.timestamp,
          network_in: networkIn
        }
      },
      network: true,
      number: true
    }
  };
  const url = options.blockFinderUrl || 'https://blockfinder.snapshot.org';
  const data = await subgraphRequest(url, query);
  data.blocks.forEach(block => (snapshots[block.network] = block.number));
  cache[cacheKey] = snapshots;
  return snapshots;
}

const providers = {};
const batchedProviders = {};

export type ProviderOptions = {
  broviderUrl?: string;
};

const DEFAULT_BROVIDER_URL = 'https://rpc.snapshot.org';
// const DEFAULT_BROVIDER_URL = 'http://localhost:3003';

export default function getProvider(
  network,
  { broviderUrl = DEFAULT_BROVIDER_URL }: ProviderOptions = {}
) {
  console.log('[score]getProvider network', network)
  if (!providers[network]) {
    let providerUrl = ''
    if (network === '1001') {
      providers[network] = new JsonRpcProvider(`https://kaia-kairos.g.allthatnode.com/full/evm/${process.env.ALLTAHTNODE_API_KEY}`);
    } else if (network === '8217') {
      providers[network] = new JsonRpcProvider(`https://kaia-mainnet.g.allthatnode.com/full/evm/${process.env.ALLTAHTNODE_API_KEY}`);
    } else {
      const url = `${broviderUrl}/${network}`;
      providers[network] = new StaticJsonRpcProvider(
        {
          url,
          timeout: 25000,
          allowGzip: true
        },
        Number(network)
      );
    }
  }

  return providers[network];
}

async function subgraphRequest(url: string, query, options: any = {}) {
  const body: Record<string, any> = { query: jsonToGraphQLQuery({ query }) };
  if (options.variables) body.variables = options.variables;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...options?.headers
    },
    body: JSON.stringify(body)
  });
  let responseData: any = await res.text();
  try {
    responseData = JSON.parse(responseData);
  } catch (e: any) {
    throw new Error(
      `Errors found in subgraphRequest: URL: ${url}, Status: ${
        res.status
      }, Response: ${responseData.substring(0, 400)}`
    );
  }
  if (responseData.errors) {
    throw new Error(
      `Errors found in subgraphRequest: URL: ${url}, Status: ${
        res.status
      },  Response: ${JSON.stringify(responseData.errors).substring(0, 400)}`
    );
  }
  const { data } = responseData;
  return data || {};
}
