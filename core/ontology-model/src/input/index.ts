// `@dqa-ai-solutions/ontology-sdk/input` — typed-input parsing without the storage adapters,
// so a browser bundle can read a form the way the server will check it.
export { parseTypedInput, type ParseResult, type ParseOptions, type ParseFailureReason } from './typed-input.js'
export {
  collectInstanceDataErrors, checkPropertyValue, fileViolation, isIsoDate, isIsoDateTime, type ValueViolation,
} from '../core/graph/validation.js'
export {
  DEFAULT_TEXT_MAX_LENGTH,
  DEFAULT_MAX_ITEMS,
  DEFAULT_JSON_MAX_LENGTH,
  type PropertyDef,
  type PropertyType,
} from '../types/concepts.js'
