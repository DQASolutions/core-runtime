// Types for the view layer: what an app DECLARES, and what a renderer RECEIVES.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE ONE IDEA
//
//   A screen is a LENS over the ontology — not a substrate of its own.
//   The same object set is a table, a queue, a record page, a form; only the
//   lens differs. So the app never describes a *screen*: it describes which
//   lens to open and how to lay it out. Everything else — the field's type,
//   its label, who may act on the record, which step comes next, what the law
//   says — is already declared in the ontology and the workflow.
//
//   This package RESOLVES a declaration into a `ViewContract`: a flat, fully
//   answered description that a renderer can draw without asking anything else.
//   No React here, no HTML — a contract, so one declaration can drive a web
//   table, a print sheet, or a terminal list.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReadersDecl, TaskDecl } from './task.js'
import type { EntityTypeDef, RelationshipTypeDef, PropertyDef, ValueTypeDef } from '@dqa-ai-solutions/ontology-model'
import type {
  Tone, ValueMeaning, Visibility, PropertyKey, PropertyStatus,
  TypeClasses, Derived, LegacyCountLinks, ColumnPriority, Sortable,
} from './vocabulary.js'

export * from './vocabulary.js'

// ── What the app declares ─────────────────────────────────────────────────

/**
 * Enum labels, declared next to the value.
 *
 * ⚠️ `PropertyDef.enumValues` in the SDK is `string[]` — machine codes with no
 *    human wording. Every app that has shipped so far therefore kept a second,
 *    parallel table of labels inside its UI code, which is how a screen ends up
 *    printing `needs_repair` at a user. Declare the wording where the value is
 *    declared, once.
 */
export interface EnumValueDecl {
  value: string
  label: string
  /** Visual weight, not colour. The renderer maps it to its own palette. */
  tone?: Tone
}

/**
 * A property whose value is not stored but COMPUTED at read time.
 *
 * ⚠️ The full borrowed set — see `vocabulary.ts`. An earlier version of this
 *    type carried two kinds and a paragraph explaining why two was the right
 *    number. The paragraph was reasoning from the sample in front of it; the
 *    third kind it dismissed turned out to be needed two entities later.
 *
 * Still NOT a derived property: anything needing a calendar, a lookup table, or
 * a rule. Those are functions, and functions belong in code — `widgets: cell.*`.
 */
export type DerivedDecl = Derived | LegacyCountLinks

/** Per-property display metadata, keyed by property name. */
export interface PropertyMetaDecl {
  /**
   * ⚠️ 📋 DECLARED, NOT YET RESOLVED — the resolver reports these rather than
   *    ignoring them, so a declaration that leans on one fails loudly.
   */
  visibility?: Record<string, Visibility>
  /** `title` — the property that IS this record's name to a person. */
  keys?: Record<string, PropertyKey>
  status?: Record<string, PropertyStatus>
  /** ✅ Which columns survive a narrow table — see `ColumnPriority`. */
  priority?: Record<string, ColumnPriority>
  /** ✅ Whether the store can order by this property — see `Sortable`. */
  sortable?: Record<string, Sortable>
  /**
   * Open extension point — tags a renderer may read, everything else ignores.
   *
   * ⭐ This is where every presentational need goes now: a three-row box, a
   *    column width, an icon. No keyword, no version bump. Promote a tag into
   *    the vocabulary only once three apps have used the same one.
   */
  typeClasses?: Record<string, TypeClasses>
}

/** Ontology declaration, plus the view-layer additions. */
export interface ViewOntologyDecl {
  entities: (EntityTypeDef & PropertyMetaDecl & {
    /**
     * What a property is CALLED on screen, keyed by property name.
     *
     * ⚠️ Not the same thing as `description`. The SDK calls that field "living
     *    documentation — chatbot/AI reads this": it is a sentence explaining what
     *    the property means. A column heading is two or three words. Reusing the
     *    description as a heading gives a table whose columns are sentences, and
     *    it breaks the moment someone improves the documentation.
     */
    labels?: Record<string, string>
    /**
     * What a number MEANS, keyed by property name. Not how it is written.
     *
     * ⚠️ Renamed from `formats` when the formatting vocabulary went back to
     *    `Intl`. The old name invited the old mistake: it read as an instruction
     *    to a renderer, so grouping, notation and digit counts kept trying to
     *    follow it in. `meanings` can only hold what it is for — the ontology
     *    says "this is money", the renderer says how money looks here.
     */
    meanings?: Record<string, ValueMeaning>
    /**
     * WHY a field says what it says, keyed by property name.
     *
     * ⭐ NAMED `notes`, NOT `legalBasis`, AND THE NAME IS THE DECISION.
     *
     *   Measured on the application this came from: **247 hand-written blocks**
     *   carrying the authority behind a value — a decree article, a circular, a
     *   deadline's statutory source. Every one of them lived in a screen, which
     *   means the same authority was retyped on every screen that showed the
     *   same field, and the copies could disagree.
     *
     *   It is not a legal-domain feature. A price carries a tariff, a dose
     *   carries a protocol, a limit carries a policy. Naming it `legalBasis`
     *   would have kept it out of reach of every field that is not law.
     *
     * ⚠️ `ref` is an identifier the APP resolves to a citation. The ontology
     *    says which authority; how it is written and where it links belong to
     *    whoever owns the corpus.
     */
    notes?: Record<string, { text: string; ref?: string }>
    /** Per-property enum wording, keyed by property name. */
    values?: Record<string, EnumValueDecl[]>
    derived?: DerivedDecl[]
  })[]
  relationships: RelationshipTypeDef[]
  /**
   * Named constraint sets (`@dqa-ai-solutions/core-runtime` `resolveValueTypes`). Entity
   * properties arrive already resolved; this is here so a STEP-ONLY field
   * (`fields:` in a process) can point at the same value type by name instead
   * of restating its numbers.
   */
  valueTypes?: ValueTypeDef[]
}

/** One step of a process, as far as the view layer needs to know it. */
export interface TransitionDecl {
  action: string
  label: string
  from: string[]
  to?: string | null
  role: string
  source_ref?: string
  params?: { target?: string; required?: string[]; optional?: string[] }
  /**
   * Type + wording for a parameter that belongs to no entity — a free field
   * that exists only for this step (a reason, a note). Measured on a real app:
   * this is ~4% of parameters. If a step needs many of these, the thing it
   * writes is probably an entity that was never declared.
   */
  fields?: Record<string, {
    /** Required unless `ref` is given. */
    type?: PropertyDef['type']
    /** Optional for a pointer (`ref`): defaults to the target entity's label. */
    label?: string
    /**
     * A pointer, said outright: the entity this parameter names a record of.
     * `many` defaults to whether the name ends in `Ids`. Use it wherever the
     * name alone could mean several entities (`AMBIGUOUS_POINTER`).
     */
    ref?: string
    many?: boolean
    /**
     * The same open tags a property can carry.
     *
     * ⚠️ Missing until the fourth entity was declared: a free field holding a
     *    paragraph ("how was it verified, what did you find") had nowhere to say
     *    so, because `typeClasses` existed only on entities — and a free field
     *    belongs to no entity.
     *
     *    Same shape as the `creates` branch: a second path, written later,
     *    carrying half of what the first one does. Twice in one day.
     */
    typeClasses?: TypeClasses
    /** A value type declared in the ontology — its constraints apply; the field's own keywords narrow them. */
    valueType?: string
    /**
     * `type: enum` — the values, written here. A step-only field has no entity
     * to carry `values:` wording, so each code is its own label unless
     * `valuesOf` is used instead.
     */
    enumValues?: string[]
    /**
     * `type: enum` — `Entity.property`: take the values AND their wording from a
     * property that already declares them, so the list lives in one place.
     *
     * ⛔ An enum that says neither is refused (`ENUM_WITHOUT_VALUES`). A list that
     *    lives in the store is not an enum: declare `type: catalogue`, or a
     *    pointer (`…Id` / `…Ids`).
     */
    valuesOf?: string
  } & ValueConstraints>
  /** `{ entity, via }` — makes a NEW record and links it. */
  creates?: { entity: string; via: string }
  /**
   * The step is a decision — see `@dqa-ai-solutions/workflow-process`.
   *
   * ⚠️ Read here for TWO purposes, and the second arrived later. First: a signer
   *    or citation the declaration already fixed must not come back as a question
   *    on the form. Second: `via` names the gate this step writes its verdict
   *    into, which is the only way to pair a step that GRANTS a go-ahead with the
   *    steps that WAIT on it — see `needsDecision` below. Everything else about a
   *    decision is the workflow engine's business; this package only draws.
   *    `creates` above arrives already expanded from `decision.via`.
   */
  decision?: {
    by?: 'inside' | 'outside'
    via?: string
    outcome?: 'approve' | 'reject'
    reason?: string
    signedBy?: string | string[]
    legalBasis?: string | string[]
  }
  /** Name of a relationship — links to an EXISTING record. */
  links?: string
  /**
   * WHAT THIS STEP WAITS ON. Four declared families, one question.
   *
   * ⭐ CARRIED FOR THE SAME REASON AS `decision.outcome`, AND THE COST OF NOT
   *    CARRYING IT WAS MEASURED THE SAME WAY.
   *
   *   `@dqa-ai-solutions/workflow-process` models all four and the engine enforces them.
   *   This package used to read none of them, so a contract could say a step
   *   exists and never say what it is waiting for. A renderer then had two
   *   options: stay silent, or guess from the step's wording. Both are how a
   *   screen ends up saying nothing while the record sits still.
   *
   *   Measured on the reference app, 7/9/2026: **522 steps, 40 of them gated on
   *   a decision — and 36 of those 40 are opened by a step declaring
   *   `to: null`.** A gate opened by a step that does not move the record
   *   changes nothing a state-shaped screen can show: before and after the
   *   province approves, the record still reads "submitted to superior". The
   *   operator cannot tell whether they are waiting or clear to go.
   *
   * ⚠️ THE SHAPE IS THE ENGINE'S, THE VOCABULARY IS THE DOMAIN'S. `via` names a
   *    relationship or a property the domain declared; `is` is the domain's own
   *    word for a go-ahead. This package neither resolves a gate nor judges one —
   *    resolving needs the domain's store, which it does not have and must not.
   */
  needsDecision?: { via: string; is?: 'approve' | 'reject' }
  /** A property that must already be set. */
  /** One fact or several that must all hold — see `@dqa-ai-solutions/workflow-process` `Transition.requiresFact`. */
  requiresFact?: { property: string; message?: string } | { property: string; message?: string }[]
  /** At least one edge must already hang on this relationship. */
  requiresLink?: { via?: string; relationship?: string; message?: string }
  /** An authority must already have decided, and decided a certain way. */
  requiresApproval?: { relationship: string; decision?: string }
  /**
   * One sentence saying what this step still LACKS a basis for.
   *
   * Measured on the application this was taken from: **five of them, across four
   * process files** — e.g. *"văn bản giao thẩm quyền này cho một cấp đã thôi hoạt động, và chưa có văn bản
   * nào nói cấp nào nhận lại."*
   *
   * ⚠️ WHAT THIS IS NOT: it is not a warning that never reached a screen. It
   *    reached one. The contract used to copy seven keys and not this one, so
   *    the application grafted it back on after every load — a loop over four
   *    YAML files, re-reading what the resolver had just parsed and thrown away.
   *    That graft worked, and a test kept it working.
   *
   * ⭐ So carrying it here buys ONE thing, and it is worth being precise about:
   *    it removes a SECOND SOURCE for a fact that already had a first one. Two
   *    readers of the same YAML is two things to drift.
   *
   *    ⛔ An earlier version of this comment claimed the screens got `undefined`.
   *       That was read out of a test's header describing the bug BEFORE the
   *       graft existed — a past defect mistaken for a present one, which is the
   *       same mistake as citing a code comment about a fixed bug as evidence the
   *       bug is live. Corrected on report from the application.
   */
  provisional?: string
  /**
   * How the step is done — `@dqa-ai-solutions/workflow-process` owns the vocabulary and its check.
   *
   * ⭐ ABSENT IS UNDECLARED, NEVER A DEFAULT. A step without it renders exactly as before; a
   *    pattern selector asked about it says "undetermined" rather than guess.
   */
  task?: TaskDecl
}

export interface ProcessDecl {
  process: string
  entity: string
  stateProperty: string
  roles: Record<string, string>
  states: {
    name: string
    label: string
    /**
     * One clause saying what this state MEANS operationally — "waiting for the
     * province to decide", "the roll has been drawn up".
     *
     * ⚠️ A vocabulary addition, and it passes the two tests. It is MEANING, not
     *    presentation: no browser API can supply it. And it is a fact about the
     *    state, true on every screen that shows it — which is exactly why it
     *    must not live in a UI file. Twenty-three of these were found spread
     *    across four such files, next to duplicated copies of the labels.
     */
    hint?: string
  }[]
  transitions: TransitionDecl[]
  /** Per state, role keys that may SEE a record there without acting on it. Absent = undeclared. */
  readers?: ReadersDecl
}

/** Layout only. Everything else is read from the ontology and the process. */
export interface ViewDecl {
  entity: string
  label?: string
  sub?: string
  /** Business grouping, used by generated navigation. */
  cluster?: string

  list?: {
    /**
     * Property or derived-property names — or a **virtual column**.
     *
     * ⚠️ A virtual column has no backing value at all, and it must name a
     *    component. It exists because some columns are not a value shown in a
     *    cell but a *judgement made in a cell*: two separate approvals rendered
     *    side by side, where the absence of one after a certain step is itself
     *    the finding. There is no property to point at, and inventing one would
     *    be a lie about what the data holds.
     *
     *    The guard is that a virtual column MUST have `widget` — otherwise it is
     *    a column with nothing to draw, which is only ever a mistake.
     */
    /**
     * ⚠️ OPTIONAL. Left out, the columns are every property the ontology marks
     *    `visibility: prominent` — which is where that decision belongs, since
     *    "worth showing" is a fact about the property, not about this screen.
     *    Name them here only to OVERRIDE.
     */
    columns?: (string | { name: string; label: string; widget: string })[]
    /** The identity cell. Left out, the property marked `keys: title`. */
    main?: string
    /** A second line under `main`. */
    sub?: string
    search?: string[]
    sort?: { by: string; dir?: 'asc' | 'desc'; nulls?: 'first' | 'last'; collate?: string }[]
  }

  detail?: {
    facts: string[]
    /**
     * Records that hang off this one — the other half of a record page.
     *
     * ⛔ THE PIECE THAT WAS MISSING, AND IT WAS THE BIGGEST ONE.
     *
     *   A record page is a record PLUS the things attached to it: the decisions
     *   signed on it, the sessions it appeared in, the movements between units.
     *   Measured: **115 hand-built tables across 42% of an application's
     *   screens**, every one of them assembled by hand because the contract had
     *   no word for "the records on the other end of this relationship".
     *
     *   With `facts` alone a record lens covered under 7% of a record page. This
     *   is most of the rest.
     *
     * ⚠️ THE ROWS ARE NOT FETCHED HERE. This package never queries — it says
     *    WHICH collection a screen shows and HOW; the app hands the rows over,
     *    exactly as it does for `uses`. A lens that could query would be a lens
     *    that needs a database, and then it is not a lens.
     */
    related?: {
      /** Key the app supplies the rows under. */
      name: string
      /** Relationship to follow, so the declaration cannot invent a link. */
      via: string
      label: string
      /** Properties of the RELATED entity. Left out: its prominent ones. */
      columns?: string[]
      /** Show only while the record is in one of these states. */
      when?: string[]
    }[]
  }

  /** How one record looks when it turns up in a work queue. */
  row?: { main?: string; sub?: string; badge?: string }

  /**
   * Bespoke blocks, BY NAME ONLY.
   *
   * ⚠️ Named slots, never positions. Patching a shared layout by position
   *    ("insert after the third element") is the single most common way these
   *    systems rot: the shared layout moves and every patch breaks silently,
   *    with no error to catch it.
   *
   * Keys are slot names the renderer publishes (`list.above`, `detail.after`),
   * plus two addressed forms:
   *
   *   `action.<step>`  — a bespoke form for one step
   *   `cell.<field>`   — a bespoke cell for one column
   *
   * ⚠️ `cell.` exists because some columns are not values at all. A deadline
   *    counted in working days, holidays deducted, is a *function* — it cannot
   *    be followed through a link and it has no business being expressed in a
   *    declaration. Naming a component for that one cell keeps the rest of the
   *    table on the shared lens instead of pushing the whole screen out of it.
   *
   * Values are component names the renderer can resolve.
   */
  widgets?: Record<string, string>

  /**
   * Extra data the screen needs that no declaration can produce.
   *
   * ⚠️ This exists because the alternative is worse. Some numbers a screen must
   *    show are neither a property nor a link: the count of claims past their
   *    legal deadline **across the whole territory**, not just the page in view;
   *    a status picture assembled from two entities with an exclusion rule.
   *    Trying to express those in a declaration is how a declaration becomes a
   *    query language, and then a bad programming language.
   *
   *    So: the app computes them and hands them over. The declaration carries
   *    only the NAME, and the loader checks the app registered it — which turns
   *    "the screen silently lost a number" into "the process refuses to start".
   */
  uses?: string[]

  /**
   * App logic that runs AFTER a step succeeds, keyed `after.<step>`.
   *
   * ⚠️ Not a place for business rules. Anything that decides whether a write is
   *    allowed, or what it writes, belongs in the Action — behind the write
   *    gate, where it can be enforced and logged. This is for what happens
   *    *next on the screen*: reload a list, move to the new record, tell the
   *    user. The kernel never calls these; it only checks the name is real.
   */
  hooks?: Record<string, string>
}

// ── What the renderer receives ────────────────────────────────────────────

export interface ResolvedField {
  key: string
  label: string
  /** What this number is — the renderer decides how it reads. */
  meaning?: ValueMeaning
  /** Tags a renderer may act on; the lens itself ignores them. */
  typeClasses?: TypeClasses
  /** Set when this cell is drawn by a named component rather than by the lens. */
  widget?: string
  /**
   * The value the declaration already settled — the form must NOT ask for it.
   *
   * ⭐ Used where a step names the only authority who may sign, or the single
   *    citation that makes its paper valid. Asking the operator to retype a fact
   *    already written down buys nothing and costs a class of typo that only
   *    surfaces later, in somebody else's step.
   */
  fixed?: string
  /**
   * For a parameter that points at another record: which entity it points at.
   *
   * ⚠️ Derived, not declared — read off the existing `<entity>Id` convention the
   *    processes already use. No new vocabulary for whoever writes the
   *    declaration; the resolver simply stops throwing away something it worked
   *    out. Without it a generated form knows a picker is needed but not what to
   *    put in it, which is the same as not knowing anything.
   */
  refEntity?: string
  /** `true` when the parameter takes several ids rather than one. */
  many?: boolean
  kind: PropertyDef['type'] | 'derived'
  /**
   * How hard this column fights to stay when a table runs out of room.
   *
   * A property marked `keys: title` starts at `primary` — the column that NAMES
   * the record cannot be dropped and leave a table of anything.
   *
   * ⚠️ OPTIONAL, and the reason is a mistake worth keeping: made required, it
   *    broke eight call sites — every one of them a STEP PARAMETER, not a
   *    column. A field on a form has no column priority, and forcing one on it
   *    would have been a keyword invented to satisfy a type. Absent means
   *    `normal` to anything drawing a table, and means nothing at all elsewhere.
   */
  priority?: ColumnPriority
  /** True when the store can order by this — see `Sortable`. */
  sortable?: boolean
  required?: boolean
  enum?: EnumValueDecl[]
  /** Set when the field is followed through a link rather than stored. */
  derived?: DerivedDecl
  /** Why this field says what it says — see `notes`. */
  note?: { text: string; ref?: string }
  /**
   * True when the value is a number.
   *
   * ⚠️ Replaces `align: 'num'`, and the rename is the point. Alignment is CSS
   *    and the renderer owns it — but the renderer CANNOT work out that a
   *    derived column is numeric, because `kind` on a derived field is just
   *    `derived`. So the contract states the fact and stops there.
   *
   *    `wrap` and `multiline` were dropped in the same pass with no
   *    replacement: both were widget choices, and `<textarea>`, `white-space`
   *    and `overflow-wrap` have owned those since long before this package.
   *    A renderer that still wants them tags the property (`typeClasses`).
   */
  numeric?: boolean
  /**
   * What a valid value is, as the property declares it — the keywords the write
   * guard enforces (`maxLength`, `minimum`, `multipleOf`, `pattern`…).
   * Absent when the property declares none; the kernel's floor still applies.
   */
  constraints?: ValueConstraints
}

/** A property's value constraints — JSON Schema keywords, as `@dqa-ai-solutions/core-runtime` enforces them. */
export type ValueConstraints = Partial<Pick<PropertyDef,
  | 'minLength' | 'maxLength' | 'pattern'
  | 'minimum' | 'maximum' | 'exclusiveMinimum' | 'exclusiveMaximum' | 'multipleOf'
  | 'minItems' | 'maxItems'
  | 'formatMinimum' | 'formatMaximum'
  | 'accept' | 'maxBytes'>>

/**
 * A condition standing between a step and whoever wants to take it.
 *
 * ⚠️ ONE SHAPE FOR FOUR DECLARED FAMILIES, and the declaration argues for it
 *    first: `needsDecision` in `@dqa-ai-solutions/workflow-process` already folds two
 *    families into one key, *"because the question is the same either way —
 *    has the thing been settled, and settled how."* A renderer asking that
 *    question should not have to ask it four times in four vocabularies.
 *
 * ⛔ `kind` IS NOT DECORATION. It says where the answer is kept, and the answer
 *    is fetched differently for each: a relationship is traversed, a property is
 *    read off the record. Collapsing it would leave the app guessing which.
 */
export interface ResolvedGate {
  /** Where the answer is kept. */
  kind: 'decision' | 'fact' | 'link'
  /** Relationship name for `decision` and `link`; property name for `fact`. */
  via: string
  /** The verdict that opens it, when the declaration names one. */
  is?: string
  /** The sentence the domain wrote for whoever is blocked by it. */
  message?: string
}

export interface ResolvedAction {
  action: string
  label: string
  from: string[]
  to?: string | null
  /**
   * The process line this step belongs to — `ProcessDecl.process`.
   *
   * ⛔ ONE ENTITY CAN RUN SEVERAL LINES, and until this was carried, a contract
   *    merged them into one flat list with nothing saying which was which.
   *
   *   Measured on the reference app, 7/9/2026: `PlanDocument` runs four lines —
   *   commune, province, region, ministry — and its contract came back
   *   as **48 steps and 7 states with no seam in it**. The application had
   *   already built a filter of its own, re-reading the same YAML to rebuild the
   *   step→line map this resolver had just discarded. Before that filter existed,
   *   a commune-level plan offered the operator a province finance officer's
   *   step, and the operator is the one who reported it.
   *
   * ⚠️ A screen drawing a LINE — a progress spine, a route — must filter on this
   *    first. Steps of four lines laid end to end are not a longer process; they
   *    are four processes drawn as one, which is a picture of nothing.
   */
  process: string
  /** Role identifier — the permission decision stays server-side, at the gate. */
  role: string
  source_ref?: string
  /** Form fields, in declared order. */
  fields: ResolvedField[]
  /** Set when this step wants a bespoke form instead of a generated one. */
  widget?: string
  /**
   * Which way a decision step goes.
   *
   * ⭐ CARRIED BECAUSE A RENDERER CANNOT GUESS IT, AND SHOULD NOT TRY.
   *
   *   A screen offering several steps has to know which one is *the* action —
   *   the approval — so exactly one button can carry the weight. The workflow
   *   declares this already (`decision.outcome`); the contract simply threw it
   *   away, leaving renderers to infer it from a button's wording. Inference
   *   from wording is how "Trả về" ends up looking like the primary action.
   *
   *   With this carried, a renderer can be told to REFUSE to guess: no outcome
   *   declared and more than one step advancing means no primary button, which
   *   is an honest answer about a workflow that offers two equal next moves.
   */
  outcome?: 'approve' | 'reject'
  /**
   * The gate this step writes its verdict into — `decision.via`.
   *
   * ⭐ THE OTHER HALF OF `outcome`, AND USELESS WITHOUT IT. `outcome` says which
   *    side of a gate a step is; `settles` says WHICH gate. With both, a
   *    renderer can pair the step that grants a go-ahead with every step waiting
   *    on it, and can therefore name the wait using the granting step's own
   *    declared label — instead of inventing a word for it, which this package
   *    must never do.
   *
   * ⚠️ Absent is an answer, not an omission: the verdict is written on the record
   *    itself rather than on a separate opinion record. See `decision.via`.
   */
  settles?: string
  /**
   * Conditions this step waits on, in declared order.
   *
   * ⚠️ THE LENS MAY NOT RESOLVE THESE, and the boundary is the point. Whether a
   *    gate is actually open is a fact about the domain's store; this package
   *    never queries. The app hands the verdicts over; the contract says which
   *    gates exist and what opens them.
   */
  waitsOn?: ResolvedGate[]
  /** What this step still lacks a basis for — see `TransitionDecl.provisional`. */
  provisional?: string
  /**
   * How the step is done, carried as declared — see `TransitionDecl.task`.
   *
   * ⭐ CARRIED, NOT INTERPRETED. Which screen pattern it implies is the lens's job
   *    (`@dqa-ai-solutions/ui-kit` `presentationOf`); this package only guarantees every name in it points at
   *    something real (`TASK_SHAPE`).
   */
  task?: TaskDecl
}

export interface ViewContract {
  entity: string
  label: string
  sub?: string
  cluster?: string
  stateProperty?: string
  /**
   * Every state this entity can be in, across all its lines.
   *
   * ⛔ USED TO BE THE FIRST LINE'S STATES ONLY, and states that existed on no
   *    other line simply vanished. The application grafted them back on after
   *    every load — a second reader of the same YAML, which is a second thing to
   *    drift. Before that graft, a commune plan sitting in a perfectly legal
   *    state rendered as **"unknown state: CO_SIGNED"** in front of the officer
   *    holding it.
   *
   * ⚠️ A UNION, so ORDER HERE MEANS NOTHING ACROSS LINES. Good for looking a
   *    state up — a badge, a filter. Wrong for drawing a route: use `lines`.
   */
  states?: { name: string; label: string; hint?: string; tone?: EnumValueDecl['tone'] }[]
  /**
   * The entity's lines, each with its own states IN DECLARED ORDER.
   *
   * ⭐ THE ONLY HONEST SOURCE FOR ANYTHING SHAPED LIKE A ROUTE. `states` above
   *    answers "is this a state we know"; this answers "what order do they come
   *    in", and only the second can carry a spine. Most entities have exactly
   *    one entry here and the distinction costs them nothing.
   */
  lines?: {
    process: string
    stateProperty: string
    states: { name: string; label: string; hint?: string; tone?: EnumValueDecl['tone'] }[]
    /**
     * Per state, REAL role codes that may see a record there without acting on it — resolved
     * through `roles` exactly like `ResolvedAction.role`. Absent = the line never said.
     *
     * ⚠️ A statement of intent, not enforcement: who actually sees what is row-level security in
     *    the host's store. A screen may use it to decide what to show a reader; it may not use it
     *    as a permission.
     */
    readers?: Record<string, string[]>
  }[]

  list?: {
    columns: ResolvedField[]
    /**
     * The identity cell, and the second line under it — RESOLVED, like `row`.
     *
     * ⚠️ These were names, not fields, in the first cut. That put the renderer
     *    in the position of looking a name up among `columns` — which fails the
     *    moment `sub` names a field the table does not show as a column of its
     *    own, which is the normal case: a type shown under a name, not beside it.
     *    Resolving both here means one rule, applied once, instead of every
     *    renderer reinventing the lookup and getting the edge case wrong.
     */
    main?: ResolvedField
    sub?: ResolvedField
    search: string[]
    sort: NonNullable<ViewDecl['list']>['sort']
  }
  detail?: {
    facts: ResolvedField[]
    related?: {
      name: string
      via: string
      label: string
      /** The related entity's name — resolved, so a renderer can link out. */
      entity: string
      columns: ResolvedField[]
      when?: string[]
    }[]
  }
  row?: { main: ResolvedField; sub?: ResolvedField; badge?: ResolvedField }
  actions: ResolvedAction[]
  widgets: Record<string, string>
  /** Names of extra data the app must supply — see `uses` above. */
  uses: string[]
  /** App callbacks after a step, keyed `after.<step>` — see `hooks` above. */
  hooks: Record<string, string>
}

// ── Diagnostics ───────────────────────────────────────────────────────────

/**
 * ⚠️ Resolution never throws on a bad declaration and never silently drops a
 *    field. Both are ways for a screen to go quietly wrong: the first stops the
 *    whole app because one column is misspelled, the second ships a screen with
 *    a column missing and nobody notices until a user asks where it went.
 *    Collect everything, then let the caller decide.
 */
export interface Diagnostic {
  severity: 'error' | 'warn'
  code:
    | 'UNKNOWN_ENTITY'
    | 'UNKNOWN_FIELD'
    | 'UNKNOWN_RELATIONSHIP'
    | 'RELATIONSHIP_WRONG_END'
    | 'UNKNOWN_TARGET_PROPERTY'
    | 'ENUM_WITHOUT_LABELS'
    | 'ENUM_VALUE_UNLABELLED'
    | 'ENUM_LABEL_ORPHAN'
    | 'UNTYPED_PARAM'
    /** A `…Id` / `…Ids` parameter whose name fits several entities — declare `fields.<name>.ref`. */
    | 'AMBIGUOUS_POINTER'
    /** A step field `type: enum` that says neither `enumValues` nor `valuesOf` — nothing to check a value against. */
    | 'ENUM_WITHOUT_VALUES'
    | 'UNRENDERABLE_FIELD'
    | 'MISSING_LABEL'
    | 'UNKNOWN_WIDGET'
    | 'POSITIONAL_SLOT'
    | 'TOO_MANY_WIDGETS'
    | 'UNKNOWN_DATA'
    | 'UNKNOWN_HOOK'
    /** Two properties both claim to be the record's name. */
    | 'AMBIGUOUS_TITLE_KEY'
    /** A list with nothing to show: no columns named, none marked prominent. */
    | 'NO_COLUMNS'
    /** A work-queue row with no way to name the record. */
    | 'NO_TITLE_KEY'
    /** A column names a property the ontology marks hidden — allowed, worth saying. */
    | 'HIDDEN_SHOWN'
    /** Một khoá trong khai báo mà khuôn không biết — nhận rồi lờ đi là tệ nhất. */
    | 'UNKNOWN_KEY'
    /**
     * ⚠️ A word that IS in the vocabulary but that the resolver does not read
     *    yet. Reported, never ignored.
     *
     *    The whole point of declaring ahead of implementing is that the gap is
     *    visible. Silently accepting `aggregate: sum` and rendering nothing
     *    would be worse than not having the word at all — the declaration would
     *    look right and the screen would be wrong.
     */
    | 'NOT_YET_RESOLVED'
    /**
     * Two bundles declare a view for the SAME entity.
     *
     * Not a warning, and not last-one-wins: entity names are the app's global
     * keys, so an overwrite hands one team's screen to another team with
     * nothing said. Whichever bundle owns the entity should own the view.
     */
    | 'DUPLICATE_ENTITY'
    /** A length limit written as a view tag (`typeClasses.maxLength`) — only the
     *  browser reads it; the property is where the write guard reads it too. */
    | 'CONSTRAINT_IN_VIEW'
    /** A step field names a value type the ontology does not declare, or one of another type. */
    | 'UNKNOWN_VALUE_TYPE'
    /** A step's `task` or a line's `readers` that a screen could not be built from without guessing. */
    | 'TASK_SHAPE'
    /** A bespoke screen for a step the declaration says nobody does on a screen. */
    | 'SCREEN_FOR_SYSTEM_STEP'
  where: string
  message: string
}

export interface ResolveResult {
  contract: ViewContract
  diagnostics: Diagnostic[]
  /** True when no diagnostic has severity `error`. */
  ok: boolean
}

export interface ResolveOptions {
  /**
   * Slot names the renderer publishes. Given, an unknown slot is an error —
   * which is the point: a typo in a slot name would otherwise mean a bespoke
   * block that simply never appears, with nothing to notice.
   */
  slots?: string[]
  /** Component names the renderer can resolve. */
  components?: string[]
  /**
   * Names of extra data the app can supply. Given, an unknown name in `uses` is
   * an error — the point being that a screen expecting a number the app never
   * computes should stop the process, not render a blank.
   */
  data?: string[]
  /** Names of after-step callbacks the app has registered. */
  hooks?: string[]
  /**
   * Bespoke blocks allowed per entity before it is worth asking whether the
   * shared lens still fits this entity at all. Advisory — reported as `warn`.
   */
  maxWidgets?: number
}
