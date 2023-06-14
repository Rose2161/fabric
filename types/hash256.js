'use strict';

/**
 * Simple interaction with 256-bit spaces.
 */
class Hash256 {
  /**
   * Create an instance of a `Hash256` object by calling `new Hash256()`,
   * where `settings` can be provided to supply a particular input object.
   * 
   * If the `settings` is not a string, `input` must be provided.
   * @param {Object} settings 
   * @param {String} settings.input Input string to map as 256-bit hash.
   */
  constructor (settings = {}) {
    if (typeof settings === 'string') settings = { input: settings };
    if (!settings.input) settings.input = require('crypto').randomBytes(32).toString('hex');

    this.settings = Object.assign({
      hash: Hash256.digest(settings.input)
    }, settings);
  }

  static compute (input) {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      let hash = '';
      let error = null;

      Hash256.hash(input).then(result => {
        hash = result;
      }).catch(exception => {
        error = exception;
      });

      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

      while (!hash) {
        sleep(1);
      }

      if (error) {
        console.error('error:', error);
        return null;
      }

      return hash;
    } else {
      return require('crypto').createHash('sha256').update(input).digest('hex');
    }
  }

  /**
   * Produce a SHA256 digest of some input data.
   * @param {String|Buffer} input Content to digest.
   * @returns {String} `SHA256(input)` as a hexadecimal string.
   */
  static digest (input) {
    if (typeof input !== 'string' && !(input instanceof Buffer)) {
      throw new Error(`Input to process must be of type "String" or "Buffer" to digest.`);
    }

    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      return Hash256.compute(input);
    } else {
      return require('crypto').createHash('sha256').update(input).digest('hex');
    }
  }

  // TODO: document `hash256.value`
  get value () {
    return Hash256.digest(this.settings.input);
  }

  /**
   * Reverses the bytes of the digest.
   */
  static reverse (input = '') {
    return Buffer.from(input, 'hex').reverse().toString('hex');
  }

  static async hash (input) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  }

  reverse (input = this.value) {
    return Hash256.reverse(input);
  }
}

module.exports = Hash256;
