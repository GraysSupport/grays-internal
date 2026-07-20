// Loaded automatically by react-scripts before every test file (CRA convention:
// setupFilesAfterEnv), so everything here is in place before a test module is imported.
//
// jest-dom's matchers (toBeDisabled, toHaveTextContent, …) let component tests assert on the
// rendered DOM the way a rep experiences it, rather than on React internals.
import '@testing-library/jest-dom';

// ---- see also: the jest.moduleNameMapper block in package.json -----------------
// package.json cannot carry a comment, so the explanation lives here. That mapper points
// `react-router-dom` and `react-router/dom` at the CJS files those packages actually ship,
// because react-router-dom@7.7.1 declares a "main" it does not ship and jest 27 (pinned by
// CRA 5) predates the "exports" field that saves Node.
//
// ⚠️ It is pinned to react-router's INTERNAL dist layout (`dist/development/dom-export.js`),
// which is not public API. `npm ci` installs from the lockfile so CI is stable, but a
// react-router major bump may move those files. The failure is loud, not silent — tests die
// with "Cannot find module" — so if that appears after a dependency update, re-check the
// paths in package.json against the package's real dist/ contents rather than the exports map.

// ---- jsdom gaps that block react-router v7 -------------------------------------
// CRA 5 pins jest 27 / jsdom 16, which predates TextEncoder/TextDecoder being global in the
// browser-like environment. react-router v7 reads them at MODULE level, so without these any
// test that imports a page (every page imports react-router-dom) dies on import with
// "ReferenceError: TextEncoder is not defined" — before a single assertion runs.
//
// Assigned only when missing, so a future CRA/jsdom upgrade that ships its own silently takes
// over instead of being shadowed by node's.
import { TextEncoder, TextDecoder } from 'node:util';

if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
