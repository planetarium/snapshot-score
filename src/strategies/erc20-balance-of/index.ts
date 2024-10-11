import { BigNumberish } from '@ethersproject/bignumber';
import { formatUnits } from '@ethersproject/units';
// import { Multicaller } from '../../utils';
import Multicaller from '../../snapshot-module/multicaller';

export const author = 'bonustrack';
export const version = '0.1.1';

const abi = [
  'function balanceOf(address account) external view returns (uint256)'
];

export async function strategy(
  space,
  network,
  provider,
  addresses,
  options,
  snapshot
): Promise<Record<string, number>> {
  const blockTag = typeof snapshot === 'number' ? snapshot : 'latest';

  console.log('erc20-balance-of strategy')
  console.log({
    space,
    network,
    provider,
    addresses,
    options,
    snapshot
  })

  const multi = new Multicaller(network, provider, abi, { blockTag });

  console.log('====after multicaller')
  addresses.forEach((address) =>
    multi.call(address, options.address, 'balanceOf', [address])
  );

  console.log('====after multi.call')
  const result: Record<string, BigNumberish> = await multi.execute();

  console.log('====after multi.execute')

  return Object.fromEntries(
    Object.entries(result).map(([address, balance]) => [
      address,
      parseFloat(formatUnits(balance, options.decimals))
    ])
  );
}
