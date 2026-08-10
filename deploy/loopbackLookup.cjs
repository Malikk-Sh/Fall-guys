'use strict';

function loopbackLookup(_hostname, options, callback) {
  if (options?.all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return;
  }

  callback(null, '127.0.0.1', 4);
}

module.exports = loopbackLookup;
