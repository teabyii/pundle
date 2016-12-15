/* @flow */

export type MiddlewareConfig = {
  hmrPath: ?string,
  // NOTE: ^ Set to null to disable hmr
  bundlePath: string,
  sourceMap: boolean,
  sourceMapPath: 'none' | 'inline' | string,
}

export type ServerConfig = {
  port: number,
  directory: string,
  redirectNotFoundToIndex: boolean,
  // ^ Setting this to true means it'll redirect all 404 requests to index
}