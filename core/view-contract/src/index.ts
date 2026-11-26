// @dqa-ai-solutions/view-contract — what an app declares about a screen, and the flat contract a
// renderer receives. The server resolves a declaration into a `ViewContract`
// (@dqa-ai-solutions/app-runtime `resolveView`); a renderer — React, Flutter, a print sheet — draws
// it and asks nothing else. This is the boundary between the two: types and vocabulary only.
export * from './contract.js'
export * from './task.js'
