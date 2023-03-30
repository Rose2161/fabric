'use strict';

// Constants
const {
  MAX_CHAT_MESSAGE_LENGTH,
  BITCOIN_GENESIS
} = require('../constants');

const INPUT_HINT = 'Press the "i" key to begin typing.';

// Internal Dependencies
const fs = require('fs');
const EventEmitter = require('events').EventEmitter;

// External Dependencies
const merge = require('lodash.merge');
const pointer = require('json-pointer'); // TODO: move uses to App
const monitor = require('fast-json-patch'); // TODO: move uses to App

// Fabric Types
const App = require('./app');
const Peer = require('./peer');
const Actor = require('./actor');
const Message = require('./message');
const Hash256 = require('./hash256');
const Identity = require('./identity');
const Filesystem = require('./filesystem');
const Wallet = require('./wallet');

// Services
const Bitcoin = require('../services/bitcoin');
const Lightning = require('../services/lightning');

// UI dependencies
// TODO: use Jade to render pre-registered components
// ```jade
// fabric-application
//   fabric-box
//   fabric-row
//     fabric-log
//     fabric-list
//   fabric-input
// ```
const blessed = require('blessed');

/**
 * Provides a Command Line Interface (CLI) for interacting with
 * the Fabric network using a terminal emulator.
 */
class CLI extends App {
  /**
   * Create a terminal-based interface for a {@link User}.
   * @param {Object} [settings] Configuration values.
   * @param {Array} [settings.currencies] List of currencies to support.
   */
  constructor (settings = {}) {
    super(settings);

    // Assign Settings
    this.settings = merge({
      debug: true,
      ephemeral: false,
      listen: false,
      peering: true, // set to true to start Peer
      render: true,
      services: [],
      network: 'regtest',
      interval: 1000,
      bitcoin: {
        mode: 'rpc', // TODO: change name of mode to `rest`?
        host: 'localhost',
        port: 8443,
        secure: false
      },
      lightning: {
        mode: 'socket',
        path: './stores/lightning-playnet/regtest/lightning-rpc'
      },
      storage: {
        path: `${process.env.HOME}/.fabric/console`
      }
    }, this.settings, settings);

    // Properties
    this.screen = null;
    this.history = [];

    this.aliases = {};
    this.channels = {};
    this.commands = {};
    this.contracts = {};
    this.documents = {};
    this.elements = {};
    this.peers = {};
    this.requests = {};
    this.services = {};
    this.connections = {};

    this.fs = new Filesystem(this.settings.storage);

    // State
    this._state = {
      anchor: null,
      balances: {
        confirmed: 0,
        immature: 0,
        trusted: 0,
        unconfirmed: 0,
      },
      content: {
        actors: {},
        bitcoin: {
          best: null,
          genesis: BITCOIN_GENESIS
        },
        documents: {},
        messages: {}
      },
      contracts: {},
      clock: 0
    };

    this.attachWallet();

    this._loadPeer();
    this._loadBitcoin();
    this._loadLightning();

    this.identity = new Identity(this.settings);

    // Chainable
    return this;
  }

  assumeIdentity (key) {
    this.identity = new Identity(key);
  }

  attachWallet (wallet) {
    if (!wallet) wallet = new Wallet(this.settings);

    this.wallet = wallet;

    return this;
  }

  flush () {
    this.fs.delete('STATE');
    return this;
  }

  _loadPeer () {
    const file = this.fs.readFile('STATE');
    const state = (file) ? JSON.parse(file) : {};

    // Create and assign Peer instance as the `node` property
    this.node = new Peer({
      debug: this.settings.debug,
      network: this.settings.network,
      interface: this.settings.interface,
      port: this.settings.port,
      peers: this.settings.peers,
      state: state,
      upnp: this.settings.upnp,
      key: this.identity.settings
    });

    return this;
  }

  _loadBitcoin () {
    this.bitcoin = new Bitcoin(this.settings.bitcoin);
    return this;
  }

  _loadLightning () {
    this.lightning = new Lightning(this.settings.lightning);
    return this;
  }

  async bootstrap () {
    try {
      await this.fs.start();
      return true;
    } catch (exception) {
      this._appendError(`Could not bootstrap: ${exception}`)
      return false;
    }
  }

  async tick () {
    // Poll for new information
    // TODO: ZMQ
    await this._syncChainDisplay();
    await this._syncContracts();
    await this._syncBalance();
    await this._syncUnspent();

    // Increment clock and commit
    this._state.clock++;
    this.commit();
  }

  /**
   * Starts (and renders) the CLI.
   */
  async start () {
    // Register Internal Commands
    this._registerCommand('help', this._handleHelpRequest);
    this._registerCommand('quit', this._handleQuitRequest);
    this._registerCommand('exit', this._handleQuitRequest);
    this._registerCommand('clear', this._handleClearRequest);
    this._registerCommand('flush', this._handleFlushRequest);
    this._registerCommand('alias', this._handleAliasRequest);
    this._registerCommand('peers', this._handlePeerListRequest);
    this._registerCommand('rotate', this._handleRotateRequest);
    this._registerCommand('connect', this._handleConnectRequest);
    this._registerCommand('disconnect', this._handleDisconnectRequest);
    this._registerCommand('settings', this._handleSettingsRequest);
    this._registerCommand('inventory', this._handleInventoryRequest);
    this._registerCommand('channels', this._handleChannelRequest);
    this._registerCommand('identity', this._handleIdentityRequest);
    this._registerCommand('generate', this._handleGenerateRequest);
    this._registerCommand('unspent', this._handleUnspentRequest);
    this._registerCommand('receive', this._handleReceiveAddressRequest);
    this._registerCommand('balance', this._handleBalanceRequest);
    this._registerCommand('service', this._handleServiceCommand);
    this._registerCommand('publish', this._handlePublishCommand);
    this._registerCommand('request', this._handleRequestCommand);
    this._registerCommand('grant', this._handleGrantCommand);
    this._registerCommand('import', this._handleImportCommand);
    this._registerCommand('join', this._handleJoinRequest);
    this._registerCommand('sync', this._handleChainSyncRequest);
    this._registerCommand('send', this._handleSendRequest);
    this._registerCommand('fund', this._handleFundRequest);
    this._registerCommand('state', this._handleStateRequest);
    this._registerCommand('set', this._handleSetRequest);
    this._registerCommand('get', this._handleGetRequest);

    // Contracts
    this._registerCommand('contracts', this._handleContractsRequest);

    // Service Commands
    this._registerCommand('bitcoin', this._handleBitcoinRequest);
    this._registerCommand('lightning', this._handleLightningRequest);

    // Services
    this._registerService('bitcoin', Bitcoin);
    this._registerService('lightning', Lightning);

    await this.bootstrap();

    if (this.settings.render) {
      // Render UI
      this.render();
    }

    // ## Bindings
    this.on('log', this._handleSourceLog.bind(this));
    this.on('debug', this._handleSourceDebug.bind(this));
    this.on('error', this._handleSourceError.bind(this));
    this.on('warning', this._handleSourceWarning.bind(this));

    // ## P2P message handlers
    this.node.on('log', this._handlePeerLog.bind(this));
    this.node.on('ready', this._handleNodeReady.bind(this));
    this.node.on('debug', this._handlePeerDebug.bind(this));
    this.node.on('error', this._handlePeerError.bind(this));
    this.node.on('warning', this._handlePeerWarning.bind(this));
    this.node.on('message', this._handlePeerMessage.bind(this));
    this.node.on('changes', this._handlePeerChanges.bind(this));
    this.node.on('commit', this._handlePeerCommit.bind(this));
    this.node.on('state', this._handlePeerState.bind(this));
    this.node.on('chat', this._handlePeerChat.bind(this));
    this.node.on('upnp', this._handlePeerUPNP.bind(this));
    this.node.on('contractset', this._handleContractSet.bind(this));

    // ## Raw Connections
    this.node.on('connection', this._handleConnection.bind(this));
    this.node.on('connections:open', this._handleConnectionOpen.bind(this));
    this.node.on('connections:close', this._handleConnectionClose.bind(this));
    this.node.on('connection:error', this._handleConnectionError.bind(this));

    // ## Peer Events
    this.node.on('peer', this._handlePeer.bind(this));
    this.node.on('peer:candidate', this._handlePeerCandidate.bind(this));
    this.node.on('session:update', this._handleSessionUpdate.bind(this));

    // ## Document Exchange
    this.node.on('DocumentPublish', this._handlePeerDocumentPublish.bind(this));
    this.node.on('DocumentRequest', this._handlePeerDocumentRequest.bind(this));

    // ## Anchor handlers
    // ### Bitcoin
    this.bitcoin.on('debug', this._handleBitcoinDebug.bind(this));
    this.bitcoin.on('ready', this._handleBitcoinReady.bind(this));
    this.bitcoin.on('error', this._handleBitcoinError.bind(this));
    this.bitcoin.on('warning', this._handleBitcoinWarning.bind(this));
    this.bitcoin.on('message', this._handleBitcoinMessage.bind(this));
    this.bitcoin.on('log', this._handleBitcoinLog.bind(this));
    this.bitcoin.on('commit', this._handleBitcoinCommit.bind(this));
    this.bitcoin.on('sync', this._handleBitcoinSync.bind(this));
    this.bitcoin.on('block', this._handleBitcoinBlock.bind(this));
    this.bitcoin.on('transaction', this._handleBitcoinTransaction.bind(this));

    // #### Lightning
    this.lightning.on('debug', this._handleLightningDebug.bind(this));
    this.lightning.on('ready', this._handleLightningReady.bind(this));
    this.lightning.on('error', this._handleLightningError.bind(this));
    this.lightning.on('warning', this._handleLightningWarning.bind(this));
    this.lightning.on('message', this._handleLightningMessage.bind(this));
    this.lightning.on('log', this._handleLightningLog.bind(this));
    this.lightning.on('commit', this._handleLightningCommit.bind(this));
    this.lightning.on('sync', this._handleLightningSync.bind(this));
    // this.lightning.on('transaction', this._handleLightningTransaction.bind(this));

    /* this.on('log', function (log) {
      console.log('local log:', log);
    }); */

    // this.on('debug', this._appendDebug.bind(this));

    // const events = this.trust(this.lightning);

    // ## Start all services
    for (const [name, service] of Object.entries(this.services)) {
      // Skip when service name not found in settings
      if (!this.settings.services.includes(name)) continue;
      this._appendDebug(`Service "${name}" is enabled.  Starting...`);
      this.trust(this.services[name], name);

      try {
        await this.services[name].start();
        this._appendDebug(`The service named "${name}" has started!`);
      } catch (exception) {
        this._appendError(`The service named "${name}" could not start:\n${exception}`);
      }
    }

    // ## Track state changes
    this.observer = monitor.observe(this._state.content);

    // Bind remaining internals
    // TODO: enable
    // this.on('changes', this._handleChanges.bind(this));

    // ## Start Anchor Services
    // Start Bitcoin service
    await this.bitcoin.start();

    // Start Lightning service
    this.lightning.start();

    // ## Start P2P node
    if (this.settings.peering) this.node.start();

    // ## Attach Heartbeat
    this._heart = setInterval(this.tick.bind(this), this.settings.interval);

    // ## Emit Ready
    this.status = 'READY';
    this.emit('ready');

    // Chainable
    return this;
  }

  /**
   * Disconnect all interfaces and exit the process.
   */
  async stop () {
    await this.node.stop();
    return process.exit(0);
  }

  get (path = '') {
    let result = null;

    try {
      result = pointer.get(this._state.content, path);
    } catch (exception) {
      this._appendError(`Could not retrieve path "${path}": ${exception}`);
    }

    return result;
  }

  set (path, value) {
    if (!path) return this._appendError('Must provide a path.');
    if (!value) return this._appendError('Must provide a value.');

    try {
      pointer.set(this._state, path, value);
    } catch (exception) {
      this._appendError(`Could not set path "${path}": ${exception}`);
    }

    this.commit();

    return this.get(path);
  }

  commit () {
    ++this.clock;

    this['@parent'] = this.id;
    this['@preimage'] = this.toString();
    this['@constructor'] = this.constructor;

    let changes = null;

    if (this.observer) {
      changes = monitor.generate(this.observer);
    }

    this['@id'] = this.id;

    if (changes && changes.length) {
      // this._appendMessage(`Changes: ${JSON.stringify(changes, null, '  ')}`);

      this.emit('changes', changes);
      this.emit('state', this['@state']);
      this.emit('message', {
        '@type': 'Transaction',
        '@data': {
          'changes': changes,
          'state': changes
        }
      });
    }

    return this;
  }

  trust (source, name = this.constructor.name) {
    if (!(source instanceof EventEmitter)) throw new Error('Source is not an EventEmitter.')
    const self = this;

    return {
      _handleTrustedError: source.on('error', async function handleTrustedError (error) {
        self._appendMessage(`[SOURCE:${name.toUpperCase()}] ${error}`);
      }),
      _handleTrustedLog: source.on('log', async function handleTrustedLog (log) {
        self._appendMessage(`[SOURCE:${name.toUpperCase()}] ${log}`);
      }),
      _handleTrustedDebug: source.on('debug', async function handleTrustedDebug (log) {
        self._appendDebug(`[SOURCE:${name.toUpperCase()}] ${log}`);
      }),
      _handleTrustedReady: source.on('ready', async function handleTrustedReady (ready) {
        self._appendMessage(`[SOURCE:${name.toUpperCase()}] Ready! ${ready}`);
      })
    }
  }

  async _appendMessage (msg) {
    const message = `[${(new Date()).toISOString()}] ${msg}`;
    if (this.settings.render) {
      this.elements['messages'].log(message);
      this.screen.render();
    } else {
      console.log(`[FABRIC:CLI] ${message}`);
    }
  }

  async _appendDebug (msg) {
    this._appendMessage(`{green-fg}${msg}{/green-fg}`);
  }

  async _appendWarning (msg) {
    this._appendMessage(`{yellow-fg}${msg}{/yellow-fg}`);
  }

  async _appendError (msg) {
    this._appendMessage(`{red-fg}${msg}{/red-fg}`);
  }

  async _handleContractSet (contractset) {
    this._appendDebug(`[CONTRACTSET] ${JSON.stringify(contractset, null, '  ')}`);
    this.contracts = contractset;
    this.commit();
  }

  async _handlePeerState (state) {
    // this._appendDebug(`[STATE] ${JSON.stringify(state, null, '  ')}`);
    this.fs.publish('STATE', JSON.stringify(state, null, '  '));
  }

  async _handleSourceLog (msg) {
    this._appendMessage(msg);
  }

  async _handleSourceDebug (msg) {
    this._appendDebug(msg);
  }

  async _handleSourceError (msg) {
    this._appendError(msg);
  }

  async _handleSourceWarning (msg) {
    this._appendWarning(msg);
  }

  async _handleChanges (changes) {
    this._appendMessage(`New Changes: ${JSON.stringify(changes, null, '  ')}`);
  }

  async _handleContractsRequest (params) {
    this._appendMessage('{bold}Current Contracts{/bold}: ' + JSON.stringify(this.contracts, null, '  '));
    return false;
  }

  async _handleStateRequest (params) {
    const value = await this.get(``);
    this._appendMessage('{bold}Current State{/bold}: ' + JSON.stringify(value, null, ' '));
    return false;
  }

  async _handleGetRequest (params) {
    if (!params[1]) return this._appendError(`Must provide a document name.`);
    const value = await this.get(`/${params[1]}`);
    this._appendMessage('Value: ' + JSON.stringify(value, null, ' '));
    return false;
  }

  async _handleSetRequest (params) {
    if (!params[1]) return this._appendError(`Must provide a document name.`);
    if (!params[2]) return this._appendError(`Must provide a document.`);
    const result = await this.set(`/${params[1]}`, params[2]);
    this._appendMessage('Result: ' + JSON.stringify(result, null, ' '));
    return false;
  }

  async _handleFundRequest (params) {
    if (!params[1]) return this._appendError(`Must provide a channel ID.`);
    if (!params[2]) return this._appendError(`Must provide a funding amount.`);
    this._fundChannel(params[1], params[2]);
  }

  async _handleChannelRequest (params) {
    const state = await this.lightning._syncOracleChannels();
    this._appendMessage(`{bold}Channels:{/bold} ${JSON.stringify(state.channels, null, '  ')}`);
  }

  async _fundChannel (id, amount) {
    this._appendMessage(`Funding channel ${id} with ${amount} BTC...`);
    // TODO: create payment channel (@fabric/core/types/channel)
  }

  /**
   * Creates a token for the target signer with a provided role and some optional data.
   * @param {Array} params Parameters array.
   */
  async _handleGrantCommand (params) {
    const target = params[1];
    const role = params[2];
    const extra = params[3];

    this._appendMessage(`Creating token with role "${role}" for target: ${target}${(extra) ? ' (extra: ' + extra + ')' : ''}`);
  }

  async _handleJoinRequest (params) {
    if (!params[1]) return this._appendError(`You must specify a sidechain.`);
  }

  async _handleInventoryRequest (params) {
    this._appendMessage(`{bold}Inventory:{/bold} ${JSON.stringify(this.documents, null, '  ')}`);
  }

  async _handleImportCommand (params) {
    if (!params[1]) return this._appendError(`You must provide a file to import.`);
    if (!fs.existsSync(params[1])) return this._appendError(`File does not exist: ${params[1]}`);
    const content = fs.readFileSync(params[1]);
    const actor = new Actor(content);
    this._appendMessage(`File contents (${content.length} bytes):\n---${content}\n---\nDocument ID: ${actor.id}`);
    this.documents[actor.id] = content;
    this._state.content.documents[actor.id] = content.toString('hex');
  }

  async _handlePublishCommand (params) {
    if (!params[1]) return this._appendError(`You must specify the file to publish.`);
    if (!params[2]) return this._appendError(`You must specify the rate to pay.`);
    if (!this.documents[params[1]]) return this._appendError(`This file does not exist in the local library.`);
    const message = Message.fromVector(['DocumentPublish', {
      id: params[1],
      content: this.documents[params[1]],
      reward: params[2]
    }]);
    this.node.broadcast(message);
  }

  async _handleRequestCommand (params) {
    if (!params[1]) return this._appendError(`You must specify the file to request.`);
    if (!params[2]) return this._appendError(`You must specify the rate to pay.`);
    const message = Message.fromVector(['DocumentRequest', {
      document: params[1]
    }]);
    this.node.broadcast(message);
  }

  async _handleBitcoinMessage (message) {
    switch (message['@type']) {
      case 'Snapshot':
        break;
      default:
        this._appendMessage(`Bitcoin service emitted message: ${JSON.stringify(message)}`);
        break;
    }
  }

  async _handleBitcoinLog (log) {
    this._appendMessage(`[SERVICES:BITCOIN] ${log}`);
  }

  async _handleBitcoinCommit (commit) {
    // this._appendMessage(`Bitcoin service emitted commit: ${JSON.stringify(commit)}`);
  }

  async _handleBitcoinSync (sync) {
    this._appendMessage(`Bitcoin service emitted sync: ${JSON.stringify(sync)}`);
    this._state.content.bitcoin.best = sync.best;
    this.commit();
  }

  async _handleBitcoinBlock (block) {
    // this._appendMessage(`Bitcoin service emitted block ${JSON.stringify(block)}, chain height now: ${this.bitcoin.height}`);
    // await this.bitcoin._syncChainInfoOverRPC();
    this._syncChainDisplay();
    // const message = Message.fromVector(['BlockCandidate', block.raw]);
    // this.node.relayFrom(this.node.id, message);
  }

  async _handleBitcoinTransaction (transaction) {
    this._appendMessage(`Bitcoin service emitted transaction: ${JSON.stringify(transaction)}`);
  }

  async _handleBitcoinDebug (...msg) {
    this._appendDebug(msg);
  }

  async _handleBitcoinError (...msg) {
    this._appendError(msg);
  }

  async _handleBitcoinWarning (...msg) {
    this._appendWarning(msg);
  }

  async _handleBitcoinReady (bitcoin) {
    this._syncChainDisplay();
  }

  async _handleConnectionOpen (msg) {
    this._appendMessage(`Node emitted "connections:open" event: ${JSON.stringify(msg)}`);

    await this._handleConnection(msg);

    this._syncConnectionList();
    this._syncPeerList();
  }

  async _handleConnectionClose (msg) {
    this._appendMessage(`Node emitted "connections:close" event: ${JSON.stringify(msg, null, '  ')}`);

    for (const id in this.peers) {
      const peer = this.peers[id];
      if (peer.address === msg.name) {
        this._appendMessage(`Address matches.`);
        delete this.peers[id];
      }
    }

    for (const id in this.connections) {
      const connections = this.connections[id];
      if (connections.address === msg.address) {
        delete this.connections[id];
      }
    }

    this._syncPeerList();
  }

  async _handleConnectionError (msg) {
    this._appendWarning(`Node emitted "connection:error" event: ${JSON.stringify(msg)}`);
  }

  async _handleConnection (connection) {
    if (!connection.id) {
      // TODO: exit function here
      this._appendWarning('Peer did not send an ID.  Event received: ' + JSON.stringify(connection));
    }

    // TODO: use @fabric/core/types/channel
    const channel = {
      id: Hash256.digest(`${this.node.id}:${connection.id}`),
      counterparty: connection.id
    };

    if (!this.connections[connection.id]) {
      this.connections[connection.id] = connection;
      this.emit('connection', connection);
    }

    /* if (!this.channels[channel.id]) {
      this.channels[channel.id] = channel;
    } */

    this._syncConnectionList();
    this.screen.render();
  }

  async _handleLightningCommit (commit) {
    // this._appendDebug(`Lightning service emitted commit: ${JSON.stringify(commit)}`);
    const data = this.tableDataFor(Object.values(commit.object.state.channels), [
      'id',
      'channel_id',
      'funding_txid'
    ]);

    this.elements['channellist'].setData(data);
  }

  async _handleLightningDebug (...msg) {
    this._appendError(`[SERVICES:LIGHTNING] debug: ${msg}`);
  }

  async _handleLightningError (...msg) {
    this._appendError(`[SERVICES:LIGHTNING] error: ${msg}`);
  }

  async _handleLightningWarning (...msg) {
    this._appendWarning(`[SERVICES:LIGHTNING] warning: ${msg}`);
  }

  async _handleLightningLog (...msg) {
    this._appendMessage(`[SERVICES:LIGHTNING] log: ${msg}`);
  }

  async _handleLightningMessage (...msg) {
    this._appendMessage(`[SERVICES:LIGHTNING] message: ${msg}`);
  }

  async _handleLightningReady (lightning) {
    this._appendMessage(`[SERVICES:LIGHTNING] ready: ${JSON.stringify(lightning, null, '  ')}`);
  }

  async _handleLightningSync (sync) {
    this._appendDebug(`[SERVICES:LIGHTNING] sync: ${JSON.stringify(sync, null, '  ')}`);
  }

  async _handlePeer (peer) {
    const self = this;
    // console.log('[SCRIPTS:CHAT]', 'Peer emitted by node:', peer);

    if (!peer.id) {
      self._appendMessage('Peer did not send an ID.  Event received: ' + JSON.stringify(peer));
    }

    // TODO: use @fabric/core/types/channel
    const channel = {
      id: Hash256.digest(`${self.node.id}:${peer.id}`),
      counterparty: peer.id
    };

    if (!self.peers[peer.id]) {
      self.peers[peer.id] = peer;
      self.emit('peer', peer);
    }

    if (!self.channels[channel.id]) {
      self.channels[channel.id] = channel;
    }

    self._syncPeerList();
    self.screen.render();
  }

  async _handlePeerDocumentPublish (message) {
    this._appendMessage('Peer requested document publish: ' + JSON.stringify(message));
  }

  async _handlePeerDocumentRequest (message) {
    this._appendMessage('Peer requested document delivery: ' + JSON.stringify(message));
  }

  async _handlePeerCandidate (peer) {
    const self = this;
    self._appendMessage('Local node emitted "peer:candidate" event: ' + JSON.stringify(peer));
    self.screen.render();
  }

  async _handleNodeReady (node) {
    if (this.settings.render) {
      // this.elements['identityString'].setContent(node.id);
    }

    this.emit('identity', {
      id: node.id,
      pubkey: node.pubkey
    });
  }

  async _handlePeerDebug (message) {
    this._appendDebug(`[NODE] ${message}`);
  }

  async _handlePeerError (message) {
    this._appendError(`[NODE] ${message}`);
  }

  async _handlePeerWarning (message) {
    this._appendWarning(`[NODE] ${message}`);
  }

  async _handlePeerLog (message) {
    this._appendMessage(`[NODE] ${message}`);
  }

  async _handlePeerChanges (changes) {
    // this._appendDebug(`[NODE] [CHANGES] ${JSON.stringify(changes)}`);
    this._applyChanges(changes);
    this.commit();
  }

  async _handlePeerCommit (commit) {
    // this._appendDebug(`[NODE] [COMMIT] ${JSON.stringify(commit)}`);
  }

  async _handlePeerChat (chat) {
    this._appendMessage(`[@${chat.actor.id}]: ${chat.object.content}`);
  }

  async _handlePeerUPNP (upnp) {
    this._appendDebug(`[UPNP] ${JSON.stringify(upnp)}`);
  }

  async _handlePeerMessage (message) {
    switch (message.type) {
      case 'ChatMessage':
        try {
          const parsed = JSON.parse(message.data);
          this._appendMessage(`[@${parsed.actor}]: ${parsed.object.content}`);
        } catch (exception) {
          this._appendError(`Could not parse <ChatMessage> data (should be JSON): ${message.data}`);
        }
        break;
      case 'BlockCandidate':
        this._appendMessage(`Received Candidate Block from peer: <${message.type}> ${message.data}`);
        this.bitcoin.append(message.data);
        break;
      default:
        if (!message.type && !message.data) {
          this._appendMessage(`Local "message" event: ${message}`);
        } else {
          this._appendMessage(`Local "message" event: <${message.type}> ${message.data}`);
        }
        break;
    }
  }

  async _handleSessionUpdate (session) {
    this._appendMessage(`Local session update: ${JSON.stringify(session, null, '  ')}`);
  }

  async _handleSocketData (data) {
    this._appendMessage(`Local "socket:data" event: ${JSON.stringify(data)}`);
  }

  async _handlePromptEnterKey (ch, key) {
    this.elements['prompt'].historyIndex = this.history.length;
    this.elements['form'].submit();
    this.elements['prompt'].clearValue();
    this.elements['prompt'].readInput();
  }

  async _handlePromptUpKey (ch, key) {
    const index = this.elements['prompt'].historyIndex;
    if (index > 0) this.elements['prompt'].historyIndex--;
    this.elements['prompt'].setValue(this.history[index]);
    this.screen.render();
  }

  async _handlePromptDownKey (ch, key) {
    const index = ++this.elements['prompt'].historyIndex;

    if (index < this.history.length) {
      this.elements['prompt'].setValue(this.history[index]);
    } else {
      this.elements['prompt'].historyIndex = this.history.length - 1;
      this.elements['prompt'].setValue('');
    }

    this.screen.render();
  }

  async _handleGenerateRequest (params) {
    if (!params[1]) params[1] = 1;
    const count = params[1];
    const address = await this.bitcoin.getUnusedAddress();
    this._appendMessage(`Generating ${count} blocks to address: ${address}`);
    this.bitcoin.generateBlocks(count, address);
    return false;
  }

  async _handleUnspentRequest (params) {
    await this._syncUnspent();
    this._appendMessage(`{bold}Unspent:{/bold} ${JSON.stringify(this._state.unspent, null, '  ')}`);
  }

  _bindKeys () {
    const self = this;

    // Exit
    self.screen.key(['C-c'], self.stop.bind(self));

    // Text Input
    self.screen.key(['i'], self.focusInput.bind(self));

    // TODO: debug with @melnx
    // self.elements['prompt'].on('blur', self.defocusInput.bind(self));

    self.elements['prompt'].key(['enter'], self._handlePromptEnterKey.bind(self));
    self.elements['prompt'].key(['up'], self._handlePromptUpKey.bind(self));
    self.elements['prompt'].key(['down'], self._handlePromptDownKey.bind(self));

    return true;
  }

  _sendToAllServices (message) {
    for (const [name, service] of Object.entries(this.services)) {
      if (this.settings.services.includes(name)) {
        service._send(message);
      }
    }
  }

  _handleFormSubmit (data) {
    const self = this;
    const content = data.input;

    if (!content) return self._appendMessage('No message provided.');
    if (content.length > MAX_CHAT_MESSAGE_LENGTH) return self._appendMessage(`Message exceeds maximum length (${MAX_CHAT_MESSAGE_LENGTH}).`);

    // Modify history
    self.history.push(data.input);

    // Send as Chat Message if no handler registered
    if (!self._processInput(data.input)) {
      // Describe the activity for use in P2P message
      const msg = {
        type: 'P2P_CHAT_MESSAGE',
        actor: {
          id: self.node.id
        },
        object: {
          created: Date.now(),
          content: content
        },
        target: '/messages'
      };

      const message = Message.fromVector(['ChatMessage', JSON.stringify(msg)]).sign();
      // this._appendDebug(`Chat Message created (${message.data.length} bytes): ${message.data}`);
      self.setPane('messages');

      // Log own message
      self._handlePeerChat(msg);

      // Relay to peers
      self.node.relayFrom(self.node.id, message);

      // Notify services
      self._sendToAllServices(msg);
    }

    self.elements['form'].reset();
    self.screen.render();
  }

  _handleQuitRequest () {
    this._appendMessage('Exiting...');
    this.stop();
    return false;
  }

  _handleAliasRequest (params) {
    if (!params) return false;
    if (!params[1]) {
      this._appendError('No alias provided.');
      return false;
    }

    this.node._announceAlias(params[1]);

    return false;
  }

  _handleClearRequest () {
    this.elements['messages'].setContent('');
    return false;
  }

  _handleFlushRequest () {
    this.flush();
    this.stop();
    return false;
  }

  _handlePeerListRequest (params) {
    this._appendMessage('Peers: ' + JSON.stringify(this.peers, null, ' '));
    return false;
  }

  _handleConnectRequest (params) {
    if (!params[1]) return this._appendMessage('You must specify an address to connect to.');
    const address = params[1];
    this._appendMessage('Connect request: ' + JSON.stringify(params));
    this.node._connect(address);
    return false;
  }

  _handleDisconnectRequest (params) {
    if (!params[1]) return this._appendMessage('You must specify an peer to disconnect from.');
    const id = params[1];
    this._appendMessage('Disconnect request: ' + JSON.stringify(params));
    this.node._disconnect(id);
    return false;
  }

  _handleChainSyncRequest () {
    this._appendMessage(`Sync starting for chain...`);

    // TODO: test this on testnet / mainnet
    this.bitcoin.fullnode.startSync();

    const message = Message.fromVector(['ChainSyncRequest', JSON.stringify({
      tip: this.bitcoin.fullnode.chain.tip
    })]);
    this.node.relayFrom(this.node.id, message);

    return false;
  }

  async spend (to, amount) {
    let tx = null;

    try {
      tx = await this.bitcoin._makeRPCRequest('sendtoaddress', [to, amount]);
    } catch (exception) {
      this._appendError(`Could not create transaction: ${JSON.stringify(exception)}`);
    }

    return tx;
  }

  async _handleBitcoinRequest (params) {
    if (!params[1]) return this._appendError('You must specify a method.');
    try {
      const result = await this.bitcoin._makeRPCRequest(params[1], params.slice(2));
      this._appendMessage(`[BITCOIN] ${params[1]}(${params.slice(2)}) ${JSON.stringify(result)}`);
    } catch (exception) {
      this._appendError(`[BITCOIN] Could not handle request: ${JSON.stringify(exception)}`);
    }
  }

  async _handleLightningRequest (params) {
    if (!params[1]) return this._appendError('You must specify a method.');
    try {
      const result = await this.lightning._makeRPCRequest(params[1], params.slice(2));
      this._appendMessage(`[LIGHTNING] ${params[1]}(${params.slice(2)}) ${JSON.stringify(result)}`);
    } catch (exception) {
      this._appendError(`[LIGHTNING] Could not handle request: ${JSON.stringify(exception)}`);
    }
  }

  async _handleRotateRequest () {
    const account = await this.identity._nextAccount();
    this._appendMessage('Rotated to Account: ' + account.id);
    return false;
  }

  async _handleSendRequest (params) {
    if (!params[1]) return this._appendError('You must specify an address to send to.');
    if (!params[2]) return this._appendError('You must specify an amount to send.');

    const address = params[1];
    const amount = params[2];

    const tx = await this.spend(address, amount);
    this._appendMessage(`Transaction created: ${tx}`);

    return false;
  }

  async _handleBalanceRequest () {
    const balance = await this._getBalance();
    this._appendMessage(`{bold}Wallet Balance{/bold}: ${JSON.stringify(balance, null, '  ')}`);
    return false;
  }

  async _handleReceiveAddressRequest () {
    const address = await this.node.wallet.getUnusedAddress();
    this._appendMessage(`{bold}Receive address{/bold}: ${JSON.stringify(address.toString(), null, '  ')}`);
    return false;
  }

  _handleServiceCommand (params) {
    const list = Object.keys(this.services);

    switch (params[1]) {
      case 'list':
      default:
        this._appendMessage(`{bold}Available Services{/bold}: ${JSON.stringify(list, null, '  ')}`);
        break;
      case 'state':
        const state = this.services[params[2]].state;
        this._appendMessage(`{bold}${params[2]}{/bold}: ${JSON.stringify(state, null, '  ')}`);

        break;
    }
  }

  _handleIdentityRequest () {
    this._appendMessage(`Local Identity: ${JSON.stringify({
      id: this.identity.id,
      pubkey: this.identity.pubkey,
      address: this.node.server.address(),
      endpoint: `${this.identity.id}@${this.settings.host}:${this.settings.port}`
    }, null, '  ')}`);
  }

  _handleSettingsRequest () {
    this._appendMessage(`Local Settings: ${JSON.stringify(this.settings, null, '  ')}`);
  }

  _handleHelpRequest (params) {
    let text = '';

    switch (params[1]) {
      default:
        text = `{bold}Fabric CLI Help{/bold}\nThe Fabric CLI offers a simple command-based interface to a Fabric-speaking Network.  You can use \`/connect <address>\` to establish a connection to a known peer, or any of the available commands.\n\n{bold}Available Commands{/bold}:\n\n${Object.keys(this.commands).map(x => `\t${x}`).join('\n')}\n`
        break;
    }

    this._appendMessage(text);
  }

  _handleServiceMessage (msg) {
    this.emit('message', 'received message from service:', msg);
  }

  _processInput (input) {
    if (input.charAt(0) === '/') {
      const parts = input.substring(1).split(' ');

      if (this.commands[parts[0]]) {
        this.commands[parts[0]].apply(this, [ parts ]);
        return true;
      }

      this._appendError('Unhandled command: ' + parts[0]);

      return true;
    }

    return false;
  }

  async _syncChainDisplay () {
    if (!this.settings.render) return this;

    try {
      const height = await this.bitcoin._makeRPCRequest('getblockcount');
      const stats = await this.bitcoin._makeRPCRequest('getblockchaininfo');
      const progress = this.bitcoin._state.headers.length;
      const unconfirmed = 0.0;
      const bonded = 0.0;

      this.elements['heightValue'].setContent(`${height}`);
      this.elements['chainTip'].setContent(`${stats.bestblockhash}`);
      this.elements['unconfirmedValue'].setContent(`${bonded}`);
      this.elements['bondedValue'].setContent(`${bonded}`);
      this.elements['progressStatus'].setContent(`${progress - 1} of ${height} (${(((progress - 1) / height) * 100)} %)`);

      this.screen.render();
    } catch (exception) {
      if (this.settings.debug) this._appendError(`Could not sync chain: ${exception}`);
    }
  }

  async _syncContracts () {
    await this._syncLightningChannels();
    return this;
  }

  async _syncBalance () {
    try {
      const balance = await this._getBalance();
      const balances = await this.bitcoin._syncBalances();
      const lightning = await this.lightning._syncBalances();

      this._state.balances.confirmed = balance;
      this._state.balances.trusted = balances.mine.trusted;
      this._state.balances.immature = balances.mine.immature;
      this._state.balances.pending = balances.mine.untrusted_pending;

      this.elements['balance'].setContent(balance.toFixed(8));

      this.elements.wallethelp.setContent(
        `  {bold}SPENDABLE{/bold}: ${balance.toFixed(8)} BTC\n` +
        `{bold}UNCONFIRMED{/bold}: ${this._state.balances.pending.toFixed(8)} BTC\n` +
        `   {bold}IMMATURE{/bold}: ${this._state.balances.immature.toFixed(8)} BTC\n`
      );

      this.screen.render();
    } catch (exception) {
      // if (this.settings.debug) this._appendError(`Could not sync balance: ${JSON.stringify(exception)}`);
    }
  }

  async _syncUnspent () {
    try {
      const unspent = await this.bitcoin._listUnspent();
      const list = unspent.map((x) => {
        const map = {};

        for (const [key, value] of Object.entries(x)) {
          map[key] = value.toString();
        }

        return Object.values(map);
      });

      this._state.unspent = unspent;

      const data = [
        Object.keys(unspent[0])
      ].concat(list);

      this.elements.outputlist.setData(data);

      this.commit();

      this.screen.render();
    } catch (exception) {
      // if (this.settings.debug) this._appendError(`Could not sync balance: ${JSON.stringify(exception)}`);
    }
  }

  async _syncLightningChannels () {
    this.elements.contracthelp.setContent(
      `   {bold}STATUS:{/bold} ${this.status}\n` +
      `{bold}LIGHTNING:{/bold} ${this.lightning.status}`);
    return this;
  }

  async _getBalance () {
    const result = await this.bitcoin._syncBalanceFromOracle();
    await this.lightning.sync();
    // this._appendDebug(`Lightning balances: ${JSON.stringify(this.lightning.balances)}`);
    const balance = result.data.content + this.lightning.balances.spendable;

    return balance;
  }

  _syncConnectionList () {
    this.elements['connections'].clearItems();

    for (const id in this.connections) {
      const connection = this.connections[id];

      let icon = '?';
      switch (connection.status) {
        default:
          icon = '…';
          break;
        case 'ready':
          icon = '✓';
          break;
      }

      const element = blessed.element({
        name: connection.id,
        content: `[${icon}] ${id}`
      });

      // TODO: use peer ID for managed list
      // self.elements['connections'].insertItem(0, element);
      this.elements['connections'].add(element.content);
    }
  }

  _syncPeerList () {
    this.elements['peers'].clearItems();

    for (const id in this.peers) {
      const peer = this.peers[id];
      const element = blessed.element({
        name: peer.id,
        content: `[✓] ${peer.id}@${peer.address}`
      });

      // TODO: use peer ID for managed list
      // self.elements['peers'].insertItem(0, element);
      this.elements['peers'].add(element.content);
    }
  }

  _registerCommand (command, method) {
    this.commands[command] = method.bind(this);
  }

  _registerService (name, type) {
    const self = this;
    const settings = merge({}, this.settings, this.settings[name]);
    const service = new type(settings);

    if (this.services[name]) {
      return this._appendWarning(`Service already registered: ${name}`);
    }

    this.services[name] = service;

    this.services[name].on('error', function (msg) {
      self._appendError(`Service "${name}" emitted error: ${JSON.stringify(msg, null, '  ')}`);
    });

    this.services[name].on('warning', function (msg) {
      self._appendWarning(`Service warning from ${name}: ${JSON.stringify(msg, null, '  ')}`);
    });

    this.services[name].on('message', function (msg) {
      self._appendMessage(`Service message from ${name}: ${JSON.stringify(msg, null, '  ')}`);
      self.node.relayFrom(self.node.id, Message.fromVector(['ChatMessage', JSON.stringify(msg)]));
    });

    this.on('identity', async function _registerActor (identity) {
      if (this.settings.services.includes(name)) {
        self._appendMessage(`Registering actor on service "${name}": ${JSON.stringify(identity)}`);

        try {
          const registration = await this.services[name]._registerActor(identity);
          self._appendMessage(`Registered Actor: ${JSON.stringify(registration, null, '  ')}`);
        } catch (exception) {
          self._appendError(`Error from service "${name}" during _registerActor: ${exception}`);
        }
      }
    });
  }

  focusInput () {
    this.elements['prompt'].clearValue();
    this.elements['prompt'].focus();
    this.screen.render();
  }

  defocusInput () {
    this.elements['prompt'].blur();
    this.screen.render();
  }

  setPane (name) {
    this.elements['home'].detach();
    // this.elements['logBox'].detach();
    this.elements['help'].detach();
    this.elements['contracts'].detach();
    this.elements['network'].detach();
    this.elements['walletBox'].detach();

    switch (name) {
      default:
        break;
      case 'home':
        this.screen.append(this.elements['home'])
        break;
      case 'help':
        this.screen.append(this.elements['help'])
        break;
      case 'contracts':
        this.screen.append(this.elements['contracts'])
        break;
      case 'messages':
        // this.screen.append(this.elements['logBox'])
        break;
      case 'network':
        this.screen.append(this.elements['network'])
        break;
      case 'wallet':
        this.screen.append(this.elements['walletBox'])
        break;
    }
  }

  render () {
    if (!this.settings.render) return this;

    const self = this;

    self.screen = blessed.screen({
      smartCSR: true,
      input: this.settings.input,
      output: this.settings.output,
      terminal: this.settings.terminal,
      fullUnicode: this.settings.fullUnicode
    });

    self.elements['home'] = blessed.box({
      parent: self.screen,
      content: 'Fabric Command Line Interface\nVersion 0.0.1-dev (@martindale)',
      top: 6,
      bottom: 4,
      border: {
        type: 'line'
      },
    });

    self.elements['help'] = blessed.box({
      parent: self.screen,
      label: '[ Help ]',
      content: 'Fabric Command Line Interface\nVersion 0.0.1-dev (@martindale)',
      border: {
        type: 'line'
      },
      top: 6,
      bottom: 4,
      width: '100%'
    });

    self.elements['contracts'] = blessed.box({
      parent: self.screen,
      label: '[ Contracts ]',
      border: {
        type: 'line'
      },
      top: 6,
      bottom: 4
    });

    self.elements['contracthelp'] = blessed.text({
      parent: self.elements.contracts,
      tags: true,
      top: 1,
      left: 2,
      right: 2
    });

    self.elements['lightningbook'] = blessed.box({
      parent: self.elements.contracts,
      label: '[ Lightning ]',
      border: {
        type: 'line'
      },
      top: 6,
      // height: 10
    });

    self.elements['channellist'] = blessed.table({
      parent: self.elements.lightningbook,
      data: [
        ['ID']
      ],
      width: '100%-2'
    });

    /*
    self.elements['contractbook'] = blessed.box({
      parent: self.elements.contracts,
      label: '[ Fabric ]',
      border: {
        type: 'line'
      },
      top: 16
    });

    self.elements['contractlist'] = blessed.table({
      parent: self.elements.contractbook,
      data: [
        ['ID', 'Status', 'Type', 'Bond', 'Confirmations', 'Last Modified', 'Link']
      ],
      width: '100%-2'
    });
    */

    self.elements['network'] = blessed.list({
      parent: self.screen,
      label: '{bold}[ Network ]{/bold}',
      tags: true,
      border: {
        type: 'line'
      },
      top: 6,
      bottom: 4,
      width: '100%'
    });

    self.elements['connections'] = blessed.list({
      parent: this.elements['network'],
      top: 0,
      bottom: 0
    });

    self.elements['logBox'] = blessed.box({
      parent: self.screen,
      top: 6,
      bottom: 4,
      width: '100%'
    });

    self.elements['walletBox'] = blessed.box({
      parent: self.screen,
      label: '{bold}[ Wallet ]{/bold}',
      tags: true,
      border: {
        type: 'line'
      },
      top: 6,
      bottom: 4,
      width: '100%'
    });

    self.elements['wallethelp'] = blessed.text({
      parent: self.elements.walletBox,
      tags: true,
      top: 1,
      left: 2,
      right: 2
    });

    self.elements['outputbook'] = blessed.box({
      parent: self.elements.walletBox,
      label: '[ Unspent Outputs ]',
      border: {
        type: 'line'
      },
      top: 16
    });

    self.elements['outputlist'] = blessed.table({
      parent: self.elements.outputbook,
      data: [
        ['syncing...']
      ],
      width: '100%-2',
      top: 0,
      bottom: 0
    });

    self.elements['menu'] = blessed.listbar({
      parent: self.screen,
      top: '100%-1',
      left: 0,
      right: 8,
      style: {
        selected: {
          background: 'white',
          border: '1'
        }
      },
      commands: {
        'Help': {
          keys: ['f1'],
          callback: function () {
            this.setPane('help');
          }.bind(this)
        },
        'Console': {
          keys: ['f2'],
          callback: function () {
            this.setPane('messages');
            return true;
          }.bind(this)
        },
        'Network': {
          keys: ['f3'],
          callback: function () {
            this.setPane('network');
          }.bind(this)
        },
        'Wallet': {
          keys: ['f4'],
          callback: function () {
            this.setPane('wallet');
          }.bind(this)
        },
        'Contracts': {
          keys: ['f5'],
          callback: function () {
            this.setPane('contracts');
          }.bind(this)
        },
      }
    });

    self.elements['status'] = blessed.box({
      parent: self.screen,
      label: '{bold}[ Status ]{/bold}',
      tags: true,
      border: {
        type: 'line'
      },
      top: 0,
      height: 6,
      width: '100%'
    });

    self.elements['identity'] = blessed.box({
      parent: self.elements['status'],
      left: 1
    });

    self.elements['identityLabel'] = blessed.text({
      parent: self.elements['identity'],
      content: 'IDENTITY:',
      top: 0,
      bold: true
    });

    self.elements['identityString'] = blessed.text({
      parent: self.elements['identity'],
      content: 'loading...',
      top: 0,
      left: 10
    });

    self.elements['wallet'] = blessed.box({
      parent: self.elements['status'],
      right: 1,
      width: 29,
      height: 4
    });

    self.elements['balance'] = blessed.text({
      parent: self.elements['wallet'],
      content: '0.00000000',
      top: 0,
      right: 4
    });

    self.elements['label'] = blessed.text({
      parent: self.elements['wallet'],
      content: 'BALANCE:',
      top: 0,
      right: 29,
      bold: true
    });

    self.elements['denomination'] = blessed.text({
      parent: self.elements['wallet'],
      content: 'BTC',
      top: 0,
      right: 0
    });

    self.elements['unconfirmed'] = blessed.box({
      parent: self.elements['status'],
      top: 1,
      left: 1
    });

    self.elements['unconfirmedLabel'] = blessed.text({
      parent: self.elements['unconfirmed'],
      content: 'UNCONFIRMED:',
      top: 0,
      right: 30,
      bold: true
    });

    self.elements['unconfirmedValue'] = blessed.text({
      parent: self.elements['unconfirmed'],
      content: 'syncing...',
      top: 0,
      right: 1
    });

    self.elements['bonded'] = blessed.box({
      parent: self.elements['status'],
      top: 2,
      left: 1
    });

    self.elements['bondedLabel'] = blessed.text({
      parent: self.elements['bonded'],
      content: 'BONDED:',
      top: 0,
      right: 30,
      bold: true
    });

    self.elements['bondedValue'] = blessed.text({
      parent: self.elements['bonded'],
      content: 'syncing...',
      top: 0,
      right: 1
    });

    self.elements['progress'] = blessed.box({
      parent: self.elements['status'],
      top: 3,
      left: 1
    });

    self.elements['progressLabel'] = blessed.text({
      parent: self.elements['progress'],
      content: 'SYNC:',
      top: 0,
      right: 30,
      bold: true
    });

    self.elements['progressStatus'] = blessed.text({
      parent: self.elements['progress'],
      content: 'syncing...',
      top: 0,
      right: 1
    });

    self.elements['chain'] = blessed.box({
      parent: self.elements['status'],
      top: 1,
      left: 1,
      width: 50
    });

    self.elements['chainLabel'] = blessed.text({
      parent: self.elements['chain'],
      content: 'CHAIN TIP:',
      bold: true
    });

    self.elements['chainTip'] = blessed.text({
      parent: self.elements['chain'],
      content: 'loading...',
      left: 11,
      width: 50
    });

    self.elements['height'] = blessed.box({
      parent: self.elements['status'],
      top: 2,
      left: 1,
      width: 62
    });

    self.elements['heightLabel'] = blessed.text({
      parent: self.elements['height'],
      content: 'CHAIN HEIGHT:',
      bold: true
    });

    self.elements['heightValue'] = blessed.text({
      parent: self.elements['height'],
      content: 'loading...',
      left: 14,
      width: 50
    });

    self.elements['mempool'] = blessed.box({
      parent: self.elements['status'],
      top: 3,
      left: 1,
      width: 29
    });

    self.elements['mempoolLabel'] = blessed.text({
      parent: self.elements['mempool'],
      content: 'MEMPOOL SIZE:',
      bold: true
    });

    self.elements['mempoolCount'] = blessed.text({
      parent: self.elements['mempool'],
      content: '0',
      left: 14
    });

    // MAIN LOG OUTPUT
    self.elements['messages'] = blessed.log({
      parent: this.screen,
      label: '{bold}[ Console ]{/bold}',
      tags: true,
      border: {
        type: 'line'
      },
      scrollbar: {
        style: {
          bg: 'white',
          fg: 'blue'
        }
      },
      top: 6,
      width: '80%',
      bottom: 4,
      mouse: true,
      tags: true
    });

    self.elements['peers'] = blessed.list({
      parent: self.screen,
      label: '{bold}[ Peers ]{/bold}',
      tags: true,
      border: {
        type: 'line'
      },
      top: 6,
      left: '80%+1',
      bottom: 4
    });

    self.elements['controls'] = blessed.box({
      parent: this.screen,
      label: '{bold}[ INPUT ]{/bold}',
      tags: true,
      bottom: 1,
      height: 3,
      border: {
        type: 'line'
      }
    });

    self.elements['form'] = blessed.form({
      parent: self.elements['controls'],
      bottom: 0,
      height: 1,
      left: 1
    });

    self.elements['prompt'] = blessed.textbox({
      parent: self.elements['form'],
      name: 'input',
      input: true,
      keys: true,
      inputOnFocus: true,
      value: INPUT_HINT,
      style: {
        fg: 'grey'
      }
    });

    // Set Index for Command History
    this.elements['prompt'].historyIndex = -1;

    // Render the screen.
    self.screen.render();
    self._bindKeys();

    // TODO: clean up workaround (from https://github.com/chjj/blessed/issues/109)
    self.elements['prompt'].oldFocus = self.elements['prompt'].focus;
    self.elements['prompt'].focus = function () {
      let oldListener = self.elements['prompt'].__listener;
      let oldBlur = self.elements['prompt'].__done;

      self.elements['prompt'].removeListener('keypress', self.elements['prompt'].__listener);
      self.elements['prompt'].removeListener('blur', self.elements['prompt'].__done);

      delete self.elements['prompt'].__listener;
      delete self.elements['prompt'].__done;

      self.elements['prompt'].screen.focusPop(self.elements['prompt'])

      self.elements['prompt'].addListener('keypress', oldListener);
      self.elements['prompt'].addListener('blur', oldBlur);

      self.elements['prompt'].oldFocus();
    };

    // focus when clicked
    self.elements['form'].on('click', function () {
      self.elements['prompt'].focus();
    });

    self.elements['form'].on('submit', self._handleFormSubmit.bind(self));
    // this.focusInput();

    this.elements['identityString'].setContent(this.identity.id);
    this.setPane('messages');

    setInterval(function () {
      // self._appendMessage('10 seconds have passed.');
      // self.bitcoin.generateBlock();
    }, 10000);
  }

  tableDataFor (input = [], exclusions = []) {
    const keys = [];
    const entries = input.map((x) => {
      const map = {};

      for (const [key, value] of Object.entries(x)) {
        if (exclusions.includes(key)) continue;
        if (!keys.includes(key)) keys.push(key);
        map[key] = value.toString();
      }

      return Object.values(map);
    });

    return [ keys ].concat(entries);
  }
}

module.exports = CLI;
