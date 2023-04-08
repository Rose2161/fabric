'use strict';

const {
  MAGIC_BYTES,
  VERSION_NUMBER,
  HEADER_SIZE,
  MAX_MESSAGE_SIZE,
  OP_CYCLE,
  GENERIC_MESSAGE_TYPE,
  LOG_MESSAGE_TYPE,
  GENERIC_LIST_TYPE,
  P2P_GENERIC,
  P2P_IDENT_REQUEST,
  P2P_IDENT_RESPONSE,
  P2P_ROOT,
  P2P_PING,
  P2P_PONG,
  P2P_START_CHAIN,
  P2P_INSTRUCTION,
  P2P_BASE_MESSAGE,
  P2P_CHAIN_SYNC_REQUEST,
  P2P_STATE_ROOT,
  P2P_STATE_COMMITTMENT,
  P2P_STATE_CHANGE,
  P2P_STATE_REQUEST,
  P2P_TRANSACTION,
  P2P_CALL,
  CHAT_MESSAGE,
  DOCUMENT_PUBLISH_TYPE,
  DOCUMENT_REQUEST_TYPE,
  BLOCK_CANDIDATE,
  PEER_CANDIDATE,
  SESSION_START
} = require('../constants');

// Dependencies
const crypto = require('crypto');
const struct = require('struct');

// Fabric Types
const Actor = require('./actor');
const Label = require('./label');
// const Signer = require('./signer');

// Function Definitions
const padDigits = require('../functions/padDigits');

// Type Labels
const TYPE_ETHEREUM_BLOCK        = parseInt((new Label('types/EthereumBlock'))._id, 16);
const TYPE_ETHEREUM_BLOCK_NUMBER = parseInt((new Label('types/EthereumBlockNumber'))._id, 16);

/**
 * The {@link Message} type defines the Application Messaging Protocol, or AMP.
 * Each {@link Actor} in the network receives and broadcasts messages,
 * selectively disclosing new routes to peers which may have open circuits.
 * @type {Object}
 */
class Message extends Actor {
  /**
   * The `Message` type is standardized in {@link Fabric} as a {@link Array}, which can be added to any other vector to compute a resulting state.
   * @param  {Object} message Message vector.  Will be serialized by {@link Array#_serialize}.
   * @return {Message} Instance of the message.
   */
  constructor (input = {}) {
    super(input);

    this.raw = {
      magic: Buffer.alloc(4),
      version: Buffer.alloc(4),
      parent: Buffer.alloc(32),
      author: Buffer.alloc(32),
      type: Buffer.alloc(4), // TODO: 8, 32
      size: Buffer.alloc(4), // TODO: 8, 32
      hash: Buffer.alloc(32),
      signature: Buffer.alloc(64),
      data: null
    };

    this.raw.magic.write(MAGIC_BYTES.toString(16), 'hex');
    this.raw.version.write(padDigits(VERSION_NUMBER.toString(16), 8), 'hex');

    // Use provided signer
    if (input.signer) {
      this.signer = input.signer;
    } else {
      this.signer = null;
      // this.signer = new Signer();
    }

    if (input.data && input.type) {
      this.type = input.type;

      if (typeof input.data !== 'string') {
        this.data = JSON.stringify(input.data);
      } else {
        this.data = input.data;
      }
    }

    // Set various properties to be unenumerable
    for (let name of [
      '@input',
      '@entity',
      '_state',
      'config',
      'settings',
      'signer',
      'stack',
      'observer'
    ]) Object.defineProperty(this, name, { enumerable: false });

    return this;
  }

  get body () {
    return this.raw.data.toString('utf8');
  }

  get byte () {
    const input = 0 + '';
    const num = Buffer.from(`0x${padDigits(input, 8)}`, 'hex');
    return num;
  }

  get tu16 () {
    return parseInt(0);
  }

  get tu32 () {
    return parseInt(0);
  }

  get tu64 () {
    return parseInt(0);
  }

  get Uint256 () {
    // 256 bits
    return Buffer.from((this.raw && this.raw.hash) ? `0x${padDigits(this.raw.hash, 8)}` : crypto.randomBytes(32));
  }

  set signature (value) {
    if (value instanceof Buffer) value = value.toString('hex');
    this.raw.signature.write(value, 'hex');
  }

  toBuffer () {
    return this.asRaw();
  }

  /**
   * Returns a {@link Buffer} of the complete message.
   * @return {Buffer} Buffer of the encoded {@link Message}.
   */
  asRaw () {
    return Buffer.concat([this.header, this.raw.data]);
  }

  toRaw () {
    return this.asRaw();
  }

  asTypedArray () {
    return new Uint8Array(this.asRaw());
    // TODO: Node 12
    // return new TypedArray(this.asRaw());
  }

  asBlob () {
    return this.asRaw().map(byte => parseInt(byte, 16));
  }

  toObject () {
    return {
      headers: {
        magic: parseInt(`${this.raw.magic.toString('hex')}`, 16),
        version: parseInt(`${this.raw.version.toString('hex')}`, 16),
        parent: this.raw.parent.toString('hex'),
        author: this.raw.author.toString('hex'),
        type: parseInt(`${this.raw.type.toString('hex')}`, 16),
        size: parseInt(`${this.raw.size.toString('hex')}`, 16),
        hash: this.raw.hash.toString('hex'),
        signature: this.raw.signature.toString('hex'),
      },
      type: this.type,
      data: this.data
    };
  }

  fromObject (input) {
    return new Message(input);
  }

  /**
   * Signs the message using the associated signer.
   * @returns {Message} Signed message.
   */
  sign () {
    if (!this.header) throw new Error('No header property.');
    if (!this.raw) throw new Error('No raw property.');

    const hash = crypto.createHash('sha256').update(this.raw.data).digest();
    const signature = this.signer.sign(hash);

    this.raw.author.write(this.signer.pubkey.toString('hex'), 'hex');
    this.raw.signature.write(signature.toString('hex'), 'hex');

    Object.freeze(this);

    return this;
  }

  /**
   * Verify a message's signature.
   * @returns {Boolean} `true` if the signature is valid, `false` if not.
   */
  verify () {
    if (!this.header) throw new Error('No header property.');
    if (!this.raw) throw new Error('No raw property.');

    // Compute sha256 hash of message body
    const hash = crypto.createHash('sha256').update(this.raw.data).digest();

    // If the raw header doesn't match the computed values, reject
    if (this.raw.hash.toString('hex') !== hash.toString('hex')) {
      return false;
    }

    const signature = this.raw.signature;
    const verified = this.signer.verify(this.raw.author, hash, signature);

    if (!verified) {
      throw new Error('Did not verify.');
    }

    return true;
  }

  /**
   * Sets the signer for the message.
   * @param {Signer} signer Signer instance.
   * @returns {Message} Instance of the Message with associated signer.
   */
  _setSigner (signer) {
    // if (this.signer) throw new Error('Cannot override signer.');
    this.signer = signer;
    return this;
  }

  static parseBuffer (buffer) {
    const message = struct()
      .charsnt('magic', 4, 'hex')
      .charsnt('version', 4, 'hex')
      .charsnt('parent', 32, 'hex')
      .charsnt('type', 4, 'hex')
      .charsnt('size', 4, 'hex')
      .charsnt('hash', 32, 'hex')
      .charsnt('signature', 64, 'hex')
      .charsnt('data', buffer.length - HEADER_SIZE);

    message.allocate();
    message._setBuff(buffer);

    return message;
  }

  static parseRawMessage (buffer) {
    const message = {
      magic: buffer.slice(0, 4),
      version: buffer.slice(4, 8),
      parent: buffer.slice(8, 40),
      author: buffer.slice(40, 72),
      type: buffer.slice(72, 76),
      size: buffer.slice(76, 80),
      hash: buffer.slice(80, 112),
      signature: buffer.slice(112, HEADER_SIZE)
    };

    if (buffer.length >= HEADER_SIZE) {
      message.data = buffer.slice(HEADER_SIZE, buffer.length);
    }

    return message;
  };

  static fromBuffer (buffer) {
    return Message.fromRaw(buffer);
  }

  static fromRaw (input) {
    if (!input) return null;
    if (!(input instanceof Buffer)) throw new Error('Input must be a buffer.');
    // if (input.length < HEADER_SIZE) return null;
    // if (input.length > MAX_MESSAGE_SIZE) return new Error('Input too large.');

    const message = new Message();

    message.raw = {
      magic: input.slice(0, 4),
      version: input.slice(4, 8),
      parent: input.slice(8, 40),
      author: input.slice(40, 72),
      type: input.slice(72, 76),
      size: input.slice(76, 80),
      hash: input.slice(80, 112),
      signature: input.slice(112, HEADER_SIZE)
    };

    message.data = input.slice(HEADER_SIZE);

    return message;
  }

  static fromVector (vector = ['LogMessage', 'No vector provided.']) {
    let message = null;

    try {
      message = new Message({
        type: vector[0],
        data: vector[1]
      });
    } catch (exception) {
      console.error('[FABRIC:MESSAGE]', 'Could not construct Message:', exception);
    }

    return message;
  }

  /* get [Symbol.toStringTag] () {
    return `<Message | ${JSON.stringify(this.raw)}>`;
  } */

  get id () {
    return crypto.createHash('sha256').update(this.asRaw()).digest('hex');
  }

  get types () {
    // Message Types
    return {
      'GenericMessage': GENERIC_MESSAGE_TYPE,
      'GenericLogMessage': LOG_MESSAGE_TYPE,
      'GenericList': GENERIC_LIST_TYPE,
      'GenericQueue': GENERIC_LIST_TYPE,
      'FabricLogMessage': LOG_MESSAGE_TYPE,
      'FabricServiceLogMessage': LOG_MESSAGE_TYPE,
      'GenericTransferQueue': GENERIC_LIST_TYPE,
      // TODO: document Generic type
      // P2P Commands
      'Generic': P2P_GENERIC,
      'Cycle': OP_CYCLE,
      'IdentityRequest': P2P_IDENT_REQUEST,
      'IdentityResponse': P2P_IDENT_RESPONSE,
      'ChainSyncRequest': P2P_CHAIN_SYNC_REQUEST,
      // TODO: restore this type
      // 'StateRoot': P2P_ROOT,
      'Ping': P2P_PING,
      'Pong': P2P_PONG,
      'DocumentRequest': DOCUMENT_REQUEST_TYPE,
      'DocumentPublish': DOCUMENT_PUBLISH_TYPE,
      'BlockCandidate': BLOCK_CANDIDATE,
      'PeerCandidate': PEER_CANDIDATE,
      'PeerInstruction': P2P_INSTRUCTION,
      'PeerMessage': P2P_BASE_MESSAGE,
      'StartSession': SESSION_START,
      'ChatMessage': CHAT_MESSAGE,
      'StartChain': P2P_START_CHAIN,
      // TODO: restore above StateRoot type
      'StateRoot': P2P_STATE_ROOT,
      'StateCommitment': P2P_STATE_COMMITTMENT,
      'StateChange': P2P_STATE_CHANGE,
      'StateRequest': P2P_STATE_REQUEST,
      'Transaction': P2P_TRANSACTION,
      'Call': P2P_CALL,
      'LogMessage': LOG_MESSAGE_TYPE,
      'EthereumBlock': TYPE_ETHEREUM_BLOCK,
      'EthereumBlockNumber': TYPE_ETHEREUM_BLOCK_NUMBER
    };
  }

  get codes () {
    return Object.entries(this.types).reduce((ret, entry) => {
      const [ key, value ] = entry;
      ret[ value ] = key;
      return ret;
    }, {});
  }

  get magic () {
    return this.raw.magic;
  }

  get signature () {
    return parseInt(Buffer.from(this.raw.signature, 'hex'));
  }

  get size () {
    return parseInt(Buffer.from(this.raw.size, 'hex'));
  }

  get version () {
    return parseInt(Buffer.from(this.raw.version));
  }

  get header () {
    const parts = [
      Buffer.from(this.raw.magic, 'hex'),
      Buffer.from(this.raw.version, 'hex'),
      Buffer.from(this.raw.parent, 'hex'),
      Buffer.from(this.raw.author, 'hex'),
      Buffer.from(this.raw.type, 'hex'),
      Buffer.from(this.raw.size, 'hex'),
      Buffer.from(this.raw.hash, 'hex'),
      Buffer.from(this.raw.signature, 'hex')
    ];

    return Buffer.concat(parts);
  }
}

Object.defineProperty(Message.prototype, 'type', {
  get () {
    const code = parseInt(this.raw.type.toString('hex'), 16);
    switch (code) {
      case GENERIC_MESSAGE_TYPE:
        return 'GenericMessage';
      case LOG_MESSAGE_TYPE:
        return 'GenericLogMessage';
      case GENERIC_LIST_TYPE:
        return 'GenericList';
      case DOCUMENT_PUBLISH_TYPE:
        return 'DocumentPublish';
      case DOCUMENT_REQUEST_TYPE:
        return 'DocumentRequest';
      case BLOCK_CANDIDATE:
        return 'BlockCandidate';
      case OP_CYCLE:
        return 'Cycle';
      case P2P_PING:
        return 'Ping';
      case P2P_PONG:
        return 'Pong';
      case P2P_GENERIC:
        return 'Generic';
      case P2P_CHAIN_SYNC_REQUEST:
        return 'ChainSyncRequest';
      case P2P_IDENT_REQUEST:
        return 'IdentityRequest';
      case P2P_IDENT_RESPONSE:
        return 'IdentityResponse';
      case P2P_BASE_MESSAGE:
        return 'PeerMessage';
      case P2P_STATE_ROOT:
        return 'StateRoot';
      case P2P_STATE_CHANGE:
        return 'StateChange';
      case P2P_STATE_REQUEST:
        return 'StateRequest';
      case P2P_TRANSACTION:
        return 'Transaction';
      case P2P_CALL:
        return 'Call';
      case PEER_CANDIDATE:
        return 'PeerCandidate';
      case SESSION_START:
        return 'StartSession';
      case CHAT_MESSAGE:
        return 'ChatMessage';
      case P2P_START_CHAIN:
        return 'StartChain';
      case TYPE_ETHEREUM_BLOCK:
        return 'EthereumBlock';
      case TYPE_ETHEREUM_BLOCK_NUMBER:
        return 'EthereumBlockNumber';
      default:
        return 'GenericMessage';
    }
  },
  set (value) {
    let code = this.types[value];
    // Default to GenericMessage;
    if (!code) {
      this.emit('warning', `Unknown message type: ${value}`);
      code = this.types['GenericMessage'];
    }

    const padded = padDigits(code.toString(16), 8);
    this['@type'] = value;
    this.raw.type.write(padded, 'hex');
  }
});

Object.defineProperty(Message.prototype, 'data', {
  get () {
    if (!this.raw.data) return '';
    return this.raw.data.toString('utf8');
  },
  set (value) {
    if (!value) value = '';
    const hash = crypto.createHash('sha256').update(value.toString('utf8'));
    this.raw.hash = hash.digest();
    this.raw.data = Buffer.from(value);
    this.raw.size.write(padDigits(this.raw.data.byteLength.toString(16), 8), 'hex');
  }
});

module.exports = Message;
