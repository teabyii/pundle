/* @flow */

import send from 'send'
import debug from 'debug'
import express from 'express'
import unique from 'lodash.uniq'
import arrayDiff from 'lodash.difference'
import cliReporter from 'pundle-reporter-cli'
import { Disposable } from 'sb-event-kit'
import { createWatcher, getRelativeFilePath, MessageIssue } from 'pundle-api'
import type { File } from 'pundle-api/types'
import * as Helpers from './helpers'

const debugTick = debug('PUNDLE:DEV:TICK')
let Server
try {
  // eslint-disable-next-line global-require
  Server = require('uws').Server
} catch (_) {
  // eslint-disable-next-line global-require
  Server = require('ws').Server
}

const browserFile = require.resolve('./browser')
// NOTE: HMR server will not be created unless server is provided
export async function attachMiddleware(pundle: Object, givenConfig: Object = {}, expressApp: Object, server: Object): Disposable {
  if (pundle.compilation.config.entry.indexOf(browserFile) !== -1) {
    throw new Error('Cannot create two middlewares on one Pundle instance')
  }

  const state = {
    booted: false,
    active: true,
    changed: true,
    compiled: { contents: '', sourceMap: {}, filePaths: [] },
    compileQueue: Promise.resolve(),
  }
  const config = Helpers.fillMiddlewareConfig(givenConfig)
  const hmrEnabled = config.hmrPath !== null
  const sourceMapEnabled = config.sourceMap && config.sourceMapPath !== 'none' && config.sourceMapPath !== 'inline'
  const connections = new Set()
  const filesChanged = new Set()
  const oldHMRPath = pundle.compilation.config.replaceVariables.SB_PUNDLE_HMR_PATH
  const oldHMRHost = pundle.compilation.config.replaceVariables.SB_PUNDLE_HMR_HOST

  let totalFiles
  let watcherSubscription
  const bootupPromise = Helpers.deferPromise()

  function writeToConnections(contents) {
    connections.forEach(connection => connection.send(JSON.stringify(contents)))
  }
  async function compileContentsHMR() {
    const changedFilePaths = unique(Array.from(filesChanged))
    const relativeChangedFilePaths = changedFilePaths.map(i => getRelativeFilePath(i, pundle.compilation.config.rootDirectory))
    const infoMessage = `Sending HMR to ${connections.size} clients of [ ${
      relativeChangedFilePaths.length > 4 ? `${relativeChangedFilePaths.length} files` : relativeChangedFilePaths.join(', ')
    } ]`
    pundle.compilation.report(new MessageIssue(infoMessage, 'info'))
    writeToConnections({ type: 'report-clear' })
    const generated = await pundle.generate(totalFiles.filter(entry => ~changedFilePaths.indexOf(entry.filePath)), {
      entry: [],
      wrapper: 'none',
      sourceMap: config.sourceMap,
      sourceMapPath: 'inline',
      sourceNamespace: 'app',
      sourceMapNamespace: `hmr-${Date.now()}`,
    })
    const newFiles = arrayDiff(generated.filePaths, state.compiled.filePaths)
    writeToConnections({ type: 'hmr', contents: generated.contents, files: generated.filePaths, newFiles })
    filesChanged.clear()
  }
  async function compileContentsAll() {
    state.compiled = await pundle.generate(totalFiles, {
      wrapper: 'hmr',
      sourceMap: config.sourceMap,
      sourceMapPath: config.sourceMapPath,
      sourceNamespace: 'app',
    })
  }
  async function compileContentsIfNecessary() {
    if (state.changed) {
      state.changed = false
      state.compileQueue = state.compileQueue.then(() => compileContentsAll())
    }
    await state.compileQueue
  }

  expressApp.get(config.bundlePath, function(req, res, next) {
    if (state.active) {
      Promise.all([bootupPromise.promise, watcherSubscription && watcherSubscription.queue])
        .then(compileContentsIfNecessary)
        .then(() => res.set('content-type', 'application/javascript').end(state.compiled.contents))
    } else next()
  })
  if (sourceMapEnabled) {
    expressApp.get(config.sourceMapPath, function(req, res, next) {
      if (state.active) {
        Promise.all([bootupPromise.promise, watcherSubscription && watcherSubscription.queue])
          .then(compileContentsIfNecessary)
          .then(() => res.set('content-type', 'application/json').end(JSON.stringify(state.compiled.sourceMap)))
      } else next()
    })
  }

  let wss
  if (hmrEnabled) {
    wss = new Server({ server, path: config.hmrPath })
    wss.on('connection', function(connection) {
      if (state.active) {
        connection.on('close', () => connections.delete(connection))
        connections.add(connection)
      }
    })
  }

  pundle.compilation.config.entry.unshift(browserFile)
  pundle.compilation.config.replaceVariables.SB_PUNDLE_HMR_PATH = JSON.stringify(config.hmrPath)
  pundle.compilation.config.replaceVariables.SB_PUNDLE_HMR_HOST = JSON.stringify(config.hmrHost)
  const configSubscription = new Disposable(function() {
    state.active = false
    const entryIndex = pundle.compilation.config.entry.indexOf(browserFile)
    if (entryIndex !== -1) {
      pundle.compilation.config.entry.splice(entryIndex, 1)
    }
    pundle.compilation.config.replaceVariables.SB_PUNDLE_HMR_PATH = oldHMRPath
    pundle.compilation.config.replaceVariables.SB_PUNDLE_HMR_HOST = oldHMRHost
  })

  const componentSubscription = await pundle.loadComponents([
    [cliReporter, {
      log(text, error) {
        if (config.hmrReports && error.severity && error.severity !== 'info') {
          writeToConnections({ type: 'report', text, severity: error.severity || 'error' })
        }
      },
    }],
    createWatcher({
      tick(_: Object, filePath: string, error: ?Error) {
        debugTick(`${filePath} :: ${error ? error.message : 'null'}`)
        if (!error && filePath !== browserFile && state.booted) {
          filesChanged.add(filePath)
          return
        }
      },
      ready(_, initalStatus) {
        if (initalStatus) {
          this.report(new MessageIssue('Server initialized successfully', 'info'))
        } else {
          this.report(new MessageIssue('Server initialized with errors', 'info'))
        }
      },
      async compile(_: Object, givenTotalFiles: Array<File>) {
        const oldBooted = state.booted

        totalFiles = givenTotalFiles
        state.booted = true
        state.changed = true
        bootupPromise.resolve()
        if (hmrEnabled && oldBooted && connections.size && filesChanged.size) {
          compileContentsHMR()
        }
      },
    }),
  ])

  watcherSubscription = await pundle.watch()

  return new Disposable(function() {
    if (wss) {
      wss.close()
    }
    configSubscription.dispose()
    watcherSubscription.dispose()
    componentSubscription.dispose()
  })
}

// NOTE: Make SURE to setup the static handler AFTER middleware is invoked and
//       that the middleware doesn't await before registering the route
// NOTE: Also accepts all of middleware options
// NOTE: The return value has a `server` and `app` property that references express instance and server instance
export async function createServer(pundle: Object, givenConfig: Object): Promise<Disposable> {
  const app = express()
  const config = Helpers.fillServerConfig(givenConfig)

  const server = app.listen(config.port)
  const middlewarePromise = attachMiddleware(pundle, givenConfig, app, server)
  app.use('/', express.static(config.rootDirectory))
  if (config.redirectNotFoundToIndex) {
    app.use(function(req, res, next) {
      if (req.url !== '/index.html' && req.baseUrl !== '/index.html') {
        req.baseUrl = req.url = '/index.html'
        send(req, req.baseUrl, { root: config.rootDirectory, index: 'index.html' })
          .on('error', next)
          .on('directory', next)
          .pipe(res)
      } else next()
    })
  }
  const subscription = await middlewarePromise
  const disposable = new Disposable(function() {
    server.close()
    subscription.dispose()
  })

  disposable.app = app
  disposable.server = server
  return disposable
}
