/*
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const documentIntegrity = require('./lib/documentIntegrity');

module.exports.DocumentIntegrity = documentIntegrity;
module.exports.contracts = [documentIntegrity];
