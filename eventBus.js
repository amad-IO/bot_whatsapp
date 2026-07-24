'use strict';
const EventEmitter = require('events');

// Shared event bus for notifying connected SSE clients
// when reminders are added or updated.
const eventBus = new EventEmitter();
eventBus.setMaxListeners(50); // support many desktop clients

module.exports = eventBus;
