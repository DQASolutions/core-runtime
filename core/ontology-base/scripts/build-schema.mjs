// The ONE source of the ontology file schema. Writes it twice, same content:
//   schema/ontology-file.schema.json   for JSON tooling and Rust (jsonschema crate)
//   schema/ontology-file.schema.yaml   for people and YAML tooling
//   node scripts/build-schema.mjs           write both
//   node scripts/build-schema.mjs --check   exit 1 if either file differs (the test runs this)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'schema')

const SAFE = '^[A-Za-z][A-Za-z0-9_]*$'
const NONBLANK = '\\S'
const TEXTLIKE = ['text', 'file', 'catalogue']
// Which keyword means something on which property type — the same table as the SDK's
// constraintDeclarationError. A keyword on another type is refused, not ignored.
const KEYWORD_TYPES = {
  minLength: [...TEXTLIKE, 'text[]'], maxLength: [...TEXTLIKE, 'text[]', 'json'], pattern: [...TEXTLIKE, 'text[]'],
  minimum: ['number'], maximum: ['number'], exclusiveMinimum: ['number'], exclusiveMaximum: ['number'], multipleOf: ['number'],
  minItems: ['text[]'], maxItems: ['text[]'], formatMinimum: ['date', 'datetime'], formatMaximum: ['date', 'datetime'],
  accept: ['file'], maxBytes: ['file'],
}
const DATE = '^\\d{4}-\\d{2}-\\d{2}$'
const DATETIME = '^\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}(?::?\\d{2})?)?)?$'
const PROPERTY_TYPES = ['text', 'number', 'date', 'datetime', 'enum', 'uuid', 'json', 'text[]', 'file', 'catalogue']
const PROVENANCE_FIELDS = ['id', 'source_ref', 'confirmed_by', 'confirmed_at']
const count = { type: 'integer', minimum: 0 }
const finite = { type: 'number' }
const boundForm = 'In the property type\'s own form: YYYY-MM-DD for date, ISO 8601 for datetime.'
const keywordValues = {
  minLength: count, maxLength: count, minItems: count, maxItems: count,
  pattern: { type: 'string', minLength: 1, description: 'ECMAScript regex, tested as written. The kernel also requires it to compile as `^(?:…)$` with flag `v`, as a browser does.' },
  minimum: finite, maximum: finite, exclusiveMinimum: finite, exclusiveMaximum: finite,
  multipleOf: { type: 'number', exclusiveMinimum: 0 },
  formatMinimum: { type: 'string', description: boundForm },
  formatMaximum: { type: 'string', description: boundForm },
  accept: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^(\\.[A-Za-z0-9]+|[a-z]+/(\\*|[A-Za-z0-9.+-]+))$' } },
  maxBytes: { type: 'integer', minimum: 1 },
}
const applicability = Object.entries(KEYWORD_TYPES).map(([kw, types]) => ({
  if: { type: 'object', required: [kw], properties: { [kw]: true } }, then: { properties: { type: { enum: types } } },
}))
const formBounds = ['formatMinimum', 'formatMaximum'].flatMap((kw) => [
  { if: { type: 'object', required: [kw, 'type'], properties: { [kw]: true, type: { const: 'date' } } }, then: { properties: { [kw]: { type: 'string', pattern: DATE } } } },
  { if: { type: 'object', required: [kw, 'type'], properties: { [kw]: true, type: { const: 'datetime' } } }, then: { properties: { [kw]: { type: 'string', pattern: DATETIME } } } },
])

export const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:dqa:ontology-base:ontology-file',
  title: 'Ontology file',
  description: [
    'One ontology file, as the kernel reads it today (@dqa-ai-solutions/ontology-loader loadOntologyFiles, @dqa-ai-solutions/ontology-sdk SchemaRegistry).',
    'Written in YAML (.yaml, .yml) or JSON (.json); JSON is YAML, so one parser reads both. An empty file is an empty mapping.',
    'An ontology may be spread over many files; they are merged in order.',
    'Keys this schema does not name are allowed everywhere: a project adds its own keys, and an engine that does not understand a key ignores it.',
    'What JSON Schema cannot say, the kernel still checks — see conformance/cases.yaml (level `kernel`): names unique across files, a property declared once,',
    'relationship ends that name a declared entity, valueType names that resolve and match the property type, lower bound not above upper bound, patterns that compile.',
  ].join(' '),
  type: 'object',
  properties: {
    valueTypes: { type: 'array', items: { $ref: '#/definitions/ValueType' } },
    entities: { type: 'array', items: { $ref: '#/definitions/EntityType' } },
    relationships: { type: 'array', items: { $ref: '#/definitions/RelationshipType' } },
  },
  definitions: {
    Name: { type: 'string', pattern: SAFE, description: 'A system-wide identifier: a letter, then letters, digits or _.' },
    PropertyType: { enum: PROPERTY_TYPES },
    Keywords: {
      description: 'Value constraints — JSON Schema validation keywords, borrowed whole. Each applies only to the property types the kernel lists for it.',
      type: 'object',
      properties: keywordValues,
      allOf: [...applicability, ...formBounds],
    },
    ValueType: {
      description: 'A named set of constraints, declared once and pointed at by name (a property says `valueType: <name>`).',
      allOf: [
        { $ref: '#/definitions/Keywords' },
        { type: 'object', required: ['name', 'type'],
          properties: { name: { type: 'string', minLength: 1 }, type: { $ref: '#/definitions/PropertyType' }, description: { type: 'string' } } },
      ],
    },
    Property: {
      allOf: [
        { $ref: '#/definitions/Keywords' },
        { type: 'object', required: ['name', 'type'],
          properties: {
            name: { allOf: [{ $ref: '#/definitions/Name' }, { not: { enum: PROVENANCE_FIELDS } }],
              description: 'Not a provenance field: the kernel adds id, source_ref, confirmed_by and confirmed_at to every entity itself.' },
            type: { $ref: '#/definitions/PropertyType' },
            required: { type: 'boolean' },
            description: { type: 'string' },
            enumValues: { type: 'array', minItems: 1, items: { type: 'string' } },
            catalogue: { $ref: '#/definitions/Name' },
            valueType: { type: 'string', minLength: 1 },
          } },
        { if: { type: 'object', required: ['type'], properties: { type: { const: 'enum' } } }, then: { type: 'object', required: ['enumValues'] } },
        { if: { type: 'object', required: ['type'], properties: { type: { const: 'catalogue' } } }, then: { type: 'object', required: ['catalogue'] } },
      ],
    },
    EntityType: {
      type: 'object', required: ['name', 'label'],
      properties: {
        name: { $ref: '#/definitions/Name' },
        label: { type: 'string', pattern: NONBLANK },
        properties: { type: 'array', items: { $ref: '#/definitions/Property' } },
      },
    },
    RelationshipType: {
      type: 'object', required: ['name', 'from', 'to', 'cardinality', 'directed'],
      properties: {
        name: { $ref: '#/definitions/Name' },
        from: { type: 'string', pattern: NONBLANK, description: 'The name of a declared entity.' },
        to: { type: 'string', pattern: NONBLANK, description: 'The name of a declared entity.' },
        cardinality: { enum: ['1..1', '1..N', 'N..1', 'N..N'] },
        directed: { type: 'boolean', description: 'Which end a traversal may walk from. Required: left out, it used to read as undirected.' },
        description: { type: 'string' },
      },
    },
  },
}

const files = {
  'ontology-file.schema.json': JSON.stringify(schema, null, 2) + '\n',
  'ontology-file.schema.yaml': '# GENERATED by scripts/build-schema.mjs — same content as ontology-file.schema.json. Do not edit.\n'
    + yaml.dump(schema, { lineWidth: 120, noRefs: true }),
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  let stale = false
  fs.mkdirSync(out, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(out, name)
    const now = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    if (now === text) continue
    if (check) { stale = true; console.error(`✗ schema/${name} is out of date — run: node scripts/build-schema.mjs`) }
    else { fs.writeFileSync(p, text); console.log(`wrote schema/${name}`) }
  }
  process.exit(stale ? 1 : 0)
}
