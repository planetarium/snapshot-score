import { readFileSync } from 'fs';
import path from 'path';

import * as erc20BalanceOf from './erc20-balance-of';
import * as erc721 from './erc721';
import * as whitelist from './whitelist';
import * as whitelistWeighted from './whitelist-weighted';
import * as whitelistWeightedJson from './whitelist-weighted-json';

const strategies = {
  'erc20-balance-of': erc20BalanceOf,
  erc721,
  whitelist,
  'whitelist-weighted': whitelistWeighted,
  'whitelist-weighted-json': whitelistWeightedJson,
};

Object.keys(strategies).forEach(function (strategyName) {
  let examples = null;
  let schema = null;
  let about = '';

  try {
    examples = JSON.parse(
      readFileSync(path.join(__dirname, strategyName, 'examples.json'), 'utf8')
    );
  } catch (error) {
    examples = null;
  }

  try {
    schema = JSON.parse(
      readFileSync(path.join(__dirname, strategyName, 'schema.json'), 'utf8')
    );
  } catch (error) {
    schema = null;
  }

  try {
    about = readFileSync(
      path.join(__dirname, strategyName, 'README.md'),
      'utf8'
    );
  } catch (error) {
    about = '';
  }
  strategies[strategyName].examples = examples;
  strategies[strategyName].schema = schema;
  strategies[strategyName].about = about;
});

export default strategies;
