'use strict'

var util = require('util')

var ObjectIdentityMap = require('object-identity-map')
var entries = require('object.entries')

var getPathFromRequest = require('./express-utils').getPathFromRequest
var GenericSpan = require('./generic-span')
var parsers = require('../parsers')
var Span = require('./span')
var symbols = require('../symbols')

module.exports = Transaction

util.inherits(Transaction, GenericSpan)

function Transaction (agent, name, type, opts = {}) {
  GenericSpan.call(this, agent, type, opts)

  const verb = this.parentId ? 'continue' : 'start'
  agent.logger.debug('%s trace %o', verb, { trans: this.id, parent: this.parentId, trace: this.traceId, name: name, type: type })

  agent._instrumentation.currentTransaction = this
  agent._instrumentation.activeSpan = null

  this._defaultName = name || ''
  this._customName = ''
  this._user = null
  this._custom = null
  this._result = 'success'
  this._builtSpans = 0
  this._droppedSpans = 0
  this._contextLost = false // TODO: Send this up to the server some how
  this._abortTime = 0
  this._breakdownTimings = new ObjectIdentityMap()
}

Object.defineProperty(Transaction.prototype, 'name', {
  configurable: true,
  enumerable: true,
  get () {
    // Fall back to a somewhat useful name in case no _defaultName is set.
    // This might happen if res.writeHead wasn't called.
    return this._customName ||
      this._defaultName ||
      (this.req ? this.req.method + ' unknown route (unnamed)' : 'unnamed')
  },
  set (name) {
    if (this.ended) {
      this._agent.logger.debug('tried to set transaction.name on already ended transaction %o', { trans: this.id, parent: this.parentId, trace: this.traceId })
      return
    }
    this._agent.logger.debug('setting transaction name %o', { trans: this.id, parent: this.parentId, trace: this.traceId, name: name })
    this._customName = name
  }
})

Object.defineProperty(Transaction.prototype, 'result', {
  configurable: true,
  enumerable: true,
  get () {
    return this._result
  },
  set (result) {
    if (this.ended) {
      this._agent.logger.debug('tried to set transaction.result on already ended transaction %o', { trans: this.id, parent: this.parentId, trace: this.traceId })
      return
    }
    this._agent.logger.debug('setting transaction result %o', { trans: this.id, parent: this.parentId, trace: this.traceId, result: result })
    this._result = result
  }
})

Transaction.prototype.setUserContext = function (context) {
  if (!context) return
  this._user = Object.assign(this._user || {}, context)
}

Transaction.prototype.setCustomContext = function (context) {
  if (!context) return
  this._custom = Object.assign(this._custom || {}, context)
}

Transaction.prototype.startSpan = function (name, type, opts) {
  if (!this.sampled) {
    return null
  }

  if (this.ended) {
    this._agent.logger.debug('transaction already ended - cannot build new span %o', { trans: this.id, parent: this.parentId, trace: this.traceId }) // TODO: Should this be supported in the new API?
    return null
  }
  if (this._builtSpans >= this._agent._conf.transactionMaxSpans) {
    this._droppedSpans++
    return null
  }
  this._builtSpans++

  // To be backwards compatible with the old API, we also accept a `traceparent` string
  if (typeof opts === 'string') opts = { childOf: opts }

  return new Span(this, name, type, opts)
}

Transaction.prototype.toJSON = function () {
  var payload = {
    id: this.id,
    trace_id: this.traceId,
    parent_id: this.parentId,
    name: this.name,
    type: this.type,
    duration: this.duration(),
    timestamp: this.timestamp,
    result: String(this.result),
    sampled: this.sampled,
    context: undefined,
    sync: this.sync,
    span_count: {
      started: this._builtSpans
    }
  }

  if (this.sampled) {
    payload.context = {
      user: Object.assign(
        {},
        this.req && parsers.getUserContextFromRequest(this.req),
        this._user
      ),
      tags: this._labels || {},
      custom: this._custom || {}
    }

    // Only include dropped count when spans have been dropped.
    if (this._droppedSpans > 0) {
      payload.span_count.dropped = this._droppedSpans
    }

    var conf = this._agent._conf
    if (this.req) {
      payload.context.request = parsers.getContextFromRequest(this.req, conf, 'transactions')
    }
    if (this.res) {
      payload.context.response = parsers.getContextFromResponse(this.res, conf)
    }
  }

  return payload
}

Transaction.prototype._encode = function () {
  if (!this.ended) {
    this._agent.logger.error('cannot encode un-ended transaction: %o', { trans: this.id, parent: this.parentId, trace: this.traceId })
    return null
  }

  return this.toJSON()
}

Transaction.prototype.setDefaultName = function (name) {
  this._agent.logger.debug('setting default transaction name: %s %o', name, { trans: this.id, parent: this.parentId, trace: this.traceId })
  this._defaultName = name
}

Transaction.prototype.setDefaultNameFromRequest = function () {
  var req = this.req
  var path = getPathFromRequest(req, false, this._agent._conf.usePathAsTransactionName)

  if (!path) {
    this._agent.logger.debug('could not extract route name from request %o', {
      url: req.url,
      type: typeof path,
      null: path === null, // because typeof null === 'object'
      route: !!req.route,
      regex: req.route ? !!req.route.regexp : false,
      mountstack: req[symbols.expressMountStack] ? req[symbols.expressMountStack].length : false,
      trans: this.id,
      parent: this.parentId,
      trace: this.traceId
    })
    path = 'unknown route'
  }

  this.setDefaultName(req.method + ' ' + path)
}

Transaction.prototype.ensureParentId = function () {
  return this._context.ensureParentId()
}

Transaction.prototype.end = function (result, endTime) {
  if (this.ended) {
    this._agent.logger.debug('tried to call transaction.end() on already ended transaction %o', { trans: this.id, parent: this.parentId, trace: this.traceId })
    return
  }

  if (result !== undefined && result !== null) {
    this.result = result
  }

  if (!this._defaultName && this.req) this.setDefaultNameFromRequest()

  this._timer.end(endTime)
  this._captureBreakdown(this)
  this.ended = true

  var trans = this._agent._instrumentation.currentTransaction

  // These two edge-cases should normally not happen, but if the hooks into
  // Node.js doesn't work as intended it might. In that case we want to
  // gracefully handle it. That involves ignoring all spans under the given
  // transaction as they will most likely be incomplete. We still want to send
  // the transaction without any spans as it's still valuable data.
  if (!trans) {
    this._agent.logger.debug('WARNING: no currentTransaction found %o', { current: trans, spans: this._builtSpans, trans: this.id, parent: this.parentId, trace: this.traceId })
    this._contextLost = true
  } else if (trans !== this) {
    this._agent.logger.debug('WARNING: transaction is out of sync %o', { other: trans.id, spans: this._builtSpans, trans: this.id, parent: this.parentId, trace: this.traceId })
    this._contextLost = true
  }

  this._agent._instrumentation.addEndedTransaction(this)
  this._agent.logger.debug('ended transaction %o', { trans: this.id, parent: this.parentId, trace: this.traceId, type: this.type, result: this.result, name: this.name })
}

Transaction.prototype._captureBreakdown = function (span) {
  if (this.ended) return
  const agent = this._agent
  const metrics = agent._metrics
  const conf = agent._conf

  // Record span data
  if (this.sampled && conf.breakdownMetrics) {
    captureBreakdown(this, {
      transaction: transactionBreakdownDetails(this),
      span: spanBreakdownDetails(span)
    }, span._timer.selfTime)
  }

  // Record transaction data
  if (span instanceof Transaction) {
    const { duration } = this._timer
    const labels = flattenBreakdown({
      transaction: transactionBreakdownDetails(this)
    })

    metrics.getOrCreateCounter('transaction.duration.count', labels).inc()
    metrics.getOrCreateCounter('transaction.duration.sum.us', labels).inc(duration)
    metrics.getOrCreateCounter('transaction.breakdown.count', labels).inc(this.sampled ? 1 : 0)

    for (const { labels, time, count } of this._breakdownTimings.values()) {
      const flattenedLabels = flattenBreakdown(labels)
      metrics.getOrCreateCounter('span.self_time.count', flattenedLabels).inc(count)
      metrics.getOrCreateCounter('span.self_time.sum.us', flattenedLabels).inc(time)
    }
  }
}

function transactionBreakdownDetails ({ name, type } = {}) {
  return {
    name,
    type
  }
}

function spanBreakdownDetails (span) {
  if (span instanceof Transaction) {
    return {
      type: 'app'
    }
  }

  const [type, subtype] = span.type.split('.')
  return {
    type,
    subtype
  }
}

function captureBreakdown (transaction, labels, time) {
  const build = () => ({ labels, count: 0, time: 0 })
  const counter = transaction._breakdownTimings.ensure(labels, build)
  counter.time += time
  counter.count++
}

function flattenBreakdown (source, target = {}, prefix = '') {
  for (const [key, value] of entries(source)) {
    if (typeof value === 'undefined') continue
    if (typeof value === 'object') {
      flattenBreakdown(value, target, `${prefix}${key}::`)
    } else {
      target[`${prefix}${key}`] = value
    }
  }

  return target
}
